// 数据库时间解析与格式化（统一时区处理，避免在页面里各写一份）
//
// D1 的 datetime('now') 返回 "YYYY-MM-DD HH:MM:SS"：是 UTC，且不带时区后缀。
// 直接 new Date(v) 会被浏览器当成「本地时间」解析，中国用户（UTC+8）看到的时间
// 会比真实时间早 8 小时——页面上表现为「创建时间不对」。
// 正确做法：补成 ISO（空格换 T，尾部加 Z）再交给 Date 解析。

/** 把数据库时间字符串解析成 Date（已是 ISO 的原样处理） */
export function parseDbTime(s: string): Date {
  return new Date(s.includes("T") || s.includes("Z") || s.endsWith("+00:00") ? s : s.replace(" ", "T") + "Z");
}

/** 格式化为本地日期时间，如 2026/9/28 15:33:12；空值或非法值返回 — */
export function fmtDateTime(v?: string | null): string {
  if (!v) return "—";
  const d = parseDbTime(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN");
}

/** 格式化为本地日期，如 2026/9/28；空值或非法值返回 — */
export function fmtDate(v?: string | null): string {
  if (!v) return "—";
  const d = parseDbTime(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("zh-CN");
}
