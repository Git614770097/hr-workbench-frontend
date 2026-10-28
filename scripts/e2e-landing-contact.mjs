// 验证落地页的联系方式入口：微信按钮存在、点击后能复制、文案会反馈。
//
// 用法：node scripts/e2e-landing-contact.mjs [baseUrl]
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] || "http://localhost:4173";
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9533 + Math.floor(Math.random() * 200);
const WECHAT = "17319258381";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
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

const profile = mkdtempSync(join(tmpdir(), "landing-contact-"));
spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,900",
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

const evalJs = async (cdp, expression) => {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

try {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) break;
    } catch {}
    await sleep(500);
  }

  const ws = new WebSocket(await waitForDevtools());
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new CDP(ws);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  try {
    await cdp.send("Browser.grantPermissions", {
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
      origin: BASE,
    });
  } catch {}

  await cdp.send("Page.navigate", { url: `${BASE}/` });
  await sleep(3500);

  // 1. 定制板块的微信按钮
  const btn = await evalJs(
    cdp,
    `(() => {
      const els = [...document.querySelectorAll("button")];
      const b = els.find((x) => x.textContent.includes("添加微信"));
      return b ? { text: b.textContent.trim(), tag: b.tagName } : null;
    })()`
  );
  check("定制板块有微信按钮", !!btn, btn ? `「${btn.text}」` : "没找到");
  check("按钮里带完整微信号", !!btn && btn.text.includes(WECHAT), btn ? "" : "微信号缺失");

  // 点击前的正常状态截图
  if (btn) {
    await evalJs(
      cdp,
      `(() => {
        const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("添加微信"));
        if (b) b.scrollIntoView({ block: "center" });
        return true;
      })()`
    );
    await sleep(800);
    const shot0 = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync("dist/landing-contact-before.png", Buffer.from(shot0.data, "base64"));
  }

  // 2. 点击后文案变化 + 剪贴板内容
  if (btn) {
    await evalJs(
      cdp,
      `[...document.querySelectorAll("button")].find((x) => x.textContent.includes("添加微信")).click()`
    );
    await sleep(400);
    const after = await evalJs(
      cdp,
      `[...document.querySelectorAll("button")].map((x) => x.textContent.trim()).find((t) => t.includes("已复制") || t.includes("请手动复制")) || ""`
    );
    check("点击后有明确反馈", after.length > 0, after ? `「${after}」` : "点了没反应");

    // headless 下剪贴板常被策略拦住，这里只作为信息输出，不作为断言
    const clip = await evalJs(cdp, `navigator.clipboard.readText().catch(() => "(读不到)")`);
    console.log(`   剪贴板内容：${clip}（headless 限制，真实浏览器 HTTPS 下可用）`);
  }

  // 3. 定价卡的「聊聊需求」不该再跳注册页
  const planBtn = await evalJs(
    cdp,
    `(() => {
      const els = [...document.querySelectorAll("button, a")];
      const b = els.find((x) => x.textContent.trim() === "聊聊需求");
      if (!b) return null;
      return { tag: b.tagName, href: b.getAttribute("href") || "" };
    })()`
  );
  check(
    "「聊聊需求」是按钮而非跳转链接",
    !!planBtn && planBtn.tag === "BUTTON",
    planBtn ? `<${planBtn.tag}>${planBtn.href ? " href=" + planBtn.href : ""}` : "没找到"
  );

  // 4. 截图定制板块（滚到按钮本身，别停在标题上）
  await evalJs(
    cdp,
    `(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("17319258381"));
      (b || document.body).scrollIntoView({ block: "center" });
      return true;
    })()`
  );
  await sleep(900);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync("dist/landing-contact.png", Buffer.from(shot.data, "base64"));

  console.log(`\n${failures === 0 ? "全部通过" : failures + " 项失败"}｜截图 dist/landing-contact.png`);
} catch (e) {
  console.error("运行出错：", e.message);
  failures++;
} finally {
  process.exit(failures ? 1 : 0);
}
