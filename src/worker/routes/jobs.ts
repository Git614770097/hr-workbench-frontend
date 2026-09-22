import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { genId } from "../helpers";

const jobs = new Hono<{ Bindings: Env }>();

// 岗位字段白名单（动态拼 SET 用，避免把未传字段覆盖为 null）
const JOB_FIELDS = [
  "title", "department", "city", "job_type", "headcount", "priority", "status",
  "salary_range", "education", "experience", "description", "requirements",
  "opened_at", "closed_at",
] as const;

// ---- 岗位列表（搜索/筛选/分页）----
jobs.get("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const q = (c.req.query("q") || "").trim();
  const status = c.req.query("status");
  const department = (c.req.query("department") || "").trim();
  const priority = c.req.query("priority");
  const page = Math.max(parseInt(c.req.query("page") || "1", 10), 1);
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "10", 10), 1), 200);
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (session.role === "admin") {
    const ownerId = c.req.query("owner_id");
    if (ownerId) { conditions.push("j.owner_id = ?"); params.push(ownerId); }
  } else {
    conditions.push("j.owner_id = ?");
    params.push(session.userId);
  }

  if (q) {
    conditions.push("(j.title LIKE ? OR j.department LIKE ? OR j.description LIKE ? OR j.requirements LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (status) { conditions.push("j.status = ?"); params.push(status); }
  if (department) { conditions.push("j.department LIKE ?"); params.push(`%${department}%`); }
  if (priority) { conditions.push("j.priority = ?"); params.push(priority); }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  const countResult = await c.env.DB.prepare(`SELECT COUNT(*) as total FROM jobs j ${where}`)
    .bind(...params).first<{ total: number }>();

  // 候选人统计：candidates = 关联候选人总数，hired = 已入职数
  const rows = await c.env.DB.prepare(`
    SELECT j.*, u.name as owner_name,
      (SELECT COUNT(*) FROM talent_jobs tj WHERE tj.job_id = j.id) as candidates,
      (SELECT COUNT(*) FROM talent_jobs tj WHERE tj.job_id = j.id AND tj.stage = 'hired') as hired,
      (SELECT COUNT(*) FROM talent_jobs tj WHERE tj.job_id = j.id AND tj.stage NOT IN ('rejected','withdrawn','hired')) as active_count
    FROM jobs j JOIN users u ON j.owner_id = u.id
    ${where}
    ORDER BY
      CASE j.status WHEN 'open' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
      CASE j.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
      j.updated_at DESC
    LIMIT ? OFFSET ?
  `).bind(...params, limit, offset).all();

  const total = countResult?.total || 0;
  return c.json({ items: rows.results, total, page, limit, pages: Math.ceil(total / limit) });
});

// ---- 在招岗位精简列表（下拉选择用，不分页）----
jobs.get("/options", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  let sql = "SELECT id, title, department, city, status, headcount FROM jobs";
  const params: string[] = [];
  const onlyOpen = c.req.query("open") === "1";
  const cond: string[] = [];
  if (session.role !== "admin") { cond.push("owner_id = ?"); params.push(session.userId); }
  if (onlyOpen) cond.push("status = 'open'");
  if (cond.length) sql += " WHERE " + cond.join(" AND ");
  sql += " ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, updated_at DESC";

  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(rows.results);
});

// ---- 部门列表（筛选下拉 + 表单自动补全）----
jobs.get("/departments", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  let sql = "SELECT DISTINCT department FROM jobs WHERE department IS NOT NULL AND department != ''";
  const params: string[] = [];
  if (session.role !== "admin") { sql += " AND owner_id = ?"; params.push(session.userId); }
  sql += " ORDER BY department";

  const rows = await c.env.DB.prepare(sql).bind(...params).all<{ department: string }>();
  return c.json(rows.results.map((r) => r.department));
});

