// 用 Chrome 原生 CDP 测「冷缓存首次加载」的真实水位线。
// 为什么不用 agent-browser：这条到 Cloudflare 的链路会中途 stall，
// agent-browser 的守护进程会被未完成的导航彻底堵死，后续命令全部超时。
// 这里直接驱动 Chrome（同一个真实浏览器、同样冷缓存、同样关掉磁盘缓存），自收 CDP 事件。
//
// 用法：node scripts/measure-first-load.mjs <url> [timeoutMs] [--warm]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = process.argv[2] || "https://hr-work.club/tasks";
const TIMEOUT_MS = Number(process.argv[3] || 120000);
const WARM = process.argv.includes("--warm");
const CHROME =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9333 + (WARM ? 1 : 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "coldprofile-"));

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-features=Translate,OptimizationHints",
  "--window-size=1440,900",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
chrome.stderr.on("data", () => {});

async function findWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error("CDP 未就绪");
}

const wsUrl = await findWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});

let msgId = 0;
const pending = new Map();
const events = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  } else if (m.method) {
    events.push(m);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Network.enable");
await send("Page.enable");
await send("Performance.enable");
// 冷缓存：显式禁用 HTTP 缓存（磁盘与内存都算）
if (!WARM) await send("Network.setCacheDisabled", { cacheDisabled: true });

const t0 = Date.now();
await send("Page.navigate", { url: URL_ });

const loaded = await new Promise((resolve) => {
  const iv = setInterval(() => {
    if (events.some((e) => e.method === "Page.loadEventFired")) {
      clearInterval(iv);
      resolve(true);
    }
  }, 150);
  setTimeout(() => {
    clearInterval(iv);
    resolve(false);
  }, TIMEOUT_MS);
});
const wallMs = Date.now() - t0;

// load 之后等一会儿，让 React 真正渲染出内容再取状态
await sleep(3000);

// ---- 解析 CDP 网络事件（不依赖页面 JS 上下文，最稳）----
const sent = new Map();
const resp = new Map();
const fin = new Map();
const fail = new Map();
for (const e of events) {
  const p = e.params || {};
  if (e.method === "Network.requestWillBeSent") {
    sent.set(p.requestId, {
      url: p.request.url,
      type: p.type,
      startMs: (p.timestamp - t0 / 1000) * 1000,
      method: p.request.method,
    });
  } else if (e.method === "Network.responseReceived") {
    resp.set(p.requestId, {
      status: p.response.status,
      proto: p.response.protocol,
      fromCache: p.response.fromDiskCache || p.response.fromPrefetchCache,
      mime: p.response.mimeType,
      headers: p.response.headers,
    });
  } else if (e.method === "Network.loadingFinished") {
    fin.set(p.requestId, {
      bytes: p.encodedDataLength,
      endMs: (p.timestamp - t0 / 1000) * 1000,
    });
  } else if (e.method === "Network.loadingFailed") {
    fail.set(p.requestId, { error: p.errorText, cancel: p.canceled });
  }
}
const base = (u) => u.replace(/^https?:\/\/[^/]+/, "") || "/";
const rows = [...sent.entries()].map(([id, s]) => {
  const r = resp.get(id) || {};
  const f = fin.get(id) || {};
  const x = fail.get(id) || {};
  const encLen = Number(r.headers?.["content-length"] || 0);
  return {
    url: base(s.url),
    type: s.type,
    method: s.method,
    status: r.status ?? "-",
    proto: r.proto ?? "-",
    fromCache: r.fromCache ? "yes" : "no",
    startMs: Math.round(s.startMs),
    endMs: f.endMs != null ? Math.round(f.endMs) : null,
    bytes: f.bytes != null ? Math.round(f.bytes) : encLen,
    failed: x.error || null,
  };
});

// 页面级指标（若上下文还活着）
let perf = null;
let evalErr = null;
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    const r = await send("Runtime.evaluate", {
      expression: `JSON.stringify({
        nav: (() => { const n = performance.getEntriesByType('navigation')[0]; return n ? {
          protocol: n.nextHopProtocol, domainLookupEnd: n.domainLookupEnd,
          connectStart: n.connectStart, secureConnectionStart: n.secureConnectionStart,
          connectEnd: n.connectEnd, requestStart: n.requestStart,
          responseStart: n.responseStart, responseEnd: n.responseEnd,
          domInteractive: n.domInteractive, domContentLoadedEventEnd: n.domContentLoadedEventEnd,
          domComplete: n.domComplete, loadEventEnd: n.loadEventEnd,
          transferSize: n.transferSize, encodedBodySize: n.encodedBodySize } : null })(),
        paint: performance.getEntriesByType('paint').map(p => ({ n: p.name, t: Math.round(p.startTime) })),
        title: document.title, url: location.href,
        bodyLen: document.body.innerText.length,
        text: document.body.innerText.slice(0, 400)
      })`,
      returnByValue: true,
    });
    if (r?.result?.value) { perf = JSON.parse(r.result.value); break; }
    evalErr = JSON.stringify(r).slice(0, 400);
  } catch (e) { evalErr = String(e).slice(0, 400); }
  await sleep(800);
}

