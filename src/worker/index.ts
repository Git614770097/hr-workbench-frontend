import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { getCookie } from "hono/cookie";
import { authRoutes } from "./routes/auth";
import { talentRoutes } from "./routes/talents";
import { templateRoutes } from "./routes/templates";
import { roleRoutes } from "./routes/roles";
import { jobRoutes } from "./routes/jobs";
import { pipelineRoutes } from "./routes/pipeline";
import { interviewRoutes } from "./routes/interviews";
import { requisitionRoutes } from "./routes/requisitions";
import { approvalRoutes } from "./routes/approvals";
import { onboardingRoutes } from "./routes/onboarding";
import { taskRoutes } from "./routes/tasks";
import aiParseRoutes from "./routes/aiParse";
import matchRoutes from "./routes/match";
import aiAssistRoutes from "./routes/aiAssist";
import teamRoutes from "./routes/team";
import { overview } from "./routes/overview";
import logsRoutes, { purgeOldUsage } from "./routes/logs";
import { backgroundRoutes } from "./routes/background";
import { auditRoutes } from "./routes/audit";
import { feishuRoutes } from "./routes/feishu";
import { writeAudit } from "./audit";
import { parsePermissions } from "./permissions";
import { runReminders, freezeExpiredAccounts } from "./reminders";
import { sessionGet } from "./kv";
import type { SessionInfo } from "./routes/auth";

export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  ASSETS: Fetcher;
  RESUMES: KVNamespace;
  DEEPSEEK_API_KEY?: string;
  /** 智谱 GLM Key（wrangler secret put ZHIPU_API_KEY）：配了就优先走免费的 GLM-4.7-Flash，
   *  429/异常时自动回落 DEEPSEEK_API_KEY。未配置则行为与旧版一致，只走 DeepSeek。 */
  ZHIPU_API_KEY?: string;
  /** 用户自有 AI Key 的加密主密钥（wrangler secret put AI_KEY_SECRET）；未配置则关闭自定义 Key 功能 */
  AI_KEY_SECRET?: string;
  PUSHPLUS_TOKEN?: string;
  // 阿里云「短信认证」（号码认证服务 Dypnsapi）——个人实名即可用
  ALIBABA_CLOUD_ACCESS_KEY_ID?: string;
  ALIBABA_CLOUD_ACCESS_KEY_SECRET?: string;
  ALIBABA_SMS_SIGN_NAME?: string;
  ALIBABA_SMS_TEMPLATE_CODE?: string;
}

const app = new Hono<{ Bindings: Env }>();

// ---- 统一错误出口 ----
// 关键：大量 handler 里直接 `await c.req.json()`，请求体为空/非法 JSON 时会抛
// SyntaxError，被 Hono 默认处理器兜成 500「Internal Server Error」——用户看到的是
// 一句英文报错而不是「参数不合法」。这里统一拦截：解析类错误回 400，其余回 500，
// 且都返回结构化中文 message，前端可直接 toast 展示。
app.onError((err, c) => {
  const isJsonParse =
    err instanceof SyntaxError ||
    /JSON|Unexpected end of|unexpected token/i.test(err?.message || "");
  if (isJsonParse) {
    return c.json({ error: "请求参数格式不正确" }, 400);
  }
  console.error("[api] unhandled error:", err);
  return c.json({ error: "服务器开小差了，请稍后重试" }, 500);
});

app.use("*", logger());
app.use("/api/*", cors());

// ---- 冻结账户写操作守卫 ----
// 到期未续费的账号 status='frozen'，允许登录但只能查看（read-only）。
// 这里对所有非 GET 的业务写请求做硬拦截：frozen 且非 admin → 403。
// 放行：自身账号安全类（改密码 / 配置 pushplus）；admin 永远放行。
app.use("/api/*", async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  const token = getCookie(c, "token") || c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return next();
  const sessionRaw = await sessionGet(c.env, token);
  if (!sessionRaw) return next();
  let session: { role: string; userId: string };
  try { session = JSON.parse(sessionRaw); } catch { return next(); }
  if (session.role === "admin") return next();
  const path = c.req.path;
  // 所有 /api/auth/* 一律放行（登录/退出/注册/改密码/申请开通/配置 pushplus 等自服务接口）：
  // 冻结用户浏览器里可能残留旧 token，登录/退出请求会自动带上它；若这里拦截，冻结用户
  // 会连「重新登录换账号」都被 403，卡死在只读会话里。业务数据写操作（talents/jobs/…）仍受约束。
  if (path.startsWith("/api/auth/")) return next();
  const u = await c.env.DB.prepare("SELECT status FROM users WHERE id = ?").bind(session.userId).first<{ status: string | null }>();
  if (u && u.status === "frozen") {
    return c.json({ error: "账户已冻结，仅可查看；续费后恢复使用", code: "FROZEN" }, 403);
  }
  return next();
});

