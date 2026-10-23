import { lazyPage } from "./utils/lazyPage";

/**
 * 路由页面的 loader 注册表。
 *
 * 一份 loader 三处共用：
 *   1. App.tsx 的路由元素（lazyPage 渲染）
 *   2. 菜单 hover 预取（prefetchPage）
 *   3. 进系统后的空闲批量预取（Layout 里 stagger 调用）
 * 同一 loader 反复调用命中模块缓存，天然去重，不会重复下载。
 */

export const pageLoaders = {
  // 登录页单独成 chunk：它独占 antd 的 Form / Input / Radio（rc-field-form 一家约 47KB raw），
  // 拆出去后未登录首屏（落地页）不用背这份重量。落地页空闲时会把 /login 预取回来。
  "/login": () => import("./pages/Login"),
  "/tasks": () => import("./pages/Tasks"),
  "/funnel": () => import("./pages/Funnel"),
  "/jobs": () => import("./pages/Jobs"),
  "/requisitions": () => import("./pages/Requisitions"),
  "/pipeline": () => import("./pages/Pipeline"),
  "/interviews": () => import("./pages/Interviews"),
  "/approvals": () => import("./pages/Approvals"),
  "/onboarding": () => import("./pages/Onboarding"),
  "/background": () => import("./pages/Background"),
  "/talents": () => import("./pages/TalentList"),
  "/talents/detail": () => import("./pages/TalentDetail"),
  "/profiles": () => import("./pages/Profiles"),
  "/match": () => import("./pages/Match"),
  "/ai-assistant": () => import("./pages/AiAssistant"),
  "/templates": () => import("./pages/TemplateLibrary"),
  "/contracts": () => import("./pages/Contracts"),
  "/social": () => import("./pages/Social"),
  "/roles": () => import("./pages/Roles"),
  "/users": () => import("./pages/Users"),
  "/team": () => import("./pages/Team"),
  "/settings": () => import("./pages/Settings"),
  "/logs": () => import("./pages/Logs"),
  "/audit": () => import("./pages/AuditLogs"),
  "/help": () => import("./pages/Help"),
  "/m/tasks": () => import("./mobile/MTasks"),
  "/m/pipeline": () => import("./mobile/MPipeline"),
  "/m/talents": () => import("./mobile/MTalents"),
  "/m/interviews": () => import("./mobile/MInterviews"),
  "/m/funnel": () => import("./mobile/MFunnel"),
} as const;

export type PagePath = keyof typeof pageLoaders;

/** 预取某路由的 chunk（幂等）。路径不在表里（如 /talents/:id）时做前缀归一。 */
export function prefetchPage(path: string): void {
  const key = normalizePageKey(path);
  const loader = key ? pageLoaders[key as PagePath] : undefined;
  if (loader) void loader().catch(() => {});
}

/** "/talents/123" → "/talents"；"/talents/detail" 保持不变（详情页单独一个 chunk） */
function normalizePageKey(path: string): string {
  const p = path.split("?")[0].replace(/\/+$/, "") || "/";
  if (p === "/talents/detail") return p;
  if (p.startsWith("/talents/")) return "/talents";
  return p;
}

// ── 页面组件：App 路由直接用 ──────────────────────────────────────────
export const Login = lazyPage(pageLoaders["/login"]);
export const Tasks = lazyPage(pageLoaders["/tasks"]);
export const Funnel = lazyPage(pageLoaders["/funnel"]);
export const Jobs = lazyPage(pageLoaders["/jobs"]);
export const Requisitions = lazyPage(pageLoaders["/requisitions"]);
export const Pipeline = lazyPage(pageLoaders["/pipeline"]);
export const Interviews = lazyPage(pageLoaders["/interviews"]);
export const Approvals = lazyPage(pageLoaders["/approvals"]);
export const Onboarding = lazyPage(pageLoaders["/onboarding"]);
export const Background = lazyPage(pageLoaders["/background"]);
export const TalentList = lazyPage(pageLoaders["/talents"]);
export const TalentDetail = lazyPage(pageLoaders["/talents/detail"]);
export const Profiles = lazyPage(pageLoaders["/profiles"]);
export const Match = lazyPage(pageLoaders["/match"]);
export const AiAssistant = lazyPage(pageLoaders["/ai-assistant"]);
export const TemplateLibrary = lazyPage(pageLoaders["/templates"]);
export const Contracts = lazyPage(pageLoaders["/contracts"]);
export const Social = lazyPage(pageLoaders["/social"]);
export const Roles = lazyPage(pageLoaders["/roles"]);
export const Users = lazyPage(pageLoaders["/users"]);
export const Team = lazyPage(pageLoaders["/team"]);
export const Settings = lazyPage(pageLoaders["/settings"]);
export const Logs = lazyPage(pageLoaders["/logs"]);
export const AuditLogs = lazyPage(pageLoaders["/audit"]);
export const Help = lazyPage(pageLoaders["/help"]);
export const MTasks = lazyPage(pageLoaders["/m/tasks"]);
export const MPipeline = lazyPage(pageLoaders["/m/pipeline"]);
export const MTalents = lazyPage(pageLoaders["/m/talents"]);
export const MInterviews = lazyPage(pageLoaders["/m/interviews"]);
export const MFunnel = lazyPage(pageLoaders["/m/funnel"]);
