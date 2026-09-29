// HTML 转义（纯函数，无浏览器依赖，前端与 Worker 共用）。
// 此前 TalentList、utils/template.ts、worker/reminders.ts 各存了一份同样的实现，
// 统一到此处避免多处漂移。
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
