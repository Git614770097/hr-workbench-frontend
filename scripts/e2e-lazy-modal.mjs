// 验证 Layout 里 7 个弹窗从 React.lazy 换成 lazyModal 后没坏。
//
// 用真实本地后端（wrangler dev）：脚本自己过验证码登录，把 token 注入 Chrome 的
// cookie jar，再打开 /tasks。这样 Layout、权限、菜单全是真链路，不依赖 mock。
//
// 前置：
//   1. npx wrangler dev --port 8787 已启动
//   2. 本地 D1 里 13900000099 的密码是 E2eTest123456
//      （scripts/e2e-lazy-modal.mjs 的注释里有重置用的 SQL）
//
// 断言：
//   1. Layout 渲染出来（主内容区在、没进 ErrorBoundary）；
//   2. 派发 open-ai-key 事件能打开 AiKeyModal（chunk 正常加载）；
//   3. 关掉再开走模块缓存，无需重新下载；
//   4. 全程无未捕获异常。
//
// 用法：node scripts/e2e-lazy-modal.mjs [baseUrl]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] || "http://localhost:8787";
const PHONE = process.env.E2E_PHONE || "13900000099";
const PASSWORD = process.env.E2E_PASSWORD || "E2eTest123456";
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9600 + Math.floor(Math.random() * 200);

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

async function login() {
  const cap = await (await fetch(`${BASE}/api/auth/captcha`)).json();
  const code = [...cap.svg.matchAll(/>([^<])<\/text>/g)].map((m) => m[1]).join("");
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: PHONE, password: PASSWORD, captcha_id: cap.captcha_id, captcha: code }),
  });
  if (!res.ok) throw new Error(`登录失败 ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const raw = res.headers.get("set-cookie") || "";
  const token = /token=([^;]+)/.exec(raw)?.[1];
  if (!token) throw new Error("登录成功但没拿到 cookie");
  return token;
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

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};

const evalJs = async (cdp, expression) => {
  const r = await cdp
    .send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
    .catch(() => null);
  return r?.result?.value;
};

const profile = mkdtempSync(join(tmpdir(), "lazy-modal-"));
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

try {
  const token = await login();
  console.log("已登录，token 长度", token.length);

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

  const errors = [];
  cdp.on("Runtime.exceptionThrown", (p) => {
    errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "?");
  });

  await cdp.send("Network.setCookie", {
    name: "token",
    value: token,
    url: BASE,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  });
  // auth_hint 只是「要不要去拉会话」的提示位，不是凭据
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: 'try { localStorage.setItem("auth_hint", "1"); } catch {}',
  });

  await cdp.send("Page.navigate", { url: `${BASE}/tasks` });
  await sleep(6000);

  const shell = await evalJs(cdp, "document.body.innerText.replace(/\\s+/g,' ').slice(0,400)");
  const shellOk = await evalJs(
    cdp,
    '!!document.querySelector(".main-content") && !document.querySelector(".error-boundary-fallback")'
  );
  console.log("\n— 页面文本 —\n", (shell || "(空)").slice(0, 240));

  check("Layout 渲染出来了（主内容区在、没进错误卡）", !!shellOk, shellOk ? "" : (shell || "").slice(0, 100));

  // 打开 AiKeyModal（Layout 监听 open-ai-key 事件，不需要点菜单）
  await evalJs(cdp, 'window.dispatchEvent(new Event("open-ai-key"))');
  await sleep(2500);
  const m1 = JSON.parse(
    (await evalJs(
      cdp,
      'JSON.stringify({ modal: !!document.querySelector(".ant-modal"), title: (document.querySelector(".ant-modal-title")||{}).textContent || "" })'
    )) || "{}"
  );
  check("派发 open-ai-key 能打开弹窗", !!m1.modal, m1.modal ? `标题：${m1.title}` : "");

  // 关掉再开：应命中模块缓存，立即出现
  await evalJs(cdp, 'document.querySelector(".ant-modal-close")?.click()');
  await sleep(600);
  const closed = await evalJs(cdp, '!document.querySelector(".ant-modal")');
  await evalJs(cdp, 'window.dispatchEvent(new Event("open-ai-key"))');
  await sleep(400);
  const reopened = await evalJs(cdp, '!!document.querySelector(".ant-modal")');
  check("关掉后能再次打开（模块缓存命中）", !!closed && !!reopened, closed ? "" : "首次没关掉");

  const stillAlive = await evalJs(cdp, "!!document.querySelector('.main-content')");
  check("弹窗操作后主内容区仍在（没被 ErrorBoundary 吞掉）", !!stillAlive);

  check("全程无未捕获异常", errors.length === 0, errors.length ? errors[0].slice(0, 100) : "");

  // ── 失败路径：弹窗 chunk 404 时只能提示 + 关弹窗，绝不能把整页吞掉 ──
  // （这正是换掉 React.lazy 的理由：它的 reject 会抛给顶层 ErrorBoundary）
  await evalJs(cdp, 'document.querySelector(".ant-modal-close")?.click()');
  await sleep(500);
  // 预置时间戳让 tryAutoReload 直接放弃，跳过自动刷新，直达兜底分支
  await evalJs(cdp, 'sessionStorage.setItem("chunk_autoreload_at", String(Date.now()))');
  await cdp.send("Fetch.enable", {
    patterns: [{ urlPattern: "*AiKeyModal*.js*", requestStage: "Request" }],
  });
  cdp.on("Fetch.requestPaused", async (p) => {
    try {
      await cdp.send("Fetch.fulfillRequest", {
        requestId: p.requestId,
        responseCode: 404,
        responsePhrase: "Not Found",
        responseHeaders: [{ name: "Content-Type", value: "text/plain" }],
        body: Buffer.from("gone").toString("base64"),
      });
    } catch {}
  });

  // 刷新清掉 JS 模块缓存，让 AiKeyModal 必须重新下载。
  // ⚠️ 必须同时禁掉 HTTP 缓存：/assets/* 是 immutable 一年，Chrome 会直接吃磁盘缓存，
  //    请求压根不出网，Fetch 域也就拦不到它。
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(6000);
  const shellAfterReload = await evalJs(cdp, '!!document.querySelector(".main-content")');
  await evalJs(cdp, 'window.dispatchEvent(new Event("open-ai-key"))');
  await sleep(2500);

  const failState = JSON.parse(
    (await evalJs(
      cdp,
      'JSON.stringify({ modal: !!document.querySelector(".ant-modal"), toast: (document.querySelector(".ant-message")||{}).innerText || "", boundary: !!document.querySelector(".error-boundary-fallback"), main: !!document.querySelector(".main-content") })'
    )) || "{}"
  );
  console.log("\n— 失败路径现场 —", JSON.stringify(failState).slice(0, 200));

  check("刷新后页面仍正常", !!shellAfterReload);
  check("弹窗 chunk 404 不会整页进 ErrorBoundary", !failState.boundary);
  check("主内容区还在", !!failState.main);
  check("弹窗没打开（已关闭）", !failState.modal);
  check("给了用户提示", /打不开|刷新/.test(failState.toast || ""), (failState.toast || "").slice(0, 40));

  const shot2 = await cdp.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
  if (shot2) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync("dist/lazy-modal-fail-shot.png", Buffer.from(shot2.data, "base64"));
  }

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
  if (shot) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync("dist/lazy-modal-shot.png", Buffer.from(shot.data, "base64"));
  }

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