// ---- 岗位详情（含候选人列表）----
jobs.get("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  let sql = "SELECT j.*, u.name as owner_name FROM jobs j JOIN users u ON j.owner_id = u.id WHERE j.id = ?";
  const params: string[] = [id];
  if (session.role !== "admin") { sql += " AND j.owner_id = ?"; params.push(session.userId); }

  const job = await c.env.DB.prepare(sql).bind(...params).first<any>();
  if (!job) return c.json({ error: "岗位不存在" }, 404);

  const candidates = await c.env.DB.prepare(`
    SELECT tj.id as link_id, tj.stage, tj.rating, tj.notes, tj.created_at as linked_at, tj.updated_at,
           t.id as talent_id, t.name, t.phone, t.email, t.current_title, t.current_company,
           t.years_experience, t.education, t.city, t.age, t.resume_url
    FROM talent_jobs tj JOIN talents t ON tj.talent_id = t.id
    WHERE tj.job_id = ?
    ORDER BY tj.updated_at DESC
  `).bind(id).all();

  const counts: Record<string, number> = {};
  for (const r of candidates.results as any[]) {
    counts[r.stage] = (counts[r.stage] || 0) + 1;
  }

  return c.json({ ...job, candidates: candidates.results, stage_counts: counts });
});

// ---- 新增岗位 ----
jobs.post("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const body = await c.req.json<any>();
  if (!body.title || !String(body.title).trim()) return c.json({ error: "岗位名称为必填" }, 400);

  const id = genId();
  await c.env.DB.prepare(`
    INSERT INTO jobs (id, owner_id, title, department, city, job_type, headcount, priority, status,
      salary_range, education, experience, description, requirements, opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, session.userId, String(body.title).trim(), body.department || null, body.city || null,
    body.job_type || "fulltime", body.headcount ?? 1, body.priority || "normal", body.status || "open",
    body.salary_range || null, body.education || null, body.experience || null,
    body.description || null, body.requirements || null,
    body.opened_at || new Date().toISOString().slice(0, 10)
  ).run();

  return c.json({ id });
});

// ---- 编辑岗位 ----
jobs.put("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  let checkSql = "SELECT id, status FROM jobs WHERE id = ?";
  const checkParams: string[] = [id];
  if (session.role !== "admin") { checkSql += " AND owner_id = ?"; checkParams.push(session.userId); }
  const existing = await c.env.DB.prepare(checkSql).bind(...checkParams).first<{ id: string; status: string }>();
  if (!existing) return c.json({ error: "岗位不存在" }, 404);

  const body = await c.req.json<any>();

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const f of JOB_FIELDS) {
    if (body[f] !== undefined) {
      sets.push(`${f} = ?`);
      params.push(body[f] === "" ? null : body[f]);
    }
  }
  // 关闭岗位时自动记录关闭日期；重新开放则清空
  if (body.status !== undefined && body.closed_at === undefined) {
    if (body.status === "closed" && existing.status !== "closed") {
      sets.push("closed_at = ?");
      params.push(new Date().toISOString().slice(0, 10));
    } else if (body.status !== "closed" && existing.status === "closed") {
      sets.push("closed_at = ?");
      params.push(null);
    }
  }
  if (sets.length === 0) return c.json({ id });

  await c.env.DB.prepare(`UPDATE jobs SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...params, id).run();
  return c.json({ id });
});

// ---- 删除岗位（连带清理候选人关联与待办引用）----
jobs.delete("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  let checkSql = "SELECT id FROM jobs WHERE id = ?";
  const checkParams: string[] = [id];
  if (session.role !== "admin") { checkSql += " AND owner_id = ?"; checkParams.push(session.userId); }
  const existing = await c.env.DB.prepare(checkSql).bind(...checkParams).first();
  if (!existing) return c.json({ error: "岗位不存在" }, 404);

  await c.env.DB.prepare("DELETE FROM job_stage_logs WHERE talent_job_id IN (SELECT id FROM talent_jobs WHERE job_id = ?)").bind(id).run();
  await c.env.DB.prepare("DELETE FROM talent_jobs WHERE job_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM jobs WHERE id = ?").bind(id).run();
  // 待办不删，只解除岗位关联，保留跟进记录
  await c.env.DB.prepare("UPDATE talent_tasks SET job_id = NULL WHERE job_id = ?").bind(id).run();

  return c.json({ ok: true });
});

export { jobs as jobRoutes };
