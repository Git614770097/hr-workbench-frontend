import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { isMobilePathname, menuKeyOfPath } from "../usageMeta";

/**
 * 前端使用埋点：记录用户打开了哪些模块（PV）与停留时长。
 *
 * 设计要点（都是为了压住 D1 的写入量）：
 * - **不逐次上报**。会话内先在内存里按菜单聚合计数，每 30 秒或页面隐藏/关闭时
 *   才批量发一次；后端收到的是一次「合并后的增量」，直接 UPSERT 聚合表。
 *   逐次直接写库会把行数放大 10~50 倍。
 * - 用 `sendBeacon` 保证页面卸载时也能送达（同源请求自动带 httpOnly 的 token cookie）；
 *   失败再退回 `fetch(keepalive: true)` 带 Bearer 兜底。
 * - 只上报菜单 key + 次数 + 停留毫秒 + 终端类型，**不涉及任何业务数据**。
 *
 * 组件本身不渲染任何东西，挂在桌面与移动两棵树上各一份。
 */

const FLUSH_MS = 30_000;
/** 停留累计上限：单次 flush 窗口最长按 10 分钟计，防止异常挂起把数字撑爆 */
const MAX_DWELL_MS = 10 * 60_000;

type Bucket = { views: number; dwell_ms: number };

const pending = new Map<string, Bucket>();
let currentMenu: string | null = null;
let enteredAt = Date.now();
/** 页面在后台时不计停留（否则「开着不关」会把时长刷成天文数字） */
let active = typeof document === "undefined" ? true : document.visibilityState !== "hidden";
let globalsBound = false;

function bump(menu: string, key: keyof Bucket, n: number) {
  const b = pending.get(menu) || { views: 0, dwell_ms: 0 };
  b[key] += n;
  pending.set(menu, b);
}

/** 结算当前菜单的停留片段（并重置起点）。后台状态下只重置、不计时。 */
function settle() {
  const now = Date.now();
  if (currentMenu && active) {
    const d = Math.min(now - enteredAt, MAX_DWELL_MS);
    if (d > 0) bump(currentMenu, "dwell_ms", d);
  }
  enteredAt = now;
}

/** 切到新菜单：结算上一段停留，并给新菜单 +1 次访问 */
function enter(menu: string | null) {
  if (menu === currentMenu) return;
  settle();
  currentMenu = menu;
  if (menu) bump(menu, "views", 1);
}

/** 把累积的计数批量送出并清空。任何异常都不能影响页面。 */
function flush() {
  try {
    settle();
    if (!pending.size) return;

    const token = typeof localStorage !== "undefined" ? localStorage.getItem("token") : null;
    // 未登录（登录页/落地页）不上报，顺手丢掉避免越积越多
    if (!token) {
      pending.clear();
      return;
    }

    const events = Array.from(pending.entries())
      .map(([menu, b]) => ({
        menu,
        views: b.views,
        dwell_ms: Math.min(Math.round(b.dwell_ms), MAX_DWELL_MS),
      }))
      .filter((e) => e.views > 0 || e.dwell_ms >= 1000);
    pending.clear();
    if (!events.length) return;

    const payload = JSON.stringify({
      platform: isMobilePathname(window.location.pathname) ? "mobile" : "desktop",
      events,
    });
    const url = "/api/logs/report";

    // 首选 beacon：页面正在关闭时 fetch 会被取消，beacon 不会。
    // 同源请求默认携带 cookie（含 httpOnly 的 token），后端据此鉴权。
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      const ok = navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
      if (ok) return;
    }

    // 兜底：keepalive 让请求在页面卸载后仍能完成（体积上限 64KB，本场景远低于）
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: payload,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* 埋点失败必须静默 */
  }
}

function onVisibility() {
  active = document.visibilityState !== "hidden";
  if (active) {
    // 回到前台：重新开始计时，且不把后台那段时间算进停留
    enteredAt = Date.now();
  } else {
    flush();
  }
}

/** 全局监听与定时器只绑定一次（组件在桌面/移动树各挂一次，重复绑定会重复上报） */
function bindGlobals() {
  if (globalsBound) return;
  globalsBound = true;
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", flush);
  window.setInterval(flush, FLUSH_MS);
}

export default function UsageTracker() {
  const location = useLocation();
  const lastPath = useRef<string>("");

  useEffect(() => {
    bindGlobals();
  }, []);

  useEffect(() => {
    // 同一路径重复渲染不重复计（React 重渲染、query/hash 变化都会走到这里）
    if (lastPath.current === location.pathname) return;
    lastPath.current = location.pathname;
    enter(menuKeyOfPath(location.pathname));
  }, [location.pathname]);

  return null;
}
