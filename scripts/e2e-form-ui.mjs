// 验证「新增/编辑人才」弹窗的三处改动 + 详情页空值占位：
//   1. 弹窗宽度加到 1080
//   2. 技能输入框改成 4 行多行框
//   3. 出生年月改成「年 + 月」两个下拉（选 1994 年不再要点 30 次）
//   4. 详情页「基本信息」空值显示 "-"
//
// 前置：npx wrangler dev --port 8787 已启动
// 用法：node scripts/e2e-form-ui.mjs [baseUrl]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] || "http://localhost:8787";
const PHONE = process.env.E2E_PHONE || "13900000099";
const PASSWORD = process.env.E2E_PASSWORD || "E2eTest123456";
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9700 + Math.floor(Math.random() * 200);

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
  if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
  return r.result?.value;
};

/** 轮询等待某个表达式为真——本地 wrangler dev 首次编译慢，固定 sleep 不可靠 */
const waitFor = async (cdp, expression, label, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    if (await evalJs(cdp, expression)) return true;
    await sleep(500);
  }
  console.log(`  ⏱ 等不到：${label}`);
  return false;
};

(async () => {
  const token = await login();
  const profile = mkdtempSync(join(tmpdir(), "e2e-form-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--window-size=1680,1100", `--user-data-dir=${profile}`,
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
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1680, height: 1100, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Network.setCookie", { name: "token", value: token, domain: "localhost", path: "/", httpOnly: true });

    console.log("— 打开新增人才弹窗 —");
    await cdp.send("Page.navigate", { url: `${BASE}/talents` });
    const ready = await waitFor(cdp, `[...document.querySelectorAll("button")].some(b=>(b.textContent||"").includes("新增人才"))`, "新增人才按钮");
    check("人才库列表已渲染", ready);
    await evalJs(cdp, `[...document.querySelectorAll("button")].find(b=>(b.textContent||"").includes("新增人才"))?.click()`);
    const opened = await waitFor(cdp, `document.querySelectorAll(".ant-modal").length > 0`, "弹窗");
    check("弹窗已打开", opened);
    await sleep(800);

    const modalW = await evalJs(cdp, `document.querySelector(".ant-modal")?.offsetWidth || 0`);
    check("弹窗宽度 = 1080", modalW === 1080, `实际 ${modalW}px`);

    const skillArea = await evalJs(cdp, `(() => {
      const ta = document.querySelector(".ant-modal textarea");
      if (!ta) return null;
      return { rows: ta.getAttribute("rows"), h: ta.offsetHeight };
    })()`);
    check("技能框是多行 textarea", !!skillArea, skillArea ? `rows=${skillArea.rows} 高 ${skillArea.h}px` : "没找到 textarea");
    check("技能框 4 行", skillArea?.rows === "4");

    const twoSelects = await evalJs(cdp, `(() => {
      const items = [...document.querySelectorAll(".ant-modal .ant-form-item")];
      const it = items.find(e => (e.querySelector(".ant-form-item-label")?.textContent||"").includes("出生年月"));
      if (!it) return null;
      return { n: it.querySelectorAll(".ant-select").length, ph: [...it.querySelectorAll(".ant-select-selection-placeholder")].map(e=>e.textContent) };
    })()`);
    check("出生年月是「年 + 月」两个下拉", twoSelects?.n === 2, `实际 ${twoSelects?.n} 个，placeholder=${JSON.stringify(twoSelects?.ph)}`);

    console.log("\n— 选 1994 年 5 月 —");
    // 打开年下拉
    await evalJs(cdp, `(() => {
      const items = [...document.querySelectorAll(".ant-modal .ant-form-item")];
      const it = items.find(e => (e.querySelector(".ant-form-item-label")?.textContent||"").includes("出生年月"));
      const sel = it.querySelectorAll(".ant-select")[0];
      sel.querySelector(".ant-select-selector").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    })()`);
    await sleep(1000);
    // 年份是倒序排列的，1994 排在第 33 位——rc-select 用虚拟列表，
    // 可视区外根本不渲染。所以必须先输入搜索词把它过滤出来，再选。
    // ⚠️ 搜索输入框在 .ant-select-selector 内部，不在 dropdown 里
    // （dropdown 只有选项列表）。之前误找 dropdown input 导致一直过滤不出来。
    const typed = await evalJs(cdp, `(() => {
      const items = [...document.querySelectorAll(".ant-modal .ant-form-item")];
      const it = items.find(e => (e.querySelector(".ant-form-item-label")?.textContent||"").includes("出生年月"));
      const sel = it.querySelectorAll(".ant-select")[0];
      const inp = sel.querySelector(".ant-select-selection-search-input");
      if (!inp) return "no-input";
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(inp, "1994");
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      return "typed";
    })()`);
    check("年下拉搜索框可输入", typed === "typed", String(typed));
    await sleep(1000);
    const optTexts = await evalJs(cdp, `[...document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")].map(e=>e.textContent.trim())`);
    check("搜索 1994 能过滤出该年", (optTexts || []).some((t) => t.includes("1994")), JSON.stringify(optTexts));

    const picked = await evalJs(cdp, `(() => {
      const opt = [...document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")].find(e=>e.textContent.includes("1994"));
      if (!opt) return false;
      opt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      opt.click();
      return true;
    })()`);
    check("选中 1994 年", picked === true);
    await sleep(800);

    // 打开月下拉，选 5 月
    await evalJs(cdp, `(() => {
      const items = [...document.querySelectorAll(".ant-modal .ant-form-item")];
      const it = items.find(e => (e.querySelector(".ant-form-item-label")?.textContent||"").includes("出生年月"));
      const sel = it.querySelectorAll(".ant-select")[1];
      sel.querySelector(".ant-select-selector").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    })()`);
    await sleep(900);
    const pickedM = await evalJs(cdp, `(() => {
      const opt = [...document.querySelectorAll(".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option")].find(e=>e.textContent.trim().replace(/\\s/g,"") === "5月");
      if (!opt) return false;
      opt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      opt.click();
      return true;
    })()`);
    check("选中 5 月", pickedM === true);
    await sleep(1000);

    const hint = await evalJs(cdp, `(() => {
      const items = [...document.querySelectorAll(".ant-modal .ant-form-item")];
      const it = items.find(e => (e.querySelector(".ant-form-item-label")?.textContent||"").includes("出生年月"));
      return it?.querySelector(".ant-form-item-extra")?.textContent || "";
    })()`);
    check("年龄实时算出（1994-05 → 32 岁）", /32\s*岁/.test(hint), `提示：${hint}`);

    const filled = await evalJs(cdp, `(() => {
      const items = [...document.querySelectorAll(".ant-modal .ant-form-item")];
      const it = items.find(e => (e.querySelector(".ant-form-item-label")?.textContent||"").includes("出生年月"));
      return [...it.querySelectorAll(".ant-select-selection-item")].map(e=>e.textContent.trim());
    })()`);
    check("两个下拉都显示已选值", filled.length === 2, JSON.stringify(filled));

    console.log("\n— 编辑态回填 —");
    await cdp.send("Page.navigate", { url: `${BASE}/talents` });
    await waitFor(cdp, `document.querySelectorAll("tr.ant-table-row").length > 0`, "表格");
    await sleep(600);
    // 找一个**确实有出生年月**的人：第一个候选人可能本来就没填，
    // 那样回填为空是正确行为，不能当成 bug。
    const target = await evalJs(cdp, `(async () => {
      const d = await (await fetch("/api/talents?limit=50")).json();
      const t = (d.items || []).find(x => x.birth_date);
      return t ? { id: t.id, bd: t.birth_date, name: t.name } : null;
    })()`);
    check("列表里能找到有出生年月的人", !!target, target ? `${target.name} ${target.bd}` : "没有");
    if (target) {
      // 操作列现在是 详情 | 编辑 | ⋯；用 data-row-key 精确定位那一行
      await evalJs(cdp, `document.querySelector('tr[data-row-key="${target.id}"]')?.querySelectorAll("td:last-child button")[1]?.click()`);
      const editOpened = await waitFor(cdp, `document.querySelectorAll(".ant-modal").length > 0`, "编辑弹窗");
      check("编辑弹窗打开", editOpened);
      await sleep(1800);
      const backfilled = await evalJs(cdp, `(() => {
        const items = [...document.querySelectorAll(".ant-modal .ant-form-item")];
        const it = items.find(e => (e.querySelector(".ant-form-item-label")?.textContent||"").includes("出生年月"));
        if (!it) return null;
        return [...it.querySelectorAll(".ant-select-selection-item")].map(e=>e.textContent.trim());
      })()`);
      const hasBirth = Array.isArray(backfilled) && backfilled.length === 2
        && /\d{4}\s*年/.test(backfilled[0]) && /\d{1,2}\s*月/.test(backfilled[1]);
      check("编辑态出生年月正确回填", hasBirth, `期望 ${target.bd}，实际 ${JSON.stringify(backfilled)}`);
    }

    console.log("\n— 详情页空值占位 —");
    await cdp.send("Page.navigate", { url: `${BASE}/talents` });
    await waitFor(cdp, `document.querySelectorAll("tr.ant-table-row").length > 0`, "表格");
    await sleep(500);
    const href = await evalJs(cdp, `document.querySelector("tr.ant-table-row td a")?.getAttribute("href")`);
    if (href) {
      await cdp.send("Page.navigate", { url: BASE + href });
      await sleep(6000);
      const dash = await evalJs(cdp, `(() => {
        const cards = [...document.querySelectorAll(".ant-card")];
        const card = cards.find(c => (c.querySelector(".ant-card-head-title")?.textContent||"").includes("基本信息"));
        if (!card) return null;
        return { dash: (card.textContent.match(/\\-/g)||[]).length, emdash: (card.textContent.match(/—/g)||[]).length };
      })()`);
      check("基本信息里用半角 - 占位", dash && dash.dash > 0 && dash.emdash === 0, JSON.stringify(dash));
    } else {
      check("基本信息里用半角 - 占位", false, "列表里没找到可点的人名");
    }

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
