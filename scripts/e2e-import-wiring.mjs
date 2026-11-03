// 导入记录与导入流程的「接线」验证——真实上传一份简历，看批次是否被写进去。
//
// 为什么单独一个脚本：前面的 e2e-import-history.mjs 只验证了接口本身对不对，
// 它证明不了「ImportModal 在解析完真的调了建批次和写明细」。
// 而这段接线恰恰是最容易出问题的地方——它全是 fire-and-forget，
// 写失败了界面完全看不出来，只有事后翻记录才会发现是空的。
//
// 两条路径都要覆盖，因为它们记录的信息不同：
//   A. 解析失败 → 批次里必须留下一条 failed + 失败原因（这才是用户最想查的）
//   B. 解析成功 → 保存后必须变成 imported，并带上 talent_id
//
// 前置：npx wrangler dev --port 8787 已启动。
// 用法：node scripts/e2e-import-wiring.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] || "http://localhost:8787";
const PHONE = process.env.E2E_PHONE || "13900000099";
const PASSWORD = process.env.E2E_PASSWORD || "E2eTest123456";
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9400 + Math.floor(Math.random() * 200);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};

/**
 * 生成一份能被 pdfjs 抽出文字的最小 PDF。
 * 手写 xref 偏移量——错了 pdfjs 会直接判成损坏文件，测的就不是我们想测的东西了。
 * 内容故意用 ASCII：Helvetica 抽中文会变乱码，反而干扰解析结果。
 */
