// 复制到剪贴板：优先 navigator.clipboard，失败降级 textarea + execCommand。
// 抽成公共模块是因为 AI 结果卡、人才详情等多处都要复制，
// 各处各写一份必然出现「https 下能复制、http 下静默失败」的不一致。

/** 复制成功返回 true；失败返回 false（调用方提示用户手动选择复制） */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 非 HTTPS / 旧浏览器降级
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
}
