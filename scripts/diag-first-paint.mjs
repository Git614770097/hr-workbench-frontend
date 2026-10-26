// 诊断：首屏到底渲染出没有？抓 console / 未捕获异常 / 全部请求 / 最终 DOM。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = process.argv[2] || "https://hr-work.club/tasks";
const WAIT = Number(process.argv[3] || 30000);
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9350;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "diagprofile-"));

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1440,900",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
chrome.stderr.on("data", () => {});

async function findWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const p = (await r.json()).find((t) => t.type === "page");
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error("CDP 未就绪");
}
const ws = new WebSocket(await findWsUrl());
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});
let msgId = 0;
const pending = new Map();
const logs = [];
const reqs = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  } else if (m.method === "Runtime.consoleAPICalled") {
    logs.push({
      kind: "console." + m.params.type,
      text: (m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(" "),
    });
  } else if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    logs.push({
      kind: "EXCEPTION",
      text: (d.exception?.description || d.text || "").slice(0, 500),
    });
  } else if (m.method === "Log.entryAdded") {
    logs.push({ kind: "log." + m.params.entry.level, text: (m.params.entry.text || "").slice(0, 300) });
  } else if (m.method === "Network.requestWillBeSent") {
    reqs.push({ url: m.params.request.url, type: m.params.type, id: m.params.requestId, done: false, status: null, bytes: 0 });
  } else if (m.method === "Network.responseReceived") {
    const q = reqs.find((x) => x.id === m.params.requestId);
    if (q) { q.status = m.params.response.status; q.proto = m.params.response.protocol; }
  } else if (m.method === "Network.loadingFinished") {
    const q = reqs.find((x) => x.id === m.params.requestId);
    if (q) { q.done = true; q.bytes = Math.round(m.params.encodedDataLength); }
  } else if (m.method === "Network.loadingFailed") {
    const q = reqs.find((x) => x.id === m.params.requestId);
    if (q) { q.failed = m.params.errorText; }
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Runtime.enable");
await send("Log.enable");
await send("Network.enable");
await send("Page.enable");
await send("Page.navigate", { url: URL_ });
await sleep(WAIT);

const r = await send("Runtime.evaluate", {
  expression: `JSON.stringify({
    readyState: document.readyState,
    url: location.href,
    title: document.title,
    rootChildren: document.getElementById('root') ? document.getElementById('root').childElementCount : -1,
    rootHTML: document.getElementById('root') ? document.getElementById('root').innerHTML.slice(0, 600) : 'NO ROOT',
    bodyText: document.body.innerText.slice(0, 400),
    bodyChildren: document.body.childElementCount,
    scripts: [...document.querySelectorAll('script')].map(s => s.src || '[inline]'),
    paint: performance.getEntriesByType('paint').map(p => p.name + '=' + Math.round(p.startTime))
  })`,
  returnByValue: true,
});
console.log("=== 最终 DOM 状态 ===");
console.log(JSON.stringify(JSON.parse(r?.result?.value || "{}"), null, 2));
console.log("");
console.log("=== Console / 异常 ===");
if (!logs.length) console.log("(无)");
logs.forEach((l) => console.log(`[${l.kind}] ${l.text}`));
console.log("");
console.log("=== 全部请求 ===");
reqs.forEach((q) =>
  console.log(
    "  ",
    (q.type || "").padEnd(10),
    (q.status ?? "-").toString().padStart(4),
    (q.done ? "完成" : q.failed ? "失败:" + q.failed : "未完成").padEnd(18),
    ((q.bytes || 0) / 1024).toFixed(1).padStart(8) + " KB",
    q.url.replace(/^https?:\/\/[^/]+/, "")
  )
);

ws.close();
chrome.kill("SIGKILL");
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
