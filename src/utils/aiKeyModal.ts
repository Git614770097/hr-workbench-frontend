// 打开「AI Key 设置」弹窗的统一入口。
// Layout 挂载了全局监听（window 事件 open-ai-key），任何地方（配额用尽提示、
// 用户菜单、移动端提示条）调这个函数即可弹出，不需要层层传 state。
export function openAiKeyModal(): void {
  window.dispatchEvent(new Event("open-ai-key"));
}
