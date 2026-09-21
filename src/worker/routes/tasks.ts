import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";

const tasks = new Hono<{ Bindings: Env }>();

function genId(): string { return crypto.randomUUID(); }

// 以中国时区（UTC+8）取今天 YYYY-MM-DD，与风险预警保持一致的日期基准
function todayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function diffDays(ymd: string | null): number | null {
  if (!ymd) return null;
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const target = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const t = todayYmd().split("-").map(Number);
  const now = Date.UTC(t[0], t[1] - 1, t[2]);
  return Math.round((target - now) / 86400000);
}

function decorate(r: any) {
  const d = diffDays(r.due_date);
  return {
    ...r,
    days_left: d,
    overdue: r.status === "pending" && d !== null && d < 0,
    due_today: r.status === "pending" && d === 0,
  };
}

// ---- 待办列表 ----
// 参数：scope=todo 待办(默认) / done 已完成 / all 全部；talent_id 按人才过滤
tasks.get("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const scope = c.req.query("scope") || "todo";
  const talentId = c.req.query("talent_id");
  const priority = c.req.query("priority");

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (session.role === "admin") {
    const ownerId = c.req.query("owner_id");
    if (ownerId) { conditions.push("k.owner_id = ?"); params.push(ownerId); }
  } else {
    conditions.push("k.owner_id = ?");
    params.push(session.userId);
  }

  if (scope === "todo") conditions.push("k.status = 'pending'");
  else if (scope === "done") conditions.push("k.status = 'done'");
  else if (scope === "closed") conditions.push("k.status IN ('done','cancelled')");

  if (talentId) { conditions.push("k.talent_id = ?"); params.push(talentId); }
  if (priority) { conditions.push("k.priority = ?"); params.push(priority); }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  // 排序：逾期/今日到期优先 → 到期日近的优先 → 高优先级优先 → 最近创建
  const rows = await c.env.DB.prepare(`
    SELECT k.*, t.name as talent_name, j.title as job_title, u.name as owner_name
    FROM talent_tasks k
    LEFT JOIN talents t ON k.talent_id = t.id
    LEFT JOIN jobs j ON k.job_id = j.id
    LEFT JOIN users u ON k.owner_id = u.id
    ${where}
    ORDER BY
      CASE WHEN k.status != 'pending' THEN 1 ELSE 0 END,
      CASE WHEN k.due_date IS NULL THEN 1 ELSE 0 END,
      k.due_date ASC,
      CASE k.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
      k.created_at DESC
  `).bind(...params).all();

  const items = (rows.results as any[]).map(decorate);
  return c.json({ items, total: items.length });
});

// ---- 待办数量统计（侧栏角标）----
tasks.get("/summary", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  let sql = "SELECT due_date FROM talent_tasks WHERE status = 'pending'";
  const params: string[] = [];
  if (session.role !== "admin") { sql += " AND owner_id = ?"; params.push(session.userId); }

  const rows = await c.env.DB.prepare(sql).bind(...params).all<{ due_date: string | null }>();

  let overdue = 0;
  let today = 0;
  for (const r of rows.results) {
    const d = diffDays(r.due_date);
    if (d === null) continue;
    if (d < 0) overdue++;
    else if (d === 0) today++;
  }

  return c.json({ pending: rows.results.length, overdue, today });
});

// ---- 新建待办 ----
tasks.post("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const body = await c.req.json<any>();
  if (!body.title || !String(body.title).trim()) return c.json({ error: "待办标题为必填" }, 400);

  const id = genId();
  await c.env.DB.prepare(`
    INSERT INTO talent_tasks (id, owner_id, talent_id, job_id, title, content, due_date, priority, status, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).bind(
    id, session.userId, body.talent_id || null, body.job_id || null,
    String(body.title).trim(), body.content || null, body.due_date || null,
    body.priority || "normal", body.source || "manual"
  ).run();

  return c.json({ id });
});

// ---- 编辑待办 ----
tasks.put("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  let checkSql = "SELECT id FROM talent_tasks WHERE id = ?";
  const checkParams: string[] = [id];
  if (session.role !== "admin") { checkSql += " AND owner_id = ?"; checkParams.push(session.userId); }
  const existing = await c.env.DB.prepare(checkSql).bind(...checkParams).first();
  if (!existing) return c.json({ error: "待办不存在" }, 404);

  const body = await c.req.json<any>();
  const fields = ["title", "content", "due_date", "priority", "status", "talent_id", "job_id"] as const;

  const sets: string[] = [];
  const params: (string | null)[] = [];
  for (const f of fields) {
    if (body[f] !== undefined) {
      sets.push(`${f} = ?`);
      params.push(body[f] === "" ? null : body[f]);
    }
  }
  // 标记完成时记录完成时间；重新打开则清空
  if (body.status === "done") { sets.push("done_at = datetime('now')"); }
  else if (body.status === "pending") { sets.push("done_at = NULL"); }
  if (sets.length === 0) return c.json({ id });

  await c.env.DB.prepare(`UPDATE talent_tasks SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...params, id).run();
  return c.json({ id });
});

// ---- 完成 / 取消待办（快捷切换）----
tasks.put("/:id/status", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  const { status } = await c.req.json<{ status: string }>();
  if (!["pending", "done", "cancelled"].includes(status)) return c.json({ error: "状态值不合法" }, 400);

  let sql = "UPDATE talent_tasks SET status = ?";
  const params: (string | null)[] = [status];
  sql += status === "done" ? ", done_at = datetime('now')" : ", done_at = NULL";
  sql += " WHERE id = ?";
  params.push(id);
  if (session.role !== "admin") { sql += " AND owner_id = ?"; params.push(session.userId); }

  await c.env.DB.prepare(sql).bind(...params).run();
  return c.json({ ok: true, status });
});

// ---- 删除待办 ----
tasks.delete("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  let sql = "DELETE FROM talent_tasks WHERE id = ?";
  const params: string[] = [id];
  if (session.role !== "admin") { sql += " AND owner_id = ?"; params.push(session.userId); }

  await c.env.DB.prepare(sql).bind(...params).run();
  return c.json({ ok: true });
});

export { tasks as taskRoutes };
