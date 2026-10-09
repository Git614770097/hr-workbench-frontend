import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { genId } from "../helpers";

const requisitions = new Hono<{ Bindings: Env }>();

const REQ_STATUS_LABEL: Record<string, string> = {
  pending: "待审批",
  approved: "已通过",
  rejected: "已驳回",
  closed: "已关闭",
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
  if (session.role !== "admin") {
    conditions.push("owner_id = ?");
    params.push(session.userId);
  } else {
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
 * 审批需求：通过则自动生成正式岗位（jobs），并回填 job_id。
 * 只有 admin 能审批 —— 需求由用人部门提，审批权在 HR 负责人。
 */
requisitions.post("/:id/approve", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可审批招聘需求" }, 403);

  const id = c.req.param("id");
  const req = await c.env.DB.prepare("SELECT * FROM requisitions WHERE id = ?").bind(id).first<any>();
  if (!req) return c.json({ error: "需求不存在" }, 404);
  if (req.status !== "pending") return c.json({ error: "该需求已处理过" }, 400);

  let b: any = {};
  try { b = await c.req.json(); } catch { /* 允许空 body */ }

  // 生成正式岗位（owner 归需求创建人，跟进人还是原 HRBP）
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

/** 驳回需求 */
requisitions.post("/:id/reject", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可审批招聘需求" }, 403);

  const id = c.req.param("id");
  const req = await c.env.DB.prepare("SELECT status FROM requisitions WHERE id = ?").bind(id).first<{ status: string }>();
  if (!req) return c.json({ error: "需求不存在" }, 404);
  if (req.status !== "pending") return c.json({ error: "该需求已处理过" }, 400);

  let b: any = {};
  try { b = await c.req.json(); } catch { /* 允许空 body */ }
  await c.env.DB.prepare(
    "UPDATE requisitions SET status='rejected', reject_reason=?, updated_at=datetime('now') WHERE id=?"
  ).bind(b.reason || null, id).run();
  return c.json({ ok: true });
});

export { requisitions as requisitionRoutes };
