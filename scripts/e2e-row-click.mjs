// 验证人才库列表「进详情」的三个入口改动：
//   1. 姓名右侧有箭头（把「能点」变可见）
//   2. 整行可点进详情
//   3. 操作列 = 详情 / 编辑 / ⋯（预览·导出·删除收进下拉）
//
// 重点不是「能不能跳」，而是**不该跳的时候会不会误跳**：
// 点编辑、点下拉、拖选文字复制手机号，这三种都不该触发整行跳转。
//
// 前置：npx wrangler dev --port 8787 已启动（跑的是 dist/client 构建产物）
// 用法：node scripts/e2e-row-click.mjs [baseUrl]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] || "http://localhost:8787";
const PHONE = process.env.E2E_PHONE || "13900000099";
const PASSWORD = process.env.E2E_PASSWORD || "E2eTest123456";
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9500 + Math.floor(Math.random() * 200);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
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

/** 回到人才库列表并等表格渲染出来 */
async function gotoList(cdp) {
  await cdp.send("Page.navigate", { url: `${BASE}/talents` });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const n = await evalJs(cdp, `document.querySelectorAll("tr.ant-table-row").length`);
    if (n > 0) { await sleep(600); return n; }
  }
  return 0;
}

(async () => {
  const token = await login();
  const profile = mkdtempSync(join(tmpdir(), "e2e-rowclick-"));
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
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Network.setCookie", { name: "token", value: token, domain: "localhost", path: "/", httpOnly: true });

    const rows = await gotoList(cdp);
    console.log(`目标：${BASE}   表格 ${rows} 行\n`);
    if (rows === 0) throw new Error("列表没数据，无法验证");

    console.log("— 视觉 —");
    const arrows = await evalJs(cdp, `document.querySelectorAll("tr.ant-table-row td .anticon-right").length`);
    check("姓名列每行都有 › 箭头", arrows >= rows, `${arrows} 个 / ${rows} 行`);

    const actionBtns = await evalJs(cdp, `[...document.querySelectorAll("tr.ant-table-row")][0].querySelectorAll("td:last-child button").length`);
    check("操作列 3 个按钮（详情/编辑/⋯）", actionBtns === 3, `实际 ${actionBtns} 个`);

    console.log("\n— 该跳的 —");
    await gotoList(cdp);
    await evalJs(cdp, `document.querySelectorAll("tr.ant-table-row")[0].querySelectorAll("td")[1].click()`);
    await sleep(2500);
    const p1 = await evalJs(cdp, "location.pathname");
    check("点行内空白处 → 进详情", /^\/talents\/[^/]+$/.test(p1 || ""), p1);

    await gotoList(cdp);
    await evalJs(cdp, `[...document.querySelectorAll("tr.ant-table-row")][0].querySelectorAll("td:last-child button")[0].click()`);
    await sleep(2500);
    const p2 = await evalJs(cdp, "location.pathname");
    check("点「详情」→ 进详情", /^\/talents\/[^/]+$/.test(p2 || ""), p2);

    console.log("\n— 不该跳的 —");
    await gotoList(cdp);
    const before = await evalJs(cdp, "location.pathname");
    await evalJs(cdp, `[...document.querySelectorAll("tr.ant-table-row")][0].querySelectorAll("td:last-child button")[1].click()`);
    await sleep(1800);
    const afterEdit = await evalJs(cdp, "location.pathname");
    const editModal = await evalJs(cdp, `!!document.querySelector(".ant-modal-wrap:not([style*='display: none'])")`);
    check("点「编辑」→ 不跳转", afterEdit === before, `${before} → ${afterEdit}`);
    check("点「编辑」→ 弹窗打开", editModal === true);
    await evalJs(cdp, `document.querySelector(".ant-modal-close")?.click()`);
    await sleep(900);

    await gotoList(cdp);
    await evalJs(cdp, `[...document.querySelectorAll("tr.ant-table-row")][0].querySelectorAll("td:last-child button")[2].click()`);
    await sleep(1200);
    const menu = await evalJs(cdp, `[...document.querySelectorAll(".ant-dropdown-menu-item")].map(e=>e.textContent.trim())`);
    check("点「⋯」→ 下拉展开", Array.isArray(menu) && menu.length > 0, JSON.stringify(menu));
    check("下拉含「删除」", Array.isArray(menu) && menu.includes("删除"));
    const pAfterMenu = await evalJs(cdp, "location.pathname");
    check("打开下拉 → 不跳转", pAfterMenu === before, pAfterMenu);

    await gotoList(cdp);
    const beforeSel = await evalJs(cdp, "location.pathname");
    await evalJs(cdp, `(() => {
      const td = document.querySelectorAll("tr.ant-table-row")[0].querySelectorAll("td")[1];
      const sel = window.getSelection(); const range = document.createRange();
      range.selectNodeContents(td); sel.removeAllRanges(); sel.addRange(range);
      td.click();
    })()`);
    await sleep(2000);
    const afterSel = await evalJs(cdp, "location.pathname");
    check("拖选文字后点击 → 不跳转", afterSel === beforeSel, `${beforeSel} → ${afterSel}`);

    // 删除从 Popconfirm 换成 Modal.confirm：必须验证二次确认还在，
    // 否则「点删除 → 直接删掉」是不可接受的回归
    console.log("\n— 删除确认 —");
    await gotoList(cdp);
    await evalJs(cdp, `[...document.querySelectorAll("tr.ant-table-row")][0].querySelectorAll("td:last-child button")[2].click()`);
    await sleep(1000);
    await evalJs(cdp, `[...document.querySelectorAll(".ant-dropdown-menu-item")].find(e=>e.textContent.trim()==="删除")?.click()`);
    await sleep(1200);
    const confirmTitle = await evalJs(cdp, `document.querySelector(".ant-modal-confirm-title")?.textContent || ""`);
    check("点「删除」→ 弹二次确认", /确认删除/.test(confirmTitle), confirmTitle);
    await evalJs(cdp, `[...document.querySelectorAll(".ant-modal-confirm-btns button")].find(b=>(b.textContent||"").trim()==="取消")?.click()`);
    await sleep(1000);
    const left = await evalJs(cdp, `document.querySelectorAll("tr.ant-table-row").length`);
    check("取消后数据未删", left === rows, `${left} 行 / 原 ${rows} 行`);

    console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项未通过`);
  } finally {
    chrome.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    process.exit(failures === 0 ? 0 : 1);
  }
})().catch((e) => {
  console.error("脚本异常：", e.message);
  process.exit(1);
});
