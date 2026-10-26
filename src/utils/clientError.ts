// 前端错误上报（fire-and-forget）：渲染崩溃 / 未捕获异常 / 未处理 Promise 拒绝
// 统一 POST 到 /api/logs/client-error，服务端落 audit_logs（action=client_error），
// 管理员在「日志管理 → 操作审计」里能看到出错轨迹，而不是只能等用户来报障。
//
// 约定：
// - 失败静默——上报本身绝不能再抛错（否则 ErrorBoundary 的兜底 UI 都会被带崩）；
// - 60 秒内同 message 只报一次——同一个组件反复崩会把审计表灌满；
// - 不带 cookie 也要能报（登录页白屏正是最需要留痕的场景），keepalive 保证页面卸载中也能发出。

const REPORT_URL = "/api/logs/client-error";
const DEDUPE_WINDOW_MS = 60_000;
const MAX_MESSAGE = 300;
const MAX_STACK = 2000;

const recent = new Map<string, number>();

export function reportClientError(error: unknown, extra?: { componentStack?: string }): void {
  try {
    const message = (error instanceof Error ? error.message : String(error ?? "unknown error")).slice(0, MAX_MESSAGE);
    const key = message;
    const now = Date.now();
    const last = recent.get(key);
    if (last && now - last < DEDUPE_WINDOW_MS) return;
    recent.set(key, now);
    // 顺手清掉过期 key，Map 不会无界增长
    if (recent.size > 50) {
      for (const [k, t] of recent) if (now - t >= DEDUPE_WINDOW_MS) recent.delete(k);
    }

    const body = {
      message,
      stack: (error instanceof Error ? error.stack || "" : "").slice(0, MAX_STACK),
      component_stack: (extra?.componentStack || "").slice(0, MAX_STACK),
      url: location.pathname + location.search,
    };
    void fetch(REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => { /* 上报失败不处理 */ });
  } catch {
    /* 上报工具自身异常直接吞掉 */
  }
}

/** 给 window 挂全局兜底监听（在 main.tsx 调一次）。 */
export function installGlobalErrorHandlers(): void {
  window.addEventListener("error", (e) => {
    // 资源加载失败（img/script）不带 Error 实例，只留 message，噪音大，跳过
    if (e.error == null && e.message === "Script error.") return;
    reportClientError(e.error ?? new Error(e.message || "window.onerror"));
  });
  window.addEventListener("unhandledrejection", (e) => {
    reportClientError(e.reason ?? new Error("unhandledrejection"));
  });
}
