/**
 * 写入侧粗滤：去掉 <script>、on* 事件属性、javascript: 协议。
 * 不是完整 HTML 净化——渲染侧必须再过 sanitizeHtml（DOMPurify）兜底；
 * 这里只保证库里的存量数据不长期躺着可执行载荷。
 */
export function stripDangerousHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<script\b[\s\S]*?(?:<\/script>|$)/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'>\s]*/gi, "$1=$2#")
    .replace(/<(iframe|object|embed|form|input|button|textarea|select)\b[^>]*>/gi, "")
    .replace(/<\/(iframe|object|embed|form|input|button|textarea|select)>/gi, "");
}
