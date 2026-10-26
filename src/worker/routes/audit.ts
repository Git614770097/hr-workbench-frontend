import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { writeAudit } from "../audit";

const audit = new Hono<{ Bindings: Env }>();

// ---- 审计日志列表（仅管理员） ----
// 查询维度：时间范围(days) / 操作类型(action) / 对象类型(target_type) / 关键词(q) / 分页。
// 关键词匹配 target_name、user_name、detail(JSON 文本)——detail 是 JSON 串，
// LIKE 是粗匹配但够用于「找当时导出了谁」这类追溯。
audit.get("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可查看" }, 403);

  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(c.req.query("limit") || "50", 10) || 50));
  const offset = (page - 1) * limit;
  const action = (c.req.query("action") || "").trim();
  const targetType = (c.req.query("target_type") || "").trim();
  const q = (c.req.query("q") || "").trim();
  const days = Math.min(365, Math.max(1, parseInt(c.req.query("days") || "30", 10) || 30));

  // 时间范围用参数绑定而非拼接：datetime('now', ?) 接受 '-30 days' 这类修饰符。
  // 为什么不拼字符串：项目自带的 scripts/test-sql-refactor.mjs（C4）会扫描 SQL 里
  // 白名单外的模板变量并报错，而这里的 days 虽然已被 parseInt + Math.min/max 夹过，
  // 参数化是「连拼接都不需要」的更干净解，也不需要往白名单里加特例。
  const daysAgo = `-${days} days`;
  const conditions: string[] = [`ts >= datetime('now', ?)`];
  const params: (string | number)[] = [daysAgo];
  if (action) { conditions.push("action = ?"); params.push(action); }
  if (targetType) { conditions.push("target_type = ?"); params.push(targetType); }
  if (q) {
    const like = `%${q}%`;
    conditions.push("(target_name LIKE ? OR user_name LIKE ? OR detail LIKE ?)");
    params.push(like, like, like);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;

  const countResult = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM audit_logs ${where}`).bind(...params).first<{ total: number }>();
  const rows = await c.env.DB.prepare(`SELECT * FROM audit_logs ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`).bind(...params, limit, offset).all<Record<string, unknown>>();

  return c.json({
    items: rows.results || [],
    total: countResult?.total || 0,
    page,
    limit,
    pages: Math.ceil((countResult?.total || 0) / limit),
  });
});

// 客户端的「服务端无写操作」动作（Excel/PDF 导出是浏览器的内存操作），由前端显式上报。
// 为什么单独开一个端点：导出动作里包含全量人才数据，是最需要留痕的行为之一，
// 但它不影响任何数据库表，无法被上面的写操作中间件捕获。
audit.post("/client", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const b = await c.req.json<{ action?: string; targetType?: string; targetId?: string | null; targetName?: string | null; detail?: unknown }>().catch(() => null);
  const action = (b?.action || "export").slice(0, 20);
  const targetType = (b?.targetType || "unknown").slice(0, 30);
  await writeAudit(c.env, session, {
    action,
    targetType,
    targetId: b?.targetId ?? null,
    targetName: b?.targetName ?? null,
    detail: b?.detail ?? null,
    ip: c.req.header("cf-connecting-ip") || "",
    ua: c.req.header("user-agent") || "",
  });
  return c.json({ ok: true });
});

export { audit as auditRoutes };
