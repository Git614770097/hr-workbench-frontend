// UI 层验证：出生年月选择器 + 附件卡片真的渲染出来了。
//
// 接口级验证（e2e-birth-attachment.mjs）已经证明数据是对的，这个脚本只补一件事：
// 用户真的能在界面上看到并操作。两块重点：
//   1. 人才表单里「年龄」已变成「出生年月」，且选完能显示算出来的岁数；
//   2. 人才详情页有独立的「附件」卡片，与「简历文件」分开。
//
// 前置：npx wrangler dev --port 8787 已启动，本地测试账号密码可用。
// 用法：node scripts/e2e-birth-ui.mjs
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
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return r.result?.value;
};

(async () => {
  console.log(`目标：${BASE}\n`);
  const token = await login();

  const profile = mkdtempSync(join(tmpdir(), "e2e-birth-ui-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
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

    // ── 一、人才表单：年龄 → 出生年月 ──────────────────────
    console.log("— 人才表单 —");
    await cdp.send("Page.navigate", { url: `${BASE}/talents` });
    await sleep(7000);

    // 点「新建人才」：按钮文案在不同版本略有差异，按关键字找
    const opened = await evalJs(
      cdp,
      `(() => {
        const b = [...document.querySelectorAll("button")].find((x) => /新建|新增|添加人才/.test(x.textContent || ""));
        if (!b) return false;
        b.click();
        return true;
      })()`
    );
    check("打开新建人才弹窗", opened === true, opened ? "" : "没找到按钮");
    await sleep(2500);

    const formInfo = await evalJs(
      cdp,
      `(() => {
        const labels = [...document.querySelectorAll(".ant-form-item-label label")].map((l) => l.textContent.trim());
        const hasBirth = labels.some((t) => t.includes("出生年月"));
        const hasAge = labels.some((t) => t === "年龄");
        // 出生年月那一项里应该有一个 DatePicker（antd 的月份选择器 class 带 ant-picker）
        const picker = [...document.querySelectorAll(".ant-picker")].length;
        return JSON.stringify({ hasBirth, hasAge, picker, labelCount: labels.length });
      })()`
    );
    const f = JSON.parse(formInfo || "{}");
    check("表单有「出生年月」", f.hasBirth === true, "");
    check("表单不再有「年龄」输入框", f.hasAge === false, f.hasAge ? "年龄项还在" : "");
    check("渲染出日期选择器", f.picker > 0, `${f.picker} 个`);

    // 选一个年月，确认提示里出现算好的岁数
    const picked = await evalJs(
      cdp,
      `(() => {
        // 直接改 React 受控组件不可靠，这里用真实点击：先聚焦出生年月输入框
        const item = [...document.querySelectorAll(".ant-form-item")].find((el) =>
          (el.querySelector(".ant-form-item-label label")?.textContent || "").includes("出生年月"));
        const input = item?.querySelector("input");
        if (!input) return false;
        input.focus();
        input.click();
        return true;
      })()`
    );
    await sleep(900);
    // 在弹出的月份面板里点一个年份，再点一个月
    const typed = await evalJs(
      cdp,
      `(() => {
        const input = document.activeElement;
        if (!input || input.tagName !== "INPUT") return false;
        // 直接输入日期串是最稳的方式：antd 的 DatePicker 支持键入
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(input, "1995-06");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        return true;
      })()`
    );
    await sleep(1500);
    const hint = await evalJs(
      cdp,
      `(() => {
        const item = [...document.querySelectorAll(".ant-form-item")].find((el) =>
          (el.querySelector(".ant-form-item-label label")?.textContent || "").includes("出生年月"));
        return item ? item.textContent.replace(/\\s+/g, " ") : "";
      })()`
    );
    check("选完年月后显示实时岁数", /\d+\s*岁/.test(hint || ""), `「${(hint || "").slice(0, 80)}」`);

    await cdp.send("Page.captureScreenshot", { format: "png" }).then((s) => {
      writeFileSync("dist/birth-form.png", Buffer.from(s.data, "base64"));
    });

    // ── 二、详情页附件卡片 ──────────────────────────────
    console.log("\n— 详情页附件 —");
    // 通过接口拿一个有 id 的人才，直接跳详情页，避免依赖列表分页
    const listRes = await fetch(`${BASE}/api/talents?limit=1`, { headers: { Cookie: `token=${token}` } });
    const list = await listRes.json();
    const tid = list.items?.[0]?.id;
    if (!tid) {
      check("取到人才用于详情页验证", false, "列表为空");
    } else {
      await cdp.send("Page.navigate", { url: `${BASE}/talents/${tid}` });
      await sleep(6500);
      const cards = await evalJs(
        cdp,
        `(() => {
          const titles = [...document.querySelectorAll(".ant-card-head-title")].map((e) => e.textContent.trim());
          return JSON.stringify({
            hasFileCard: titles.some((t) => t.startsWith("附件")),
            hasResumeCard: titles.some((t) => t.includes("简历文件")),
            titles,
          });
        })()`
      );
      const c = JSON.parse(cards || "{}");
      check("详情页有独立的「附件」卡片", c.hasFileCard === true, (c.titles || []).join(" / "));
      check("「简历文件」卡片仍在（两者分开）", c.hasResumeCard === true, "");
      check("附件卡片有上传入口", await evalJs(
        cdp,
        `[...document.querySelectorAll("button")].some((b) => /上传附件/.test(b.textContent || ""))`
      ) === true, "");

      // 滚到附件卡片位置再截图
      await evalJs(
        cdp,
        `(() => {
          const h = [...document.querySelectorAll(".ant-card-head-title")].find((e) => e.textContent.trim().startsWith("附件"));
          (h || document.body).scrollIntoView({ block: "center" });
          return true;
        })()`
      );
      await sleep(800);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync("dist/attachment-card.png", Buffer.from(shot.data, "base64"));
    }

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
