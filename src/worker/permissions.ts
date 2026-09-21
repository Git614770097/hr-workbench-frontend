// 菜单权限定义与校验工具（后端 + 前端共享语义，后端这份独立）
// 菜单 key 与前端 MENU_PERMISSIONS 保持一致

// 注：标签管理已降级为「人才库」页内弹窗，不再是独立菜单，
//     其接口权限改随 talents 校验（见 worker/index.ts 的 /api/tags 拦截）。
export const MENU_KEYS = ["talents", "pipeline", "jobs", "tasks", "templates", "users"] as const;
export type MenuKey = (typeof MENU_KEYS)[number];

export const MENU_LABELS: Record<MenuKey, string> = {
  talents: "人才库管理",
  pipeline: "招聘流程",
  jobs: "岗位管理",
  tasks: "跟进待办",
  templates: "模板库管理",
  users: "用户管理",
};

// 判断权限列表是否包含某菜单（admin 永远通过）
export function hasPermission(role: string, permissions: string[] | null | undefined, menu: MenuKey): boolean {
  if (role === "admin") return true;
  if (!permissions || !Array.isArray(permissions)) return false;
  return permissions.includes(menu);
}

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
