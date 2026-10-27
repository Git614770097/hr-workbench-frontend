import { reportClientError } from "./clientError";

/**
 * 懒加载 chunk 拿不到（典型是 404）的识别与「一次性自动恢复」。
 *
 * 真实场景（2026-10-26 审计日志里的那条）：
 *   发版会删掉旧 hash 的 assets，而用户标签页里的 index.html 还是旧的。
 *   此时点一个没访问过的菜单 → import() 请求的是旧文件名 → 404 →
 *   "Failed to fetch dynamically imported module"。
 *   这种错误重试一百次也没用（文件已经不存在），唯一出路是重新拿一次 index.html。
 *
 * 策略：识别出来 → 自动刷新一次（刷新后 index.html 是新的，chunk 名字也就对了）。
 * 刷新还失败就认栽：说明不是版本问题，或者新版本本身也坏了。
 * 用 sessionStorage 记时间戳，60 秒内只自动刷一次，避免把用户拖进刷新死循环。
 */

const RELOAD_KEY = "chunk_autoreload_at";
const RELOAD_WINDOW_MS = 60_000;

/** 各家浏览器对「动态 import 的模块拿不到」措辞都不一样，只能全列上。 */
const CHUNK_ERROR_PATTERNS = [
  /Failed to fetch dynamically imported module/i, // Chrome / Edge / 新版 Safari
  /error loading dynamically imported module/i, // Firefox
  /Importing a module script failed/i, // Safari 旧版
  /Unable to preload CSS/i, // Vite 的 CSS 预加载
  /ChunkLoadError/, // webpack 风格，留着以防将来换构建器
];

export function isChunkLoadError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "");
  return CHUNK_ERROR_PATTERNS.some((re) => re.test(text));
}

/**
 * 尝试自动刷新一次。返回 true 表示「已经安排刷新了，调用方不要再渲染错误 UI」。
 *
 * 三种不刷新的情况：
 *  - 离线：刷了还是拿不到，反而丢掉用户当前页面；
 *  - 60 秒内刚刷过：说明刷新没解决问题，再刷就是死循环；
 *  - sessionStorage 不可用（隐私模式）：没法记录「刷过了」，宁可让用户手动刷。
 */
export function tryAutoReload(context: string): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (last && Date.now() - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  reportClientError(new Error(`chunk 加载失败，已自动刷新：${context}`));
  // 留 50ms 让上报请求先启动；keepalive 保证它在页面卸载后仍能发出
  setTimeout(() => {
    try {
      location.reload();
    } catch {
      /* 极少数环境禁止 reload，交给调用方的兜底 UI */
    }
  }, 50);
  return true;
}