// ---- 操作审计中间件 ----
// 自动记录所有影响业务数据的写操作（POST/PUT/PATCH/DELETE，仅 2xx 入账），
// targetType 由路径推导；敏感**读**操作（简历/合同/背调报告预览、批量导出）
// 无法由中间件识别，在各自路由内显式调用 writeAudit（见 talents.ts / background.ts）。
// 跳过：埋点上报、验证码/AI 生成（量大且与数据安全无关）、以及失败请求（避免灌爆日志）。
const AUDIT_SKIP = [/^\/api\/logs/, /^\/api\/ai\//, /^\/api\/auth\/captcha/, /^\/api\/feishu\/event/, /^\/api\/feishu\/oauth/, /^\/api\/feishu\/test/];
const AUDIT_ACTION_BY_METHOD: Record<string, string> = { POST: "create", PUT: "update", PATCH: "update", DELETE: "delete" };
const AUDIT_TARGET_TYPE: Record<string, string> = {
  talents: "talent", jobs: "job", pipeline: "pipeline", interviews: "interview",
  approvals: "approval", onboarding: "onboarding", requisitions: "requisition",
  templates: "template", background: "bgcheck", team: "team", tasks: "task",
  match: "match", roles: "role", users: "user", auth: "auth",
};
app.use("/api/*", async (c, next) => {
  const action = AUDIT_ACTION_BY_METHOD[c.req.method];
  if (!action) return next();
  const path = c.req.path;
  if (AUDIT_SKIP.some((r) => r.test(path))) return next();

  await next();
  if (c.res.status >= 400) return;

  // 会话只从 KV 读快照（不额外查库，避免给每个写请求加一次 DB 往返）；
  // name/role 快照对「当时是谁操作的」这个审计目的已足够。
  const token = getCookie(c, "token") || c.req.header("Authorization")?.replace("Bearer ", "");
  let session: SessionInfo | null = null;
  if (token) {
    const raw = await sessionGet(c.env, token);
    if (raw) { try { session = JSON.parse(raw) as SessionInfo; } catch { /* 解析失败按匿名记 */ } }
  }

  const parts = path.split("/");
  const targetId = parts[3] ? decodeURIComponent(parts[3]) : null;
  const targetType = AUDIT_TARGET_TYPE[parts[2] || ""] || parts[2] || "unknown";
  await writeAudit(c.env, session, {
    action,
    targetType,
    targetId,
    detail: { method: c.req.method, path },
    ip: c.req.header("cf-connecting-ip") || "",
    ua: c.req.header("user-agent") || "",
  });
});

// ---- 菜单权限拦截 ----
// 各业务路径通过下面的 app.use(...) 显式绑定菜单 key 做校验，
// admin 永远放行；普通用户需在角色 permissions 中包含该菜单。

async function menuGuard(c: any, menuKey: string) {
  const token = getCookie(c, "token") || c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return c.json({ error: "未登录" }, 401);
  const sessionRaw = await sessionGet(c.env, token);
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

// 人才库 / 模板 的路径前缀即菜单 key。
// 合同管理（/api/talents/contracts/*）与社保公积金（/api/talents/social/*）
// 已从 talents 拆为独立菜单权限，必须在「同一个中间件内」分流：
// Hono 的 "/api/talents/*" 也匹配裸路径 /api/talents，若各自再注册一个 app.use，
// 两个守卫会叠加执行 → 变成「必须同时拥有两个权限」才放行。
app.use("/api/talents/*", async (c, next) => {
  const p = c.req.path;
  const menuKey = p.startsWith("/api/talents/contracts")
    ? "contracts"
    : p.startsWith("/api/talents/social")
      ? "social"
      : "talents";
  const blocked = await menuGuard(c, menuKey);
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
// 面试管理：与「招聘看板」同权限（面试就是看板阶段的延伸，看不了看板也用不了面试）
app.use("/api/interviews/*", async (c, next) => {
  const blocked = await menuGuard(c, "interviews");
  if (blocked) return blocked;
  return next();
});
app.use("/api/interviews", async (c, next) => {
  const blocked = await menuGuard(c, "interviews");
  if (blocked) return blocked;
  return next();
});
// 招聘需求 / 审批 / 入职办理：与「招聘看板」同权限
for (const p of ["/api/requisitions", "/api/approvals", "/api/onboarding"]) {
  app.use(`${p}/*`, async (c, next) => {
    const blocked = await menuGuard(c, "pipeline");
    if (blocked) return blocked;
    return next();
  });
  app.use(p, async (c, next) => {
    const blocked = await menuGuard(c, "pipeline");
    if (blocked) return blocked;
    return next();
  });
}

// 候选人背调中心：独立菜单权限（background）
for (const p of ["/api/background"]) {
  app.use(`${p}/*`, async (c, next) => {
    const blocked = await menuGuard(c, "background");
    if (blocked) return blocked;
    return next();
  });
  app.use(p, async (c, next) => {
    const blocked = await menuGuard(c, "background");
    if (blocked) return blocked;
    return next();
  });
}
// 招聘漏斗：与「招聘看板」同源数据，但页面是独立菜单。
// 只统计、不修改数据，因此不额外要求 funnel 权限 ——
// 有 pipeline 权限即可查看（避免存量角色看不到数据）。
// 注：路由为 /api/pipeline/funnel，已被上面 /api/pipeline/* 覆盖。
// 待办日历
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
// 人才AI匹配：独立菜单「人才画像」+ 匹配页，权限跟随 profiles
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
// 团队管理：admin / manager 可用（manager 在路由内部再限定本团队）。
// 注意："/api/team/*" 同时匹配裸 /api/team，无需再注册一份（会叠加执行）。
app.use("/api/team/*", async (c, next) => {
  const token = getCookie(c, "token") || c.req.header("Authorization")?.replace("Bearer ", "");
  const sessionRaw = token ? await sessionGet(c.env, token) : null;
  if (!sessionRaw) return c.json({ error: "未登录" }, 401);
  let session: { role: string };
  try { session = JSON.parse(sessionRaw); } catch { return c.json({ error: "未登录" }, 401); }
  if (session.role !== "admin" && session.role !== "manager") return c.json({ error: "无权限，仅管理员可操作" }, 403);
  return next();
});
// 角色管理仅 admin（roles 路由内部已校验 admin，这里也拦一层双保险）
app.use("/api/roles/*", async (c, next) => {
  const token = getCookie(c, "token") || c.req.header("Authorization")?.replace("Bearer ", "");
  const sessionRaw = token ? await sessionGet(c.env, token) : null;
  if (!sessionRaw) return c.json({ error: "未登录" }, 401);
  let session: { role: string };
  try { session = JSON.parse(sessionRaw); } catch { return c.json({ error: "未登录" }, 401); }
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可操作" }, 403);
  return next();
});

// AI 提效（简历解读 / 沟通文案 / 面试问题 / 综合评估）：
// 不新增菜单，权限按业务语义分流——文案与简历解读属「人才库」，
// 面试问题与综合评估属「面试管理」。
// ⚠️ 必须在**同一个中间件内**按 path 分流：Hono 的 "/api/ai/*" 也匹配裸 /api/ai，
// 若拆成两个 app.use 会叠加执行，变成「必须同时拥有两个权限」才放行。
app.use("/api/ai/*", async (c, next) => {
  const p = c.req.path;
  const menuKey =
    p.startsWith("/api/ai/outreach") || p.startsWith("/api/ai/resume-insight")
      ? "talents" // 沟通文案 / 简历解读：人才库语义，跟随 talents 权限
      : p.startsWith("/api/ai/job-draft") || p.startsWith("/api/ai/job-diagnosis")
        ? "jobs" // JD 起草/优化与岗位诊断：岗位管理语义，跟随 jobs 权限
      : p.startsWith("/api/ai/talent-inventory")
        ? "talents" // AI 人才储备盘点：人才库语义，跟随 talents 权限
        : p.startsWith("/api/ai/recap-report") || p.startsWith("/api/ai/onboard-checklist") || p.startsWith("/api/ai/weekly-report")
          ? "pipeline" // AI 招聘复盘 / 入职清单 / 招聘周报：招聘链路语义，跟随 pipeline 权限
        : p.startsWith("/api/ai/candidate-compare") || p.startsWith("/api/ai/offer-negotiation") || p.startsWith("/api/ai/sourcing-copy")
          ? "talents" // 候选人对比 / Offer 谈判话术 / 被动人才触达：人才库语义，跟随 talents 权限
          : p.startsWith("/api/ai/channel-advice")
            ? "jobs" // 招聘渠道建议：岗位管理语义，跟随 jobs 权限
            : p.startsWith("/api/ai/contract-review") || p.startsWith("/api/ai/probation-compliance")
              ? "contracts" // 合同风险审查 / 试用期合规：合同管理语义，跟随 contracts 权限
              : p.startsWith("/api/ai/social-reminder") || p.startsWith("/api/ai/tax-plan")
                ? "social" // 社保增减员提醒 / 个税筹划：社保公积金语义，跟随 social 权限
                : "interviews";
  const blocked = await menuGuard(c, menuKey);
  if (blocked) return blocked;
  return next();
});

// ---- API Routes ----
app.route("/api/auth", authRoutes);
app.route("/api/talents", talentRoutes);
app.route("/api/templates", templateRoutes);
app.route("/api/roles", roleRoutes);
app.route("/api/jobs", jobRoutes);
app.route("/api/pipeline", pipelineRoutes);
app.route("/api/interviews", interviewRoutes);
// 招聘需求 / 审批 / 入职办理 都挂在「岗位 + 看板」语义下，跟随 pipeline 权限
app.route("/api/requisitions", requisitionRoutes);
app.route("/api/approvals", approvalRoutes);
app.route("/api/onboarding", onboardingRoutes);
app.route("/api/tasks", taskRoutes);
app.route("/api/parse-resume", aiParseRoutes);
app.route("/api/match", matchRoutes);
app.route("/api/ai", aiAssistRoutes);
app.route("/api/team", teamRoutes);
app.route("/api/overview", overview);
// 使用日志（模块点击率）：鉴权在 logs.ts 内部按方法分流——
// POST /report 任何登录用户可上报（否则统计只覆盖管理员），GET 查询仅 admin。
// 因此这里**不能**挂 menuGuard：那会把普通用户的上报一并拦掉。
app.route("/api/logs", logsRoutes);
app.route("/api/background", backgroundRoutes);
// 操作审计：仅管理员（路由内部再校验 role）——数据合规的追溯面，不对外放开
app.route("/api/audit", auditRoutes);
// 飞书集成（BYOK）：鉴权在各路由内部按需分流——settings 仅 admin、oauth/test 需登录、
// event/oauth-callback 为飞书侧回调（公开，靠 state/验签保护）。故这里不挂 menuGuard。
app.route("/api/feishu", feishuRoutes);

// ---- Health check ----
app.get("/api/health", (c) =>
  c.json({ status: "ok", time: new Date().toISOString() })
);

// ---- 手动触发到期提醒推送（仅 admin，用于上线后立刻验收）----
app.get("/api/reminders/test", async (c) => {
  const token = getCookie(c, "token") || c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return c.json({ error: "未登录" }, 401);
  const sessionRaw = await sessionGet(c.env, token);
  if (!sessionRaw) return c.json({ error: "未登录" }, 401);
  let session: { role: string };
  try { session = JSON.parse(sessionRaw); } catch { return c.json({ error: "未登录" }, 401); }
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可操作" }, 403);

  const result = await runReminders(c.env);
  return c.json(result);
});

// ---- API 未匹配路径：明确返回 JSON 404 ----
// 必须放在下面 SPA 兜底之前。否则拼错的 /api/xxx 会落到静态资源兜底，
// 返回 index.html + 200，前端只看到 JSON 解析失败而不知道是路径写错了。
app.all("/api/*", (c) => c.json({ error: "接口不存在" }, 404));

// ---- Fallback to static assets (SPA) ----
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    await runReminders(env);
    await freezeExpiredAccounts(env);
    // 使用日志明细滚动清理（保留 30 天；聚合表不动）
    await purgeOldUsage(env);
  },
};
