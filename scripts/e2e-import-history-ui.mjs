// UI 层验证：导入记录真的能在人才库页打开，并看到逐份明细。
//
// 接口级验证（e2e-import-history.mjs）已证明计数与状态流转是对的，这个脚本只补一件事：
// 用户真的能在界面上找到入口、看到「上传/录入/失败」这几个数、展开看到哪份文件失败了。
//
// 前置：npx wrangler dev --port 8787 已启动；建议先跑一次 e2e-import-history.mjs 造点数据。
// 用法：node scripts/e2e-import-history-ui.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] || "http://localhost:8787";
const PHONE = process.env.E2E_PHONE || "13900000099";
const PASSWORD = process.env.E2E_PASSWORD || "E2eTest123456";
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9400 + Math.floor(Math.random() * 200);

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
}

async function login() {
  const cap = await (await fetch(`${BASE}/api/auth/captcha`)).json();
  const code = [...cap.svg.matchAll(/>([^<])<\/text>/g)].map((m) => m[1]).join("");
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};

const evalJs = async (cdp, expression) => {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.value;
};

(async () => {
  console.log(`目标：${BASE}\n`);
  const token = await login();

  // 先确认库里有批次，否则后面的断言没有意义（跑之前先执行 e2e-import-history.mjs）
  const pre = await (await fetch(`${BASE}/api/import-batches?limit=5`, {
    headers: { Cookie: `token=${token}` },
  })).json();
  check("接口里已有导入批次可用于展示", (pre.items || []).length > 0, `${(pre.items || []).length} 个`);

  const profile = mkdtempSync(join(tmpdir(), "e2e-import-history-ui-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--window-size=1600,1100",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  try {
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
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send("Network.setCookie", {
      name: "token", value: token, domain: "localhost", path: "/", httpOnly: true,
    });

    await cdp.send("Page.navigate", { url: `${BASE}/talents` });
    await sleep(7000);

    // ── 一、入口按钮 ──────────────────────────────
    console.log("— 入口 —");
    const hasEntry = await evalJs(
      cdp,
      `[...document.querySelectorAll("button")].some((b) => /导入记录/.test(b.textContent || ""))`
    );
    check("人才库页有「导入记录」按钮", hasEntry === true, hasEntry ? "" : "没找到按钮");
    // 「导入」按钮必须还在（别被新按钮挤掉或改名）
    check("「导入」按钮仍在",
      await evalJs(cdp, `[...document.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === "导入")`) === true);

    const opened = await evalJs(
      cdp,
      `(() => {
        const b = [...document.querySelectorAll("button")].find((x) => /导入记录/.test(x.textContent || ""));
        if (!b) return false;
        b.click();
        return true;
      })()`
    );
    check("点击后打开弹窗", opened === true);
    await sleep(2500);

    // ── 二、弹窗内容 ──────────────────────────────
    console.log("\n— 弹窗 —");
    const modalInfo = await evalJs(
      cdp,
      `(() => {
        const m = [...document.querySelectorAll(".ant-modal")].find((el) =>
          /导入记录/.test(el.querySelector(".ant-modal-title")?.textContent || ""));
        if (!m) return JSON.stringify({ found: false });
        const heads = [...m.querySelectorAll(".ant-table-thead th")].map((th) => th.textContent.trim());
        const rows = m.querySelectorAll(".ant-table-tbody tr.ant-table-row").length;
        const text = m.textContent.replace(/\\s+/g, " ");
        return JSON.stringify({ found: true, heads, rows, hasSummary: /上传/.test(text) && /录入/.test(text) });
      })()`
    );
    const m = JSON.parse(modalInfo || "{}");
    check("弹窗已渲染", m.found === true);
    check("表格有「上传 / 录入 / 失败」三列",
      ["上传", "录入", "失败"].every((h) => (m.heads || []).includes(h)),
      (m.heads || []).join(" / "));
    check("表格有「未处理」列（区分放弃与失败）", (m.heads || []).includes("未处理"), "");
    check("有批次数据行", m.rows > 0, `${m.rows} 行`);
    check("顶部有汇总（上传/录入 份数）", m.hasSummary === true, "");

    // ── 三、展开看逐份明细 ──────────────────────────
    console.log("\n— 逐份明细 —");
    const expanded = await evalJs(
      cdp,
      `(() => {
        const m = [...document.querySelectorAll(".ant-modal")].find((el) =>
          /导入记录/.test(el.querySelector(".ant-modal-title")?.textContent || ""));
        if (!m) return false;
        const btn = m.querySelector(".ant-table-tbody .ant-table-row-expand-icon");
        if (!btn) return false;
        btn.click();
        return true;
      })()`
    );
    check("能展开某个批次", expanded === true, expanded ? "" : "没找到展开图标");
    await sleep(2000);

    const detailInfo = await evalJs(
      cdp,
      `(() => {
        const m = [...document.querySelectorAll(".ant-modal")].find((el) =>
          /导入记录/.test(el.querySelector(".ant-modal-title")?.textContent || ""));
        if (!m) return JSON.stringify({ found: false });
        const expandedRow = m.querySelector(".ant-table-expanded-row");
        if (!expandedRow) return JSON.stringify({ found: false });
        const text = expandedRow.textContent.replace(/\\s+/g, " ");
        return JSON.stringify({
          found: true,
          hasFileName: /\\.(pdf|docx)/i.test(text),
          hasStatusTag: ["已录入", "重复跳过", "失败", "未处理"].some((s) => text.includes(s)),
          hasErrorText: /损坏|解析失败/.test(text),
          text: text.slice(0, 220),
        });
      })()`
    );
    const d = JSON.parse(detailInfo || "{}");
    check("展开后出现逐份明细", d.found === true);
    check("明细里能看到文件名", d.hasFileName === true, "");
    check("明细里有状态标签", d.hasStatusTag === true, "");
    check("失败原因对用户可见", d.hasErrorText === true, (d.text || "").slice(0, 100));

    await cdp.send("Page.captureScreenshot", { format: "png" }).then((s) => {
      writeFileSync("dist/import-history.png", Buffer.from(s.data, "base64"));
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
