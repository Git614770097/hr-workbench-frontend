import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";

const pipeline = new Hono<{ Bindings: Env }>();

function genId(): string { return crypto.randomUUID(); }

// 阶段定义与前端 types.ts 的 PIPELINE_STAGES 保持一致
const STAGES = ["screening", "interview1", "interview2", "offer", "hired", "rejected", "withdrawn"] as const;
type Stage = (typeof STAGES)[number];

// 终态：不再计入「进行中」
const TERMINAL: Stage[] = ["hired", "rejected", "withdrawn"];

// ---- 看板：按阶段返回候选人 ----
// 查询参数：job_id（可选，不传=全部岗位）、owner_id（可选，管理员用）、q（姓名搜索）
pipeline.get("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const jobId = c.req.query("job_id");
  const ownerId = c.req.query("owner_id");
  const q = (c.req.query("q") || "").trim();

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  // 普通用户只看自己创建的人才；管理员可看全部或按创建人过滤
  if (session.role !== "admin") {
    conditions.push("t.owner_id = ?");
    params.push(session.userId);
  } else if (ownerId) {
    conditions.push("t.owner_id = ?");
    params.push(ownerId);
  }

  if (jobId) { conditions.push("tj.job_id = ?"); params.push(jobId); }
  if (q) {
    conditions.push("(t.name LIKE ? OR t.current_title LIKE ? OR t.current_company LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  const rows = await c.env.DB.prepare(`
    SELECT tj.id as link_id, tj.stage, tj.rating, tj.notes as stage_notes, tj.updated_at as stage_updated_at,
           t.id as talent_id, t.name, t.phone, t.current_title, t.current_company,
           t.years_experience, t.education, t.city, t.resume_url, t.source,
           j.id as job_id, j.title as job_title, j.department as job_department, j.city as job_city,
           u.name as owner_name
    FROM talent_jobs tj
    JOIN talents t ON tj.talent_id = t.id
    LEFT JOIN jobs j ON tj.job_id = j.id
    JOIN users u ON t.owner_id = u.id
    ${where}
    ORDER BY tj.updated_at DESC
  `).bind(...params).all();

  // 按阶段归组，同时给出每阶段计数与「停留天数」
  const today = Date.now();
  const columns: Record<string, any[]> = {};
  for (const s of STAGES) columns[s] = [];

  for (const r of rows.results as any[]) {
    if (!columns[r.stage]) columns[r.stage] = [];
    const updated = r.stage_updated_at ? new Date(r.stage_updated_at + "Z").getTime() : today;
    columns[r.stage].push({
      ...r,
      days_in_stage: Math.max(0, Math.floor((today - updated) / 86400000)),
    });
  }

  const stats = {
    total: rows.results.length,
    active: (rows.results as any[]).filter((r) => !TERMINAL.includes(r.stage)).length,
    hired: (rows.results as any[]).filter((r) => r.stage === "hired").length,
    rejected: (rows.results as any[]).filter((r) => r.stage === "rejected").length,
  };

  return c.json({ columns, stats });
});

// ---- 统计：面试中停留过久的候选人（>7 天）----
// 放在 /:linkId 之前，避免 "stale" 被当作 linkId 匹配。
pipeline.get("/stale", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const conditions: string[] = ["tj.stage NOT IN ('hired','rejected','withdrawn')"];
  const params: (string | number)[] = [];
  if (session.role !== "admin") {
    conditions.push("t.owner_id = ?");
    params.push(session.userId);
  }

  const rows = await c.env.DB.prepare(`
    SELECT tj.id as link_id, tj.stage, tj.updated_at as stage_updated_at,
           t.id as talent_id, t.name, j.title as job_title
    FROM talent_jobs tj
    JOIN talents t ON tj.talent_id = t.id
    LEFT JOIN jobs j ON tj.job_id = j.id
    WHERE ${conditions.join(" AND ")}
  `).bind(...params).all();

  const today = Date.now();
  const items = (rows.results as any[])
    .map((r) => ({
      ...r,
      days_stale: Math.floor((today - new Date(r.stage_updated_at + "Z").getTime()) / 86400000),
    }))
    .filter((r) => r.days_stale >= 7)
    .sort((a, b) => b.days_stale - a.days_stale);

  return c.json({ items, total: items.length });
});

// ---- 把人才加入岗位（创建候选人关联）----
pipeline.post("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const body = await c.req.json<{ talent_id?: string; job_id?: string; stage?: Stage; notes?: string }>();
  if (!body.talent_id || !body.job_id) return c.json({ error: "人才和岗位均为必填" }, 400);

  // 权限校验：普通用户只能操作自己的人才；岗位也须可见
  let tSql = "SELECT id, name FROM talents WHERE id = ?";
  const tParams: string[] = [body.talent_id];
  if (session.role !== "admin") { tSql += " AND owner_id = ?"; tParams.push(session.userId); }
  const talent = await c.env.DB.prepare(tSql).bind(...tParams).first<{ id: string; name: string }>();
  if (!talent) return c.json({ error: "人才不存在或无权限" }, 404);

  let jSql = "SELECT id, title FROM jobs WHERE id = ?";
  const jParams: string[] = [body.job_id];
  if (session.role !== "admin") { jSql += " AND owner_id = ?"; jParams.push(session.userId); }
  const job = await c.env.DB.prepare(jSql).bind(...jParams).first<{ id: string; title: string }>();
  if (!job) return c.json({ error: "岗位不存在或无权限" }, 404);

  const dup = await c.env.DB.prepare("SELECT id FROM talent_jobs WHERE talent_id = ? AND job_id = ?")
    .bind(body.talent_id, body.job_id).first();
  if (dup) return c.json({ error: "该人才已在此岗位的招聘流程中" }, 409);

  const id = genId();
  const stage: Stage = STAGES.includes(body.stage as Stage) ? (body.stage as Stage) : "screening";
  await c.env.DB.prepare("INSERT INTO talent_jobs (id, talent_id, job_id, stage, notes) VALUES (?, ?, ?, ?, ?)")
    .bind(id, body.talent_id, body.job_id, stage, body.notes || null).run();

  await c.env.DB.prepare("INSERT INTO job_stage_logs (id, talent_job_id, from_stage, to_stage, user_id, remark) VALUES (?, ?, NULL, ?, ?, ?)")
    .bind(genId(), id, stage, session.userId, "加入招聘流程").run();

  // 同步人才全局阶段（若是新录入状态）
  await c.env.DB.prepare("UPDATE talents SET stage = CASE WHEN stage IN ('new','archived') OR stage IS NULL THEN ? ELSE stage END, updated_at = datetime('now') WHERE id = ?")
    .bind(stage === "screening" ? "screening" : stage, body.talent_id).run();

  return c.json({ id, talent_name: talent.name, job_title: job.title, stage });
});

// ---- 切换候选人阶段（看板拖拽 / 下拉）----
pipeline.put("/:linkId/stage", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const linkId = c.req.param("linkId");
  const body = await c.req.json<{ stage?: string; remark?: string; rating?: number }>();
  if (!body.stage || !STAGES.includes(body.stage as Stage)) return c.json({ error: "阶段值不合法" }, 400);

  // 权限校验
  const link = await c.env.DB.prepare(`
    SELECT tj.id, tj.stage as old_stage, tj.talent_id, tj.job_id, t.owner_id
    FROM talent_jobs tj JOIN talents t ON tj.talent_id = t.id WHERE tj.id = ?
  `).bind(linkId).first<any>();
  if (!link) return c.json({ error: "候选人记录不存在" }, 404);
  if (session.role !== "admin" && link.owner_id !== session.userId) {
    return c.json({ error: "无权限" }, 403);
  }
  if (link.old_stage === body.stage) return c.json({ ok: true, stage: body.stage });

  await c.env.DB.prepare("UPDATE talent_jobs SET stage = ?, rating = COALESCE(?, rating), updated_at = datetime('now') WHERE id = ?")
    .bind(body.stage, body.rating ?? null, linkId).run();

  await c.env.DB.prepare("INSERT INTO job_stage_logs (id, talent_job_id, from_stage, to_stage, user_id, remark) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(genId(), linkId, link.old_stage, body.stage, session.userId, body.remark || null).run();

  // 阶段推进到「已入职」时，同步人才全局状态为 placed（已入职）
  if (body.stage === "hired") {
    await c.env.DB.prepare("UPDATE talents SET status = 'placed', stage = 'hired', updated_at = datetime('now') WHERE id = ?")
      .bind(link.talent_id).run();
  }

  return c.json({ ok: true, stage: body.stage });
});

// ---- 阶段流转历史 ----
pipeline.get("/:linkId/logs", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const linkId = c.req.param("linkId");
  const link = await c.env.DB.prepare(`
    SELECT tj.id, t.owner_id FROM talent_jobs tj JOIN talents t ON tj.talent_id = t.id WHERE tj.id = ?
  `).bind(linkId).first<any>();
  if (!link) return c.json({ error: "候选人记录不存在" }, 404);
  if (session.role !== "admin" && link.owner_id !== session.userId) return c.json({ error: "无权限" }, 403);

  const rows = await c.env.DB.prepare(`
    SELECT l.*, u.name as user_name FROM job_stage_logs l
    LEFT JOIN users u ON l.user_id = u.id
    WHERE l.talent_job_id = ? ORDER BY l.created_at DESC
  `).bind(linkId).all();

  return c.json(rows.results);
});

// ---- 从岗位移除候选人（同时清理待办关联）----
pipeline.delete("/:linkId", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const linkId = c.req.param("linkId");
  const link = await c.env.DB.prepare(`
    SELECT tj.id, t.owner_id FROM talent_jobs tj JOIN talents t ON tj.talent_id = t.id WHERE tj.id = ?
  `).bind(linkId).first<any>();
  if (!link) return c.json({ error: "候选人记录不存在" }, 404);
  if (session.role !== "admin" && link.owner_id !== session.userId) return c.json({ error: "无权限" }, 403);

  await c.env.DB.prepare("DELETE FROM job_stage_logs WHERE talent_job_id = ?").bind(linkId).run();
  await c.env.DB.prepare("DELETE FROM talent_jobs WHERE id = ?").bind(linkId).run();
  return c.json({ ok: true });
});

export { pipeline as pipelineRoutes };
