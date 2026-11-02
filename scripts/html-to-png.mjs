// 把本地 HTML 精确渲染成 PNG（设计稿出图用）。
//
// 为什么不直接截屏浏览器窗口：要的是「内容多大就出多大」，不能带滚动条、
// 不能受窗口尺寸影响。这里用 Emulation.setDeviceMetricsOverride 把视口钉死成
// 设计稿尺寸，再按 deviceScaleFactor 出 2 倍图（印刷/高清屏都够）。
//
// 用法：
//   node scripts/html-to-png.mjs <输入.html> <输出.png> [宽=1080] [高=1440] [倍率=2]
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [, , htmlPath, pngPath, wArg, hArg, scaleArg] = process.argv;
if (!htmlPath || !pngPath) {
  console.error("用法: node scripts/html-to-png.mjs <输入.html> <输出.png> [宽] [高] [倍率]");
  process.exit(1);
}

const WIDTH = Number(wArg) || 1080;
const HEIGHT = Number(hArg) || 1440;
const SCALE = Number(scaleArg) || 2;
const CHROME =
  process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9800 + Math.floor(Math.random() * 150);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res, reject) => {
      this.pending.set(id, { resolve: res, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
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

const profile = mkdtempSync(join(tmpdir(), "html2png-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--force-device-scale-factor=1",
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
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: SCALE,
    mobile: false,
  });

  const url = pathToFileURL(resolve(htmlPath)).href;
  await cdp.send("Page.navigate", { url });

  // 等字体真正就绪，否则中文可能先出成 fallback 字体再重排
  for (let i = 0; i < 40; i++) {
    const r = await cdp
      .send("Runtime.evaluate", {
        expression: "document.readyState === 'complete' && document.fonts.status === 'loaded'",
        returnByValue: true,
      })
      .catch(() => null);
    if (r?.result?.value === true) break;
    await sleep(200);
  }
  await sleep(600);

  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
  });

  const out = resolve(pngPath);
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`已生成 ${out}  (${WIDTH * SCALE}×${HEIGHT * SCALE})`);

  ws.close();
} catch (e) {
  console.error("出图失败:", e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
}
