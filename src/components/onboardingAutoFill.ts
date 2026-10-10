/**
 * 新手指引「代填表单」桥接层。
 *
 * 引导只负责「讲解 + 触发」，真正打开页面表单、填示例值、保存成功回调都在各页面里，
 * 这里只是一层极薄的发布订阅，避免引导组件直接 import 业务页面（会循环依赖 / 体积爆炸）。
 *
 * 用法：
 *   · 业务页在 mount 时用 registerOnbFill(route, { open, fill }) 登记两个回调：
 *       - open(): 打开「空」的新建表单（不填示例值），供引导在步骤展示时自动弹出；
 *       - fill(): 把示例数据写进已打开的表单，供引导点「帮我填好表单」时调用。
 *   · 引导进入动手步骤时自动 openOnbForm(route) 弹空表单；用户点「帮我填好表单」后
 *     fillOnbForm(route) 填好数据；用户点「保存」成功（新建）后 notifyOnbSaved()，
 *     引导监听到就自动进入下一步。
 *   · 若页面尚未 mount 登记，open/fill 请求会进入 pending 队列，页面登记时自动 flush，
 *     因此引导无需自己写重试定时器。
 */

interface OnbHandlers {
  /** 打开空的新建表单（不填示例值） */
  open: () => void;
  /** 把示例数据写进已打开的表单 */
  fill: () => void;
}

const registry: Record<string, OnbHandlers> = {};
const pending: Record<string, ("open" | "fill")[]> = {};

/** 登记某路由的 open/fill 处理器，返回注销函数（组件卸载时调） */
export function registerOnbFill(route: string, handlers: OnbHandlers): () => void {
  registry[route] = handlers;
  const q = pending[route];
  if (q && q.length) {
    pending[route] = [];
    q.forEach((mode) => (mode === "open" ? handlers.open() : handlers.fill()));
  }
  return () => {
    if (registry[route] === handlers) delete registry[route];
  };
}

function request(route: string, mode: "open" | "fill"): boolean {
  const h = registry[route];
  if (!h) {
    // 页面还没登记好：排队，等登记时 flush
    pending[route] = pending[route] || [];
    pending[route].push(mode);
    return false;
  }
  try {
    mode === "open" ? h.open() : h.fill();
  } catch {
    return false;
  }
  return true;
}

/** 打开某路由的空新建表单（页面需已登记，否则排队） */
export function openOnbForm(route: string): boolean {
  return request(route, "open");
}

/** 把示例数据写进某路由已打开的表单（页面需已登记，否则排队） */
export function fillOnbForm(route: string): boolean {
  return request(route, "fill");
}

/** 业务页新建保存成功后广播，引导据此判定动手任务完成 */
export function notifyOnbSaved(): void {
  try {
    window.dispatchEvent(new CustomEvent("onb:record-saved"));
  } catch {
    /* 忽略 */
  }
}
