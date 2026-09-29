// 菜单权限定义与校验工具（后端 + 前端共享语义，后端这份独立）
// 菜单 key 与前端 MENU_PERMISSIONS 保持一致

export const MENU_KEYS = ["tasks", "jobs", "pipeline", "funnel", "talents", "profiles", "templates", "users"] as const;
export type MenuKey = (typeof MENU_KEYS)[number];

// 解析 roles.permissions 的 JSON 字符串
export function parsePermissions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
