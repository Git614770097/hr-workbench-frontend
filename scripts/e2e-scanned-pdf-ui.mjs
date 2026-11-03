// 图片型 PDF 的界面兜底验证：报错不再刷屏 + 失败的文件可以转手工录入。
//
// 这批 27 份全是图片型 PDF（无文字层），原实现的表现是：
//   1. 27 条一模一样的文案拼成一堵墙，用户读不完也不知道怎么办；
//   2. 全失败时一条记录都不生成，可文案却写着「或手动填写信息」——无路可走。
// 这个脚本验证这两点都修好了。
//
// 前置：npx wrangler dev --port 8787 已启动。
// 用法：node scripts/e2e-scanned-pdf-ui.mjs "简历目录"
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] || "http://localhost:8787";
const RESUME_DIR = process.argv[3];
const PHONE = process.env.E2E_PHONE || "13900000099";
const PASSWORD = process.env.E2E_PASSWORD || "E2eTest123456";
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9400 + Math.floor(Math.random() * 200);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
      } else if (msg.method) for (const fn of this.handlers.get(msg.method) || []) fn(msg.params);
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
}

async function login() {
  const cap = await (await fetch(`${BASE}/api/auth/captcha`)).json();
  const code = [...cap.svg.matchAll(/>([^<])<\/text>/g)].map((m) => m[1]).join("");
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: PHONE, password: PASSWORD, captcha_id: cap.captcha_id, captcha: code }),
  });
  if (!res.ok) throw new Error(`登录失败 ${res.status}`);
  const token = /token=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
  if (!token) throw new Error("没拿到 cookie");
  return token;
}

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("Chrome DevTools 没起来");
}

const evalJs = async (cdp, expression) => {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.value;
};

async function uploadFiles(cdp, paths) {
  const doc = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: 'input[type="file"]' });
  if (!nodeId) throw new Error("没找到文件输入框");
  await cdp.send("DOM.setFileInputFiles", { files: paths, nodeId });
}

(async () => {
  if (!RESUME_DIR) {
    console.log("用法：node scripts/e2e-scanned-pdf-ui.mjs http://localhost:8787 \"简历目录\"");
    process.exit(1);
  }
  const pdfs = readdirSync(RESUME_DIR).filter((f) => f.toLowerCase().endsWith(".pdf")).sort().slice(0, 3)
    .map((f) => join(RESUME_DIR, f));
  console.log(`目标：${BASE}\n取前 ${pdfs.length} 份做验证\n`);
  const token = await login();

  const profile = mkdtempSync(join(tmpdir(), "e2e-scanned-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--window-size=1600,1100", `--user-data-dir=${profile}`,
    `--remote-debugging-port=${DEBUG_PORT}`, "about:blank",
  ], { stdio: "ignore" });

  try {
    const ws = new WebSocket(await waitForDevtools());
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
    });
    const cdp = new CDP(ws);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Network.setCookie", { name: "token", value: token, domain: "localhost", path: "/", httpOnly: true });

    await cdp.send("Page.navigate", { url: `${BASE}/talents` });
    await sleep(7000);
    await evalJs(cdp, `[...document.querySelectorAll("button")].find((b) => (b.textContent||"").trim() === "导入")?.click()`);
    await sleep(1500);

    console.log("— 上传图片型 PDF —");
    await uploadFiles(cdp, pdfs);
    // 没有 ZHIPU_API_KEY 时服务端很快返回；有 key 时要等识别，给足时间
    await sleep(25000);

    const alertInfo = await evalJs(
      cdp,
      `(() => {
        const a = [...document.querySelectorAll(".ant-alert")].find((el) => /没能自动解析/.test(el.textContent || ""));
        if (!a) return JSON.stringify({ found: false, allAlerts: [...document.querySelectorAll(".ant-alert")].map(e => (e.textContent||"").slice(0,60)) });
        const text = a.textContent.replace(/\\s+/g, " ").trim();
        const btn = [...a.querySelectorAll("button")].map((b) => b.textContent.trim());
        return JSON.stringify({ found: true, len: text.length, text: text.slice(0, 300), btn });
      })()`
    );
    const a = JSON.parse(alertInfo || "{}");
    check("出现按原因归并的失败提示", a.found === true, a.found ? "" : JSON.stringify(a.allAlerts));
    // 关键回归：原来是每份一段完整文案拼接，3 份就有几百字；归并后应该很短
    check("提示文案不再是一堵墙（< 400 字）", a.len < 400, `${a.len} 字`);
    check("提示里说明了份数与原因", /份没能自动解析/.test(a.text || ""), (a.text || "").slice(0, 120));
    check("提供「仍然手动录入」出口", (a.btn || []).some((t) => /手动录入/.test(t)), JSON.stringify(a.btn));

    await cdp.send("Page.captureScreenshot", { format: "png" }).then((s) => {
      writeFileSync("dist/scanned-pdf-error.png", Buffer.from(s.data, "base64"));
    });

    console.log("\n— 转手工录入 —");
    await evalJs(
      cdp,
      `(() => {
        const a = [...document.querySelectorAll(".ant-alert")].find((el) => /没能自动解析/.test(el.textContent || ""));
        const b = a && [...a.querySelectorAll("button")].find((x) => /手动录入/.test(x.textContent || ""));
        if (b) { b.click(); return true; }
        return false;
      })()`
    );
    await sleep(2500);

    const reviewInfo = await evalJs(
      cdp,
      `(() => {
        const m = [...document.querySelectorAll(".ant-modal")].find((el) => /核对|确认/.test(el.querySelector(".ant-modal-title")?.textContent || ""));
        if (!m) return JSON.stringify({ found: false, titles: [...document.querySelectorAll(".ant-modal-title")].map(e=>e.textContent) });
        const text = m.textContent.replace(/\\s+/g, " ");
        return JSON.stringify({
          found: true,
          hasManualHint: /没能自动解析，需要你对照左侧原文件填写/.test(text),
          hasIframe: !!m.querySelector("iframe"),
          hasSaveBtn: [...m.querySelectorAll("button")].some((b) => /保存并录入/.test(b.textContent || "")),
        });
      })()`
    );
    const r = JSON.parse(reviewInfo || "{}");
    check("弹出核对窗口", r.found === true, r.found ? "" : JSON.stringify(r.titles));
    check("窗口里说明了「需要对照原文件填写」", r.hasManualHint === true);
    check("左侧能打开原 PDF（iframe）", r.hasIframe === true);
    check("可以保存录入", r.hasSaveBtn === true);

    await cdp.send("Page.captureScreenshot", { format: "png" }).then((s) => {
      writeFileSync("dist/scanned-pdf-manual.png", Buffer.from(s.data, "base64"));
    });

    ws.close();
  } finally {
    chrome.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("脚本异常：", e.message);
  process.exit(1);
});
