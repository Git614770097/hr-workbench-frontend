// 验证人才详情页的信息结构优化（①~⑤）：
//   ① 摘要条已删（与基本信息重复是显乱主因）
//   ② 基本信息分三组 + 低频字段折叠
//   ③ 「简历原文」与「AI 解读」合并成一张卡的两个 Tab
//   ④ 右栏顶部「当前状态」卡（当前阶段 / 岗位 / 评分 / 来源 / 下一步）
//   ⑤ 「简历文件」与「附件」合并成「材料」卡的两个 Tab
//
// 前置：npx wrangler dev --port 8787 已启动
// 用法：node scripts/e2e-detail-ui.mjs [baseUrl]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] || "http://localhost:8787";
const PHONE = process.env.E2E_PHONE || "13900000099";
const PASSWORD = process.env.E2E_PASSWORD || "E2eTest123456";
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9800 + Math.floor(Math.random() * 200);

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
  const profile = mkdtempSync(join(tmpdir(), "e2e-detail-"));
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

    // 找一个有投递/待办的人：只有这类候选人的「当前状态」卡才会渲染出待办与阶段，
    // 否则会拿一个字段全空的记录来测，误报「没有复选框」。
    await cdp.send("Page.navigate", { url: `${BASE}/talents` });
    await waitFor(cdp, `document.querySelectorAll("tr.ant-table-row").length > 0`, "人才列表");
    const target = await evalJs(cdp, `(async () => {
      const d = await (await fetch("/api/talents?limit=50")).json();
      const items = d.items || [];
      for (const it of items.slice(0,12)) {
        const t = await (await fetch("/api/talents/" + it.id)).json();
        if (t && ((t.tasks || []).length || (t.pipeline || []).length)) return { id: t.id, name: t.name };
      }
      return items[0] ? { id: items[0].id, name: items[0].name } : null;
    })()`);
    check("拿到候选人 id", !!target, target ? target.name : "");

    await cdp.send("Page.navigate", { url: `${BASE}/talents/${target.id}` });
    await waitFor(cdp, `[...document.querySelectorAll(".ant-card-head-title")].some(e=>e.textContent.includes("基本信息"))`, "详情页基本信息卡");
    await sleep(1500);

    console.log("— ① 摘要条已删 —");
    const noSummary = await evalJs(cdp, `document.querySelector(".talent-summary") === null`);
    check("摘要条已删（不再与基本信息重复）", noSummary === true);

    console.log("\n— ② 基本信息：单表 + 新顺序，无分组标题 —");
    const groups = await evalJs(cdp, `[...document.querySelectorAll(".info-group-title")].length`);
    check("没有分组标题（结构件清零）", groups === 0, `实际 ${groups} 个`);

    // 字段顺序：电话/邮箱必须排最前（HR 打开详情页最先确认的就是怎么联系他）
    const labelOrder = await evalJs(cdp, `(() => {
      const card = [...document.querySelectorAll(".ant-card")].find(x => (x.querySelector(".ant-card-head-title")?.textContent||"").includes("基本信息"));
      if (!card) return null;
      return [...card.querySelectorAll(".ant-descriptions-item-label")]
        .filter(e => e.closest(".ant-collapse") === null)
        .map(e => e.textContent.trim());
    })()`);
    const firstTwo = (labelOrder || []).slice(0, 2);
    check("电话/邮箱排最前两位",
      firstTwo[0] === "电话" && firstTwo[1] === "邮箱", JSON.stringify(firstTwo));
    check("字段完整（14 项主表）", (labelOrder || []).length >= 14, `实际 ${(labelOrder||[]).length} 项`);

    const moreOpen = await evalJs(cdp, `(() => {
      const items = [...document.querySelectorAll(".ant-collapse-item")];
      return items.length === 1 ? items[0].textContent.trim() : "no-collapse";
    })()`);
    check("低频字段收进「更多信息」折叠", String(moreOpen).includes("更多信息"), String(moreOpen));

    // 展开折叠，验证来源渠道在里面
    await evalJs(cdp, `document.querySelector(".ant-collapse-header")?.click()`);
    await sleep(700);
    const moreContent = await evalJs(cdp, `document.querySelector(".ant-collapse-content")?.textContent || ""`);
    check("折叠里有来源渠道/入职日期", moreContent.includes("来源渠道") && moreContent.includes("入职日期"), moreContent.slice(0, 60));

    console.log("\n— ③ 简历与 AI 解读合并 —");
    const resumeCard = await evalJs(cdp, `(() => {
      const cards = [...document.querySelectorAll(".ant-card")];
      const c = cards.find(x => (x.querySelector(".ant-card-head-title")?.textContent||"").includes("简历与 AI 解读"));
      if (!c) return null;
      return { tabs: [...c.querySelectorAll(".ant-tabs-tab")].map(e=>e.textContent.trim()) };
    })()`);
    check("有一张「简历与 AI 解读」卡", !!resumeCard);
    check("含两个 Tab：简历原文 / AI 解读",
      JSON.stringify(resumeCard?.tabs) === JSON.stringify(["简历原文","AI 解读"]), JSON.stringify(resumeCard?.tabs));

    const oldCards = await evalJs(cdp, `(() => {
      const titles = [...document.querySelectorAll(".ant-card-head-title")].map(e=>e.textContent.trim());
      return { hasOldResume: titles.includes("简历原文"), hasOldAi: titles.includes("AI 简历解读") };
    })()`);
    check("不再有独立的「简历原文」卡", oldCards.hasOldResume === false);
    check("不再有独立的「AI 简历解读」卡", oldCards.hasOldAi === false);

    console.log("\n— ④ 当前状态卡 —");
    const state = await evalJs(cdp, `(() => {
      const cards = [...document.querySelectorAll(".ant-card")];
      const c = cards.find(x => (x.querySelector(".ant-card-head-title")?.textContent||"").includes("当前状态"));
      if (!c) return null;
      return { text: c.textContent, hasTasks: c.textContent.includes("待办") };
    })()`);
    check("有「当前状态」卡", !!state);
    check("待办已并入当前状态卡", state?.hasTasks === true);
    check("含当前阶段/所在岗位/评分/来源渠道",
      ["当前阶段","所在岗位","评分","来源渠道"].every(k => (state?.text||"").includes(k)));
    check("待办区块有可勾选的复选框",
      await evalJs(cdp, `(() => {
        const cards = [...document.querySelectorAll(".ant-card")];
        const c = cards.find(x => (x.querySelector(".ant-card-head-title")?.textContent||"").includes("当前状态"));
        return c ? c.querySelectorAll(".ant-checkbox-input").length > 0 : false;
      })()`) === true);

    const noTaskCard = await evalJs(cdp, `(() => {
      const titles = [...document.querySelectorAll(".ant-card-head-title")].map(e=>e.textContent.trim());
      return !titles.some(t => t.includes("相关待办"));
    })()`);
    check("不再有独立的「相关待办」卡（同一条待办不该显示两遍）", noTaskCard === true);

    console.log("\n— ⑤ 材料卡合并 —");
    const mat = await evalJs(cdp, `(() => {
      const cards = [...document.querySelectorAll(".ant-card")];
      const c = cards.find(x => (x.querySelector(".ant-card-head-title")?.textContent||"").trim() === "材料");
      if (!c) return null;
      return { tabs: [...c.querySelectorAll(".ant-tabs-tab")].map(e=>e.textContent.trim()) };
    })()`);
    check("有「材料」卡", !!mat);
    check("含两个 Tab：简历文件 / 附件",
      mat?.tabs?.length === 2 && mat.tabs[0].startsWith("简历文件") && mat.tabs[1].startsWith("附件"),
      JSON.stringify(mat?.tabs));

    const titles = await evalJs(cdp, `[...document.querySelectorAll(".ant-card-head-title")].map(e=>e.textContent.trim())`);
    check("不再有独立的「简历文件」卡", !titles.includes("简历文件"), JSON.stringify(titles));
    check("不再有独立的「附件」卡", !titles.some(t => t.startsWith("附件")), JSON.stringify(titles));

    // 切到「AI 解读」Tab，确认内容能渲染（不是空白）
    await evalJs(cdp, `(() => {
      const cards = [...document.querySelectorAll(".ant-card")];
      const c = cards.find(x => (x.querySelector(".ant-card-head-title")?.textContent||"").includes("简历与 AI 解读"));
      const tab = [...c.querySelectorAll(".ant-tabs-tab")].find(e=>e.textContent.includes("AI 解读"));
      (tab?.querySelector(".ant-tabs-tab-btn") || tab)?.click();
    })()`);
    await sleep(3000);
    // 注意：页面上有多组 Tab（材料卡也有一组），必须限定在「简历与 AI 解读」卡内取 active pane
    const aiPane = await evalJs(cdp, `(() => {
      const cards = [...document.querySelectorAll(".ant-card")];
      const c = cards.find(x => (x.querySelector(".ant-card-head-title")?.textContent||"").includes("简历与 AI 解读"));
      const pane = c.querySelector(".ant-tabs-tabpane-active");
      return pane ? pane.textContent.trim().slice(0,140) : "";
    })()`);
    check("切到 AI 解读 Tab 有内容", /AI|生成|解读/.test(aiPane||""), aiPane);

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
