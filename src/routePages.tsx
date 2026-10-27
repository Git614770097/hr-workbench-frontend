import { lazyPage } from "./utils/lazyPage";
import { reportClientError } from "./utils/clientError";
import { isChunkLoadError } from "./utils/chunkError";

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
  "/help": () => import("./pages/Help"),
  "/m/tasks": () => import("./mobile/MTasks"),
  "/m/pipeline": () => import("./mobile/MPipeline"),
  "/m/talents": () => import("./mobile/MTalents"),
  "/m/interviews": () => import("./mobile/MInterviews"),
  "/m/funnel": () => import("./mobile/MFunnel"),
} as const;

export type PagePath = keyof typeof pageLoaders;

/**
 * 预取失败只报第一次。
 *
 * 一个过期标签页里，Layout 的空闲预取会每 400ms 试一个菜单，20 多个页面连着失败——
 * 每次都写一条审计纯属灌表，而一条就足够定位问题了（消息里带具体 path）。
 * 用模块级标记而不是 60 秒窗口：本页面生命周期内失败过一次，后面的失败都是同一个原因。
 */
let prefetchFailureReported = false;

/** 预取某路由的 chunk（幂等）。路径不在表里（如 /talents/:id）时做前缀归一。 */
export function prefetchPage(path: string): void {
  const key = normalizePageKey(path);
  const loader = key ? pageLoaders[key as PagePath] : undefined;
  if (!loader) return;
  loader().catch((err: unknown) => {
    // 预取失败用户完全无感（真去访问时会重新走 lazyPage），但这是「标签页已经过期」
    // 的最早信号——比等用户点到那个菜单早得多，必须留痕。
    //
    // ⚠️ 这里**绝不能**自动刷新：用户可能正在填表单，为了一个后台预取失败就把整页
    //    刷掉是不可接受的。刷新只在用户真正要用那个页面时才发生（见 lazyPage）。
    const error = err instanceof Error ? err : new Error(String(err));
    if (!prefetchFailureReported && isChunkLoadError(error)) {
      prefetchFailureReported = true;
      reportClientError(new Error(`预取 chunk 失败 ${key}：${error.message}`));
    }
  });
}

/** "/talents/123" → "/talents"；"/talents/detail" 保持不变（详情页单独一个 chunk） */
function normalizePageKey(path: string): string {
  const p = path.split("?")[0].replace(/\/+$/, "") || "/";
  if (p === "/talents/detail") return p;
  if (p.startsWith("/talents/")) return "/talents";
  return p;
}

// ── 页面组件：App 路由直接用 ──────────────────────────────────────────
// 传路径名进去只为了上报时能说清「哪个页面没加载出来」（location 在多标签/预取
// 场景下未必指向它）。
const page = (p: PagePath) => lazyPage(pageLoaders[p], p);

export const Login = page("/login");
export const Tasks = page("/tasks");
export const Funnel = page("/funnel");
export const Jobs = page("/jobs");
export const Requisitions = page("/requisitions");
export const Pipeline = page("/pipeline");
export const Interviews = page("/interviews");
export const Approvals = page("/approvals");
export const Onboarding = page("/onboarding");
export const TalentList = page("/talents");
export const TalentDetail = page("/talents/detail");
export const Profiles = page("/profiles");
export const Match = page("/match");
export const AiAssistant = page("/ai-assistant");
export const TemplateLibrary = page("/templates");
export const Contracts = page("/contracts");
export const Social = page("/social");
export const Roles = page("/roles");
export const Users = page("/users");
export const Team = page("/team");
export const Settings = page("/settings");
export const Logs = page("/logs");
export const Help = page("/help");
export const MTasks = page("/m/tasks");
export const MPipeline = page("/m/pipeline");
export const MTalents = page("/m/talents");
export const MInterviews = page("/m/interviews");
export const MFunnel = page("/m/funnel");
