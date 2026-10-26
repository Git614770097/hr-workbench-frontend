// A/B：同一个浏览器、同样冷缓存、同样链路，分别下载「瘦身前」和「瘦身后」的
// antd 整包，直接比出首屏那一段到底省了多少时间。
//
// 背景：优化前的 antd-vendor（antd-vendor-BSnA5Nzz.js，gzip 379KB）仍留在 CDN 上，
// 优化后换成了 antd-vendor-D3r1WZ3G.js（gzip 217KB）。两者同源，可直接 fetch 对比。
//
// 用法：node scripts/measure-ab-chunks.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME =
  process.env.CHROME_PATH ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9340;
const OLD = "/assets/antd-vendor-BSnA5Nzz.js"; // 瘦身前
const NEW = "/assets/antd-vendor-D3r1WZ3G.js"; // 瘦身后

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), "abprofile-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
chrome.stderr.on("data", () => {});

async function findWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await r.json()).find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
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
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
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
await send("Network.setCacheDisabled", { cacheDisabled: true });
// 先落到同源页面，fetch 才不受 CORS 限制
await send("Page.navigate", { url: "https://hr-work.club/" });
await sleep(4000);

async function timeFetch(path) {
  const r = await send("Runtime.evaluate", {
    expression: `(async () => {
      const t0 = performance.now();
      try {
        const res = await fetch(${JSON.stringify(path)}, { cache: 'no-store' });
        const buf = await res.arrayBuffer();
        const t1 = performance.now();
        return JSON.stringify({
          ok: true, status: res.status, bytes: buf.byteLength,
          ms: Math.round(t1 - t0),
          enc: res.headers.get('content-encoding'),
          cc: res.headers.get('content-length'),
          cf: res.headers.get('cf-cache-status')
        });
      } catch (e) { return JSON.stringify({ ok: false, err: String(e) }); }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  return JSON.parse(r?.result?.value || "{}");
}

const rounds = Number(process.env.ROUNDS || 2);
const results = { old: [], new: [] };
for (let i = 0; i < rounds; i++) {
  results.old.push(await timeFetch(OLD));
  results.new.push(await timeFetch(NEW));
}

const fmt = (rs) =>
  rs
    .map((r) =>
      r.ok
        ? `${(r.bytes / 1024).toFixed(1)}KB/${r.ms}ms/${(r.bytes / 1024 / (r.ms / 1000)).toFixed(1)}KB·s`
        : `失败:${r.err}`
    )
    .join("   |   ");

console.log("=== 同一浏览器、同样冷缓存，逐次拉取耗时 ===");
console.log("瘦身前 antd-vendor-BSnA5Nzz.js :", fmt(results.old));
console.log("瘦身后 antd-vendor-D3r1WZ3G.js :", fmt(results.new));
const avg = (rs) => {
  const ok = rs.filter((r) => r.ok);
  if (!ok.length) return null;
  return {
    ms: ok.reduce((s, r) => s + r.ms, 0) / ok.length,
    bytes: ok.reduce((s, r) => s + r.bytes, 0) / ok.length,
  };
};
const o = avg(results.old), n = avg(results.new);
if (o && n) {
  console.log("");
  console.log("平均字节 :", (o.bytes / 1024).toFixed(1), "KB →", (n.bytes / 1024).toFixed(1), "KB");
  console.log("平均耗时 :", o.ms.toFixed(0), "ms →", n.ms.toFixed(0), "ms",
    "  节省", (o.ms - n.ms).toFixed(0), "ms（", ((1 - n.ms / o.ms) * 100).toFixed(1), "%）");
  console.log("实际吞吐 :", (o.bytes / 1024 / (o.ms / 1000)).toFixed(2), "KB/s →",
    (n.bytes / 1024 / (n.ms / 1000)).toFixed(2), "KB/s");
}
writeFileSync("/tmp/ab-chunks.json", JSON.stringify(results, null, 2));

ws.close();
chrome.kill("SIGKILL");
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
