// 浏览器端文件相关的通用小工具（导出下载）。
// HTML 转义 escapeHtml 抽到 utils/escapeHtml.ts（前端与 Worker 共用），此处 re-export 保持旧引用不变。
export { escapeHtml } from "./escapeHtml";

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 导出文件名用的本地时间戳：20260925_1603 */
export function dateStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** CSV 字段转义：含逗号/引号/换行的字段用双引号包裹，内部引号翻倍 */
export function csvCell(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
