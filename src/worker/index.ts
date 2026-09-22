import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { getCookie } from "hono/cookie";
import { authRoutes } from "./routes/auth";
import { talentRoutes } from "./routes/talents";
import { communicationRoutes } from "./routes/communications";
import { templateRoutes } from "./routes/templates";
import { roleRoutes } from "./routes/roles";
import { jobRoutes } from "./routes/jobs";
import { pipelineRoutes } from "./routes/pipeline";
import { taskRoutes } from "./routes/tasks";
import aiParseRoutes from "./routes/aiParse";
import matchRoutes from "./routes/match";
import { parsePermissions } from "./permissions";

export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  ASSETS: Fetcher;
  RESUMES: KVNamespace;
  DEEPSEEK_API_KEY?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", logger());
app.use("/api/*", cors());

// ---- 菜单权限拦截 ----
// 各业务路径通过下面的 app.use(...) 显式绑定菜单 key 做校验，
// admin 永远放行；普通用户需在角色 permissions 中包含该菜单。

async function menuGuard(c: any, menuKey: string) {
  const token = getCookie(c, "token") || c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return c.json({ error: "未登录" }, 401);
  const sessionRaw = await c.env.SESSIONS.get(token);
  if (!sessionRaw) return c.json({ error: "未登录" }, 401);
  let session: { userId: string; role: string };
  try {
    session = JSON.parse(sessionRaw);
  } catch {
    return c.json({ error: "未登录" }, 401);
  }
  if (session.role === "admin") return null; // 管理员放行

  // 查用户角色权限
  const user = (await c.env.DB.prepare("SELECT role_id FROM users WHERE id = ?").bind(session.userId).first()) as { role_id: string | null } | null;
  if (!user) return c.json({ error: "用户不存在" }, 401);
  if (!user.role_id) return c.json({ error: "无权限访问该功能" }, 403);

  const role = (await c.env.DB.prepare("SELECT permissions FROM roles WHERE id = ?").bind(user.role_id).first()) as { permissions: string } | null;
  const perms = role ? parsePermissions(role.permissions) : [];
  if (!perms.includes(menuKey)) return c.json({ error: "无权限访问该功能" }, 403);
  return null;
}

// 人才库 / 模板 的路径前缀即菜单 key
app.use("/api/talents/*", async (c, next) => {
  const blocked = await menuGuard(c, "talents");
  if (blocked) return blocked;
  return next();
});
app.use("/api/templates/*", async (c, next) => {
  const blocked = await menuGuard(c, "templates");
  if (blocked) return blocked;
  return next();
});
// 岗位管理
app.use("/api/jobs/*", async (c, next) => {
  const blocked = await menuGuard(c, "jobs");
  if (blocked) return blocked;
  return next();
});
app.use("/api/jobs", async (c, next) => {
  const blocked = await menuGuard(c, "jobs");
  if (blocked) return blocked;
  return next();
});
// 招聘流程看板（与岗位管理同权限：没有岗位就看不了流程）
app.use("/api/pipeline/*", async (c, next) => {
  const blocked = await menuGuard(c, "pipeline");
  if (blocked) return blocked;
  return next();
});
app.use("/api/pipeline", async (c, next) => {
  const blocked = await menuGuard(c, "pipeline");
  if (blocked) return blocked;
  return next();
});
// 跟进待办
app.use("/api/tasks/*", async (c, next) => {
  const blocked = await menuGuard(c, "tasks");
  if (blocked) return blocked;
  return next();
});
app.use("/api/tasks", async (c, next) => {
  const blocked = await menuGuard(c, "tasks");
  if (blocked) return blocked;
  return next();
});
// 用户管理在 /api/auth/users 下（auth 路由里），单独拦
app.use("/api/auth/users/*", async (c, next) => {
  const blocked = await menuGuard(c, "users");
  if (blocked) return blocked;
  return next();
});
app.use("/api/auth/users", async (c, next) => {
  const blocked = await menuGuard(c, "users");
  if (blocked) return blocked;
  return next();
});
// AI 简历解析：与人才库同权限（导入简历属于人才库功能）
app.use("/api/parse-resume/*", async (c, next) => {
  const blocked = await menuGuard(c, "talents");
  if (blocked) return blocked;
  return next();
});
// 智能匹配：独立菜单「人物画像」+ 匹配页，权限跟随 profiles
app.use("/api/match/*", async (c, next) => {
  const blocked = await menuGuard(c, "profiles");
  if (blocked) return blocked;
  return next();
});
app.use("/api/match", async (c, next) => {
  const blocked = await menuGuard(c, "profiles");
  if (blocked) return blocked;
  return next();
});
// 角色管理仅 admin（roles 路由内部已校验 admin，这里也拦一层双保险）
app.use("/api/roles/*", async (c, next) => {
  const token = getCookie(c, "token") || c.req.header("Authorization")?.replace("Bearer ", "");
  const sessionRaw = token ? await c.env.SESSIONS.get(token) : null;
  if (!sessionRaw) return c.json({ error: "未登录" }, 401);
  let session: { role: string };
  try { session = JSON.parse(sessionRaw); } catch { return c.json({ error: "未登录" }, 401); }
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可操作" }, 403);
  return next();
});

// ---- API Routes ----
app.route("/api/auth", authRoutes);
app.route("/api/talents", talentRoutes);
app.route("/api/communications", communicationRoutes);
app.route("/api/templates", templateRoutes);
app.route("/api/roles", roleRoutes);
app.route("/api/jobs", jobRoutes);
app.route("/api/pipeline", pipelineRoutes);
app.route("/api/tasks", taskRoutes);
app.route("/api/parse-resume", aiParseRoutes);
app.route("/api/match", matchRoutes);

// ---- Health check ----
app.get("/api/health", (c) =>
  c.json({ status: "ok", time: new Date().toISOString() })
);

// ---- API 未匹配路径：明确返回 JSON 404 ----
// 必须放在下面 SPA 兜底之前。否则拼错的 /api/xxx 会落到静态资源兜底，
// 返回 index.html + 200，前端只看到 JSON 解析失败而不知道是路径写错了。
app.all("/api/*", (c) => c.json({ error: "接口不存在" }, 404));

// ---- Fallback to static assets (SPA) ----
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
