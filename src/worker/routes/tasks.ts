import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { ownerScope, scopeConds, scopeParams, canTouch } from "../scope";
import { genId } from "../helpers";

const tasks = new Hono<{ Bindings: Env }>();

// 以中国时区（UTC+8）取今天 YYYY-MM-DD，全站统一的日期基准
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
    conditions.push(...scopeConds(session, "k.owner_id"));
    params.push(...scopeParams(session));
  }

  if (scope === "todo") conditions.push("k.status = 'pending'");
  else if (scope === "done") conditions.push("k.status = 'done'");
  else if (scope === "closed") conditions.push("k.status IN ('done','cancelled')");

  if (talentId) { conditions.push("k.talent_id = ?"); params.push(talentId); }
  if (priority) { conditions.push("k.priority = ?"); params.push(priority); }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  // 排序：逾期越久越靠前 → 到期日近的优先 → 高优先级优先 → 最近创建
  // 逾期天数权重：用 days_left（已计算），负数越小（逾期越久）越靠前
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

  // 用 decorate 算出来的 days_left 做二次排序，让"逾期 30 天"排在"逾期 1 天"前面
  const items = (rows.results as any[]).map(decorate);
  items.sort((a: any, b: any) => {
    if (a.status !== "pending" || b.status !== "pending") return 0; // 非待办保持原有顺序
    if (a.days_left === null && b.days_left === null) return 0;
    if (a.days_left === null) return 1;
    if (b.days_left === null) return -1;
    if (a.days_left < 0 && b.days_left < 0) return a.days_left - b.days_left; // 逾期越久越靠前
    if (a.days_left < 0) return -1; // 逾期的排在前面
    if (b.days_left < 0) return 1;
    return a.days_left - b.days_left; // 都未逾期则按剩几天升序
  });
  return c.json({ items, total: items.length });
});

// ---- 待办数量统计（侧栏角标）----
tasks.get("/summary", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  let sql = "SELECT due_date FROM talent_tasks WHERE status = 'pending'";
  const params: string[] = [];
  { const sc = ownerScope(session); sql += sc.sql; params.push(...sc.params); }

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
  const due = body.due_date || null;
  // 手动待办的 original_due / shifted 由前端在保存时确认填写（周末顺延）
  const originalDue = body.original_due || null;
  const shifted = body.shifted ? 1 : 0;
  const taskType = body.task_type || "manual";
  await c.env.DB.prepare(`
    INSERT INTO talent_tasks (id, owner_id, talent_id, job_id, title, content, due_date, priority, status, source, original_due, shifted, task_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).bind(
    id, session.userId, body.talent_id || null, body.job_id || null,
    String(body.title).trim(), body.content || null, due,
    body.priority || "normal", body.source || "manual", originalDue, shifted, taskType
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
  { const sc = ownerScope(session); checkSql += sc.sql; checkParams.push(...sc.params); }
  const existing = await c.env.DB.prepare(checkSql).bind(...checkParams).first();
  if (!existing) return c.json({ error: "待办不存在" }, 404);

  const body = await c.req.json<any>();
  // original_due / shifted 也允许更新（拖拽改期落周末时顺延并标注）
  const fields = ["title", "content", "due_date", "priority", "status", "talent_id", "job_id", "original_due", "shifted", "task_type"] as const;

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
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
  { const sc = ownerScope(session); sql += sc.sql; params.push(...sc.params); }

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
  { const sc = ownerScope(session); sql += sc.sql; params.push(...sc.params); }

  await c.env.DB.prepare(sql).bind(...params).run();
  return c.json({ ok: true });
});

export { tasks as taskRoutes };