function makePdf(path, lines) {
  const content =
    "BT /F1 12 Tf 72 720 Td\n" +
    lines.map((l, i) => `${i ? "0 -22 Td " : ""}(${l}) Tj`).join("\n") +
    "\nET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  writeFileSync(path, out, "latin1");
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.requests = [];
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
    this.on("Network.requestWillBeSent", (p) => {
      this.requests.push(`${p.request.method} ${p.request.url.replace(BASE, "")}`);
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

const evalJs = async (cdp, expression) => {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.value;
};

/** 往 antd Dragger 的隐藏 input 里塞文件 */
async function uploadFile(cdp, filePath) {
  const doc = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: 'input[type="file"]',
  });
  if (!nodeId) throw new Error("没找到文件输入框");
  await cdp.send("DOM.setFileInputFiles", { files: [filePath], nodeId });
}

/** 等到某个条件成立，最多等 timeout 毫秒 */
async function waitUntil(fn, timeout = 60000, step = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

(async () => {
  console.log(`目标：${BASE}\n`);
  const token = await login();
  const auth = { Cookie: `token=${token}` };

  // 记录基线，稍后按「新增了多少」判断，避免受历史数据干扰
  const before = await (await fetch(`${BASE}/api/import-batches?limit=1`, { headers: auth })).json();
  const beforeTotal = before.total ?? 0;

  const dir = mkdtempSync(join(tmpdir(), "e2e-wiring-"));
  const badPdf = join(dir, "坏简历-扫描件.pdf");
  const goodPdf = join(dir, "李明-简历.pdf");
  // A. 故意做成损坏的 PDF：解析必然失败，用来验证「失败也要留记录」
  writeFileSync(badPdf, "%PDF-1.4\nthis is not a real pdf at all\n", "latin1");
  makePdf(goodPdf, [
    "Li Ming",
    "Phone: 13800138123",
    "Bachelor of Computer Science",
    "Peking University",
  ]);

  const profile = mkdtempSync(join(tmpdir(), "e2e-wiring-chrome-"));
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
    await cdp.send("DOM.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send("Network.setCookie", {
      name: "token", value: token, domain: "localhost", path: "/", httpOnly: true,
    });

    await cdp.send("Page.navigate", { url: `${BASE}/talents` });
    await sleep(7000);

    // 打开导入弹窗
    await evalJs(cdp, `[...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "导入")?.click()`);
    await sleep(1500);

    // ── A. 解析失败的文件 ──────────────────────────────
    console.log("— A. 解析失败也要留记录 —");
    await uploadFile(cdp, badPdf);
    await sleep(6000);

    const afterBad = await (await fetch(`${BASE}/api/import-batches?limit=1`, { headers: auth })).json();
    check("上传后新增了导入批次", (afterBad.total ?? 0) > beforeTotal, `${beforeTotal} → ${afterBad.total}`);
    check("前端确实调了建批次接口",
      cdp.requests.some((r) => r.startsWith("POST /api/import-batches")),
      cdp.requests.filter((r) => r.includes("import-batches")).slice(0, 3).join(" | "));
    check("前端确实调了写明细接口",
      cdp.requests.some((r) => /POST \/api\/import-batches\/[^/]+\/items/.test(r)),
      "");

    const badBatch = afterBad.items?.[0];
    if (badBatch) {
      const d = await (await fetch(`${BASE}/api/import-batches/${badBatch.id}`, { headers: auth })).json();
      const item = d.items?.[0];
      check("失败的文件被记成 failed", item?.status === "failed", `status=${item?.status}`);
      check("记录里带着原始文件名", /坏简历/.test(item?.file_name || ""), item?.file_name || "");
      check("失败原因有文字（不是空）", !!item?.error, (item?.error || "").slice(0, 60));
    } else {
      check("取到失败批次", false);
    }

    // ── B. 正常简历：解析 → 保存 → imported ──────────────
    console.log("\n— B. 保存成功后变成 imported —");
    await uploadFile(cdp, goodPdf);
    // 解析要等服务端抽文本 + AI 尝试，给足时间
    const reviewOpen = await waitUntil(async () =>
      await evalJs(cdp, `!!document.querySelector(".ant-modal-title") && /核对|确认/.test(
        [...document.querySelectorAll(".ant-modal-title")].map((e) => e.textContent).join(""))`)
    , 90000);
    check("解析后自动弹出核对窗口", reviewOpen === true, reviewOpen ? "" : "等超时");

    if (reviewOpen) {
      // 姓名没识别出来就手动补一个（解析器对英文名不一定认得出，别把测试卡在字段上）
      await evalJs(
        cdp,
        `(() => {
          const item = [...document.querySelectorAll(".ant-form-item")].find((el) =>
            (el.querySelector(".ant-form-item-label label")?.textContent || "").includes("姓名"));
          const input = item?.querySelector("input");
          if (!input || input.value) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(input, "李明");
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        })()`
      );
      await sleep(500);

      const saved = await evalJs(
        cdp,
        `(() => {
          const b = [...document.querySelectorAll(".ant-modal button")].find((x) => /保存并录入/.test(x.textContent || ""));
          if (!b) return false;
          b.click();
          return true;
        })()`
      );
      check("点到了「保存并录入」", saved === true, saved ? "" : "没找到按钮");

      // 等 PATCH 状态回写
      const patched = await waitUntil(async () =>
        cdp.requests.some((r) => /PATCH \/api\/import-batches\/[^/]+\/items\//.test(r)), 30000);
      check("保存后回写了明细状态（PATCH）", patched === true, "");

      // 找到最新批次并核对最终计数
      await sleep(1500);
      const finalList = await (await fetch(`${BASE}/api/import-batches?limit=3`, { headers: auth })).json();
      const hit = (finalList.items || []).find((b) => b.imported >= 1 && b.failed >= 1);
      check("存在一个「既有失败又有录入」的批次", !!hit,
        hit ? `上传 ${hit.total} / 录入 ${hit.imported} / 失败 ${hit.failed}` : JSON.stringify(finalList.items?.map((b) => [b.total, b.imported, b.failed])));
      check("四数相加等于上传份数",
        hit && hit.imported + hit.duplicate + hit.failed + hit.pending === hit.total,
        hit ? `${hit.imported}+${hit.duplicate}+${hit.failed}+${hit.pending}=${hit.total}` : "");

      if (hit) {
        const dd = await (await fetch(`${BASE}/api/import-batches/${hit.id}`, { headers: auth })).json();
        const ok = dd.items?.find((i) => i.status === "imported");
        check("录入的那份带上了 talent_id", !!ok?.talent_id, ok?.talent_id || "");
        check("录入的那份人才还在（talent_alive=1）", ok?.talent_alive === 1, `alive=${ok?.talent_alive}`);
      }
    }

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync("dist/import-wiring.png", Buffer.from(shot.data, "base64"));

    ws.close();
  } finally {
    chrome.kill();
    await sleep(400);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("脚本异常：", e.message);
  process.exit(1);
});
