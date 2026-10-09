import type { User } from "../types";

/**
 * 桌面端「兜底落地页」的优先级顺序。
 *
 * 用于「无权限访问某页时，把用户送到第一个他能看的菜单」——
 * 之前这里写死 /talents，没有 talents 权限的账号会被反复重定向到同一个无权页面
 * （跳转目标自己也需要权限 → 死循环 / 白屏）。
 *
 * ⚠️ 这是**优先级列表，不是 Layout.tsx 菜单顺序的镜像**（2026-10-08 起菜单已改为
 *    一级/二级分组，两者不再逐项对应）。调这里等于改变兜底落地页，属于行为变更；
 *    而调整侧栏的展示分组不影响任何跳转。除非确实要改落地优先级，否则不要动。
 * 合同管理 / 社保公积金 已是独立权限（contracts / social），不再复用 talents，
 * 因此「只有 talents 权限」的用户不会再被送到合同页。
 */
const DESKTOP_ROUTES: { path: string; perm: string }[] = [
  { path: "/tasks", perm: "tasks" },
  { path: "/jobs", perm: "jobs" },
  { path: "/pipeline", perm: "pipeline" },
  { path: "/interviews", perm: "interviews" },
  { path: "/funnel", perm: "funnel" },
  { path: "/contracts", perm: "contracts" },
  { path: "/social", perm: "social" },
  { path: "/profiles", perm: "profiles" },
  { path: "/talents", perm: "talents" },
  { path: "/templates", perm: "templates" },
];

/**
 * 该用户第一个可访问的桌面页面；一个都没有（未分配任何角色权限）返回 null。
 * admin 固定回首页（招聘概览）。
 */
export function firstAccessiblePath(user: User | null | undefined): string | null {
  if (!user) return null;
  if (user.role === "admin") return "/funnel";
  const perms = user.permissions || [];
  return DESKTOP_ROUTES.find((r) => perms.includes(r.perm))?.path || null;
}

/**
 * 用户能否访问某个桌面菜单页。
 * 用于「引导步骤过滤」等场景：指向无权页面的引导会点到 403/重定向，必须提前剔除。
 * 不在菜单表内的路径（/roles、/settings、/talents/:id 等）一律放行，
 * 由各自的守卫兜底 —— 这里只负责菜单级判断。
 */
export function canAccessPath(user: User | null | undefined, path: string): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  const route = DESKTOP_ROUTES.find((r) => r.path === path);
  if (!route) return true;
  return (user.permissions || []).includes(route.perm);
}
