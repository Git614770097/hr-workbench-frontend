/**
 * 使用日志（模块点击率）的菜单元数据：路径 → 菜单 key 映射 + 菜单显示名与配色。
 *
 * 前端埋点（components/UsageTracker）与日志管理页（pages/Logs）共用这份定义，
 * 保证「上报的 key」与「页面展示的名字」永远一致；后端 logs.ts 里另有一份
 * 白名单（USAGE_MENUS）用于过滤脏数据，两处同步。
 *
 * ⚠️ 菜单 key 与 Layout.tsx 的 NAV_TREE 一一对应。新增菜单时这里也要加一行，
 *    否则新模块的访问会被识别为 null 而被丢弃（统计里看不到）。
 */

interface RouteMenu {
  /** 路径前缀（桌面路径；移动版 /m/xxx 会先剥掉前缀再匹配） */
  prefix: string;
  /** 归属的菜单 key；与权限菜单 key 同名，多个路由共用一个菜单（如审批/入职 → pipeline） */
  menu: string;
}

/** 注意顺序：先具体后宽泛（/talents 会命中 /talents/:id，属预期） */
const ROUTE_MENU: RouteMenu[] = [
  { prefix: "/tasks", menu: "tasks" },
  { prefix: "/jobs", menu: "jobs" },
  { prefix: "/requisitions", menu: "jobs" },
  { prefix: "/pipeline", menu: "pipeline" },
  { prefix: "/interviews", menu: "interviews" },
  { prefix: "/approvals", menu: "pipeline" },
  { prefix: "/onboarding", menu: "pipeline" },
  { prefix: "/funnel", menu: "funnel" },
  { prefix: "/talents", menu: "talents" },
  { prefix: "/profiles", menu: "profiles" },
  { prefix: "/match", menu: "profiles" },
  { prefix: "/contracts", menu: "contracts" },
  { prefix: "/social", menu: "social" },
  { prefix: "/templates", menu: "templates" },
  { prefix: "/roles", menu: "roles" },
  { prefix: "/users", menu: "users" },
  { prefix: "/settings", menu: "settings" },
  { prefix: "/logs", menu: "logs" },
  { prefix: "/help", menu: "help" },
];

/** 菜单显示名（榜单、图例、明细表共用） */
export const MENU_LABELS: Record<string, string> = {
  tasks: "待办日历",
  jobs: "岗位管理",
  pipeline: "招聘看板",
  interviews: "面试管理",
  funnel: "招聘概览",
  talents: "人才库管理",
  profiles: "人才画像",
  contracts: "合同管理",
  social: "社保公积金",
  templates: "模板库管理",
  roles: "角色管理",
  users: "用户管理",
  settings: "系统设置",
  logs: "日志管理",
  help: "帮助中心",
};

/** 菜单主题色（与侧栏 icon 配色一致，图表里保持同一个模块同一种颜色） */
export const MENU_COLORS: Record<string, string> = {
  tasks: "#f97316",
  jobs: "#6366f1",
  pipeline: "#0ea5e9",
  interviews: "#8b5cf6",
  funnel: "#14b8a6",
  talents: "#3b82f6",
  profiles: "#10b981",
  contracts: "#d97706",
  social: "#0d9488",
  templates: "#8b5cf6",
  roles: "#f59e0b",
  users: "#f59e0b",
  settings: "#64748b",
  logs: "#64748b",
  help: "#94a3b8",
};

/** 是否为移动版路径。必须与 App.tsx 的判定一致，不能写 startsWith("/m")——"/match" 也以 /m 开头。 */
export function isMobilePathname(pathname: string): boolean {
  return pathname === "/m" || pathname.startsWith("/m/");
}

/**
 * 把路径解析成菜单 key；无法识别（首页跳转、未知路径）返回 null。
 * 移动版 /m/tasks 与桌面 /tasks 视为同一模块，统一计入同一个 key。
 */
export function menuKeyOfPath(pathname: string): string | null {
  let p = pathname;
  if (p === "/m") return null;
  if (p.startsWith("/m/")) p = p.slice(2);

  for (const r of ROUTE_MENU) {
    if (p === r.prefix || p.startsWith(r.prefix + "/")) return r.menu;
  }
  return null;
}

/** 菜单显示名；未知 key 原样回显，避免出现空白单元格 */
export function menuLabel(menu: string): string {
  return MENU_LABELS[menu] || menu;
}
