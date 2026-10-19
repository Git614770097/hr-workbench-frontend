import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { ownerScope, scopeConds, scopeParams, canTouch } from "../scope";
import { genId } from "../helpers";

const requisitions = new Hono<{ Bindings: Env }>();

const REQ_STATUS_LABEL: Record<string, string> = {
  pending: "待处理",
  approved: "已转岗",
  rejected: "已驳回",
  closed: "已作废",
};
const PRIORITY_LABEL: Record<string, string> = { high: "高", normal: "中", low: "低" };

function decorate(r: any) {
  return {
    ...r,
    status_label: REQ_STATUS_LABEL[r.status] || r.status,
    priority_label: PRIORITY_LABEL[r.priority] || r.priority,
  };
}

/** 招聘需求列表（普通用户只看自己创建的；admin 看全部） */
requisitions.get("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const conditions: string[] = [];
  const params: string[] = [];
  conditions.push(...scopeConds(session));
  params.push(...scopeParams(session));
  if (session.role === "admin") {
    const ownerId = c.req.query("owner_id");
    if (ownerId) { conditions.push("owner_id = ?"); params.push(ownerId); }
  }
  const status = c.req.query("status");
  if (status) { conditions.push("status = ?"); params.push(status); }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
  const rows = await c.env.DB.prepare(
    `SELECT * FROM requisitions ${where} ORDER BY (status='pending') DESC, created_at DESC`
  ).bind(...params).all();
  return c.json({ items: (rows.results || []).map(decorate) });
});

/** 新建招聘需求 */
requisitions.post("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  let b: any;
  try { b = await c.req.json(); } catch { return c.json({ error: "请求参数格式不正确" }, 400); }

  if (!b.department || !String(b.department).trim()) return c.json({ error: "请填写需求部门" }, 400);
  if (!b.title || !String(b.title).trim()) return c.json({ error: "请填写拟招岗位名称" }, 400);

  const id = genId();
  await c.env.DB.prepare(`
    INSERT INTO requisitions (id, owner_id, department, title, headcount, job_type, city,
                              salary_range, education, experience, reason, expect_date, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, session.userId,
    String(b.department).trim(),
    String(b.title).trim(),
    b.headcount || 1,
    b.job_type || "fulltime",
    b.city || null,
    b.salary_range || null,
    b.education || null,
    b.experience || null,
    b.reason || null,
    b.expect_date || null,
    b.priority || "normal"
  ).run();
  return c.json({ ok: true, id });
});

/**
 * 需求转正式岗位：自动生成 jobs 记录并回填 job_id。
 * 无审批流 —— 数据范围内（自己或同团队）的用户均可操作。
 */
requisitions.post("/:id/convert", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  const req = await c.env.DB.prepare("SELECT * FROM requisitions WHERE id = ?").bind(id).first<any>();
  if (!req) return c.json({ error: "需求不存在" }, 404);
  if (req.status !== "pending") return c.json({ error: "该需求已处理过" }, 400);
  if (!(await canTouch(c.env, session, req.owner_id))) {
    return c.json({ error: "无权限，只能操作自己范围内的需求" }, 403);
  }

  let b: any = {};
  try { b = await c.req.json(); } catch { /* 允许空 body */ }

  // 生成正式岗位（owner 归需求创建人）
  const jobId = genId();
  await c.env.DB.prepare(`
    INSERT INTO jobs (id, owner_id, title, department, city, job_type, headcount, priority,
                      status, salary_range, education, experience, description, opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
  `).bind(
    jobId, req.owner_id, req.title, req.department, req.city, req.job_type,
    req.headcount || 1, req.priority || "normal",
    req.salary_range || null, req.education || null, req.experience || null,
    req.reason || null,
    new Date().toISOString().slice(0, 10)
  ).run();

  await c.env.DB.prepare(
    "UPDATE requisitions SET status='approved', job_id=?, approved_at=datetime('now'), updated_at=datetime('now') WHERE id=?"
  ).bind(jobId, id).run();

  return c.json({ ok: true, job_id: jobId });
});

/** 编辑需求：仅 pending 状态可改，且只能改自己创建的（同团队亦可） */
requisitions.put("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  const req = await c.env.DB.prepare("SELECT * FROM requisitions WHERE id = ?").bind(id).first<any>();
  if (!req) return c.json({ error: "需求不存在" }, 404);
  if (req.status !== "pending") return c.json({ error: "仅待处理状态可编辑" }, 400);
  if (!(await canTouch(c.env, session, req.owner_id))) {
    return c.json({ error: "无权限，只能编辑自己提交的需求" }, 403);
  }

  let b: any;
  try { b = await c.req.json(); } catch { return c.json({ error: "请求参数格式不正确" }, 400); }

  // 只允许更新业务字段，状态/审批相关字段不动
  const fields = ["department", "title", "headcount", "job_type", "city", "salary_range", "education", "experience", "reason", "expect_date", "priority"];
  const sets: string[] = [];
  const vals: any[] = [];
  for (const f of fields) {
    if (b[f] !== undefined) {
      sets.push(`${f} = ?`);
      vals.push(b[f] === "" ? null : b[f]);
    }
  }
  if (sets.length === 0) return c.json({ ok: true });
  sets.push("updated_at = datetime('now')");
  vals.push(id);

  await c.env.DB.prepare(`UPDATE requisitions SET ${sets.join(", ")} WHERE id = ?`).bind(...vals).run();
  return c.json({ ok: true });
});

/** 撤回需求：仅 pending 状态可撤回，撤回后 status=closed（终态，不再处理） */
requisitions.post("/:id/withdraw", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  const req = await c.env.DB.prepare("SELECT owner_id, status FROM requisitions WHERE id = ?").bind(id).first<{ owner_id: string; status: string }>();
  if (!req) return c.json({ error: "需求不存在" }, 404);
  if (req.status !== "pending") return c.json({ error: "仅待处理状态可撤回" }, 400);
  if (!(await canTouch(c.env, session, req.owner_id))) {
    return c.json({ error: "无权限，只能撤回自己提交的需求" }, 403);
  }

  await c.env.DB.prepare(
    "UPDATE requisitions SET status='closed', updated_at=datetime('now') WHERE id=?"
  ).bind(id).run();
  return c.json({ ok: true });
});

export { requisitions as requisitionRoutes };