writeFileSync(
  "/tmp/cdp-raw.json",
  JSON.stringify({ url: URL_, warm: WARM, wallMs, loaded, evalErr, perf, rows }, null, 2)
);

const kb = (b) => (b / 1024).toFixed(1) + " KB";
console.log(`=== ${WARM ? "热缓存" : "冷缓存"}首次加载：${URL_} ===`);
console.log("load 事件到达:", loaded ? "是" : "否（超时）", " 墙钟耗时:", (wallMs / 1000).toFixed(2), "s");
if (perf?.nav) {
  const n = perf.nav;
  const f = (x) => (x == null ? "n/a" : (x / 1000).toFixed(3) + "s");
  console.log("");
  console.log("--- Navigation Timing ---");
  console.log("  协议        :", n.protocol);
  console.log("  DNS 结束    :", f(n.domainLookupEnd));
  console.log("  TLS 结束    :", f(n.connectEnd));
  console.log("  请求发出    :", f(n.requestStart));
  console.log("  首字节 TTFB :", f(n.responseStart));
  console.log("  响应结束    :", f(n.responseEnd));
  console.log("  DOM 可交互  :", f(n.domInteractive));
  console.log("  DCL         :", f(n.domContentLoadedEventEnd));
  console.log("  load        :", f(n.loadEventEnd));
}
if (perf) {
  console.log("");
  console.log("--- 渲染 ---");
  console.log("  paint:", JSON.stringify(perf.paint));
  console.log("  标题:", perf.title, "| URL:", perf.url, "| 正文字数:", perf.bodyLen);
  if (perf.text) console.log("  正文片段:", JSON.stringify(perf.text));
}
console.log("");
console.log("--- 网络请求（按开始时间）---");
console.log(
  ["资源".padEnd(30), "类型".padEnd(10), "状态".padStart(4), "协议".padStart(5), "开始".padStart(8), "结束".padStart(9), "字节".padStart(10), "失败"].join(" ")
);
for (const r of rows.sort((a, b) => a.startMs - b.startMs)) {
  console.log(
    [
      r.url.slice(0, 29).padEnd(30),
      (r.type || "").padEnd(10),
      String(r.status).padStart(4),
      (r.proto || "-").padStart(5),
      (r.startMs + "ms").padStart(8),
      (r.endMs != null ? r.endMs + "ms" : "-").padStart(9),
      (r.bytes ? kb(r.bytes) : "-").padStart(10),
      r.failed || "",
    ].join(" ")
  );
}
const totalBytes = rows.filter((r) => r.type !== "Other").reduce((s, r) => s + (r.bytes || 0), 0);
console.log("");
console.log("资源字节合计:", kb(totalBytes));
const failed = rows.filter((r) => r.failed);
if (failed.length) {
  console.log("失败请求:");
  failed.forEach((f) => console.log("   ", f.url, "->", f.failed));
}

ws.close();
chrome.kill("SIGKILL");
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
