// 验证「懒加载 chunk 404 → 自动刷新一次 → 再失败给兜底 UI」这条链路。
//
// 手法：用 CDP 的 Fetch 域把 Login-*.js 的请求拦下来改成 404，再打开 /login。
// 不需要登录态——/login 本身就是 lazyPage 包出来的页面。
//
// 断言：
//   1. 第一次 404 → 页面自动 reload（load 事件出现第 2 次）；
//   2. reload 后仍 404 → 不再 reload（防刷新死循环），显示「页面已更新」兜底卡；
//   3. sessionStorage 留下 chunk_autoreload_at；
//   4. 每次失败都向 /api/logs/client-error 发了上报。
//
// 用法：node scripts/e2e-chunk-reload.mjs [baseUrl]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] || "http://localhost:4173";
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9333 + Math.floor(Math.random() * 200);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.handlers.get(msg.method) || []) fn(msg.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  async close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("Chrome DevTools 没起来");
}

const profile = mkdtempSync(join(tmpdir(), "chunk-reload-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    "about:blank",
  ],
  { stdio: "ignore" }
);

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};

try {
  // 等服务就绪：vite preview 冷启动要几秒，太早导航会拿到 chrome-error 页
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) break;
    } catch {}
    await sleep(500);
  }

  const wsUrl = await waitForDevtools();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new CDP(ws);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");

  const loads = [];
  const reports = [];
  const blocked = [];
  const navs = [];
  const logs = [];
  let blockCount = 0;
  let reloadedByApp = false;

  cdp.on("Page.loadEventFired", () => loads.push(Date.now()));
  cdp.on("Page.frameNavigated", (p) => {
    if (!p.frame.parentId) navs.push(p.frame.url);
  });
  cdp.on("Runtime.consoleAPICalled", (p) => {
    logs.push(`${p.type}: ${(p.args || []).map((a) => a.value ?? a.description ?? "").join(" ")}`);
  });
  cdp.on("Runtime.exceptionThrown", (p) => {
    logs.push(`exception: ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`);
  });
  cdp.on("Network.requestWillBeSent", (p) => {
    if (p.request?.url?.includes("/api/logs/client-error")) {
      reports.push(p.request.postData || "");
    }
  });

  // 拦 Login chunk，前 3 次返回 404（模拟发版后旧文件被删）
  await cdp.send("Fetch.enable", {
    patterns: [{ urlPattern: "*Login-*.js*", requestStage: "Request" }],
  });
  cdp.on("Fetch.requestPaused", async (p) => {
    blockCount++;
    blocked.push(p.request.url);
    try {
      await cdp.send("Fetch.fulfillRequest", {
        requestId: p.requestId,
        responseCode: 404,
        responsePhrase: "Not Found",
        responseHeaders: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
        body: Buffer.from("gone").toString("base64"),
      });
    } catch {
      /* 请求可能已被取消 */
    }
  });

  await cdp.send("Page.navigate", { url: `${BASE}/login` });

  // 给「404 → reload → 再 404 → 放弃」留足时间
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    const state = await cdp
      .send("Runtime.evaluate", {
        expression:
          'JSON.stringify({ ts: sessionStorage.getItem("chunk_autoreload_at"), body: document.body.innerText.slice(0, 400) })',
        returnByValue: true,
      })
      .catch(() => null);
    if (state?.result?.value) {
      const s = JSON.parse(state.result.value);
      if (s.ts && loads.length >= 2) {
        reloadedByApp = true;
        break;
      }
    }
  }
  // 再多等一会儿，确认它不会继续刷
  await sleep(4000);

  // 页面可能正处在自动刷新中（导航会销毁执行上下文），读不到就重试几次
  let state = { ts: null, text: "", html: "(未读到)", url: "" };
  for (let i = 0; i < 12; i++) {
    const r = await cdp
      .send("Runtime.evaluate", {
        expression:
          'JSON.stringify({ ts: sessionStorage.getItem("chunk_autoreload_at"), text: document.body.innerText.replace(/\\s+/g," ").slice(0,300), html: (document.getElementById("root")||{}).innerHTML ? document.getElementById("root").innerHTML.slice(0,400) : "(无 #root 内容)", url: location.href })',
        returnByValue: true,
      })
      .catch(() => null);
    if (r?.result?.value) {
      try {
        state = JSON.parse(r.result.value);
        break;
      } catch {}
    }
    await sleep(400);
  }

  let shotData = null;
  try {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    shotData = shot.data;
  } catch {}
  if (shotData) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync("dist/chunk-reload-shot.png", Buffer.from(shotData, "base64"));
  }

  console.log("\n— 现场 —");
  console.log("导航序列:", navs.join("  →  ") || "(无)");
  console.log("拦截到的 chunk 请求次数:", blockCount, blocked.map((u) => u.split("/").pop()).join(", "));
  console.log("页面 load 次数:", loads.length);
  console.log("上报请求次数:", reports.length);
  console.log("chunk_autoreload_at:", state.ts);
  console.log("当前 URL:", state.url);
  console.log("页面文本:", state.text.slice(0, 160) || "(空)");
  console.log("#root 内容:", state.html);
  console.log("上报内容:");
  for (const r of reports) {
    try {
      const j = JSON.parse(r);
      console.log("   •", j.message);
    } catch {
      console.log("   •", String(r).slice(0, 160));
    }
  }
  console.log("console:", logs.slice(-12).join("\n  ") || "(无)");

  console.log("\n— 断言 —");
  check("chunk 请求确实被拦成 404", blockCount > 0, `(${blockCount} 次)`);
  check("第一次 404 触发了自动刷新", reloadedByApp && loads.length >= 2, `(load ×${loads.length})`);
  check("刷新后没有再刷（防死循环）", loads.length <= 2, `(load ×${loads.length})`);
  check("sessionStorage 记下了刷新时间戳", !!state.ts);
  check("失败已上报", reports.length > 0, `(${reports.length} 条)`);
  check(
    "识别为 chunk 错误并展示「页面已更新」",
    /页面已更新/.test(state.text),
    state.text.includes("页面已更新") ? "" : `实际文案：${state.text.slice(0, 40)}`
  );
  check(
    "上报里带上了页面名",
    reports.some((r) => r.includes("懒加载失败 /login")),
    ""
  );

  // ── 对照组：撤掉拦截，确认正常路径没被这次改造弄坏 ──
  await cdp.send("Fetch.disable");
  await cdp.send("Runtime.evaluate", { expression: "sessionStorage.clear()" });
  await cdp.send("Page.navigate", { url: `${BASE}/login` });
  await sleep(4000);
  const normal = await cdp
    .send("Runtime.evaluate", {
      expression: "document.body.innerText.replace(/\\s+/g,' ').slice(0,200)",
      returnByValue: true,
    })
    .catch(() => null);
  const normalText = normal?.result?.value || "";
  check(
    "对照组：不拦截时登录页正常渲染",
    /登录|手机号|密码|账号/.test(normalText),
    normalText.slice(0, 60)
  );

  await cdp.close();
} catch (e) {
  console.error("❌ 脚本异常:", e.message);
  failures++;
} finally {
  chrome.kill();
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
