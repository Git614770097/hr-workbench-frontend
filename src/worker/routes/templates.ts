import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";

const templates = new Hono<{ Bindings: Env }>();

function genId(): string { return crypto.randomUUID(); }

type Session = { userId: string; role: string };
type TemplateRow = { owner_id: string; scope: string };

const SCOPES = ["official", "shared", "private"] as const;

// 作用域规则：
// - official 官方：仅管理员可改/删，全员只读
// - shared 共享：创建者或管理员可改/删，全员可见
// - private 个人：仅创建者本人 + 管理员可见、可改/删
function canModify(session: Session, row: TemplateRow): boolean {
  if (session.role === "admin") return true;
  if (row.scope === "official") return false;
  return session.userId === row.owner_id;
}

// 列表可见性：管理员全量；普通用户 = 官方 + 共享 + 自己的个人模板
function visibilityCondition(session: Session): { sql: string; params: string[] } {
  if (session.role === "admin") return { sql: "1=1", params: [] };
  return { sql: "(dt.scope IN ('official', 'shared') OR dt.owner_id = ?)", params: [session.userId] };
}

// 排序：官方 → 共享 → 个人，同级按更新时间倒序
const SCOPE_ORDER = "CASE dt.scope WHEN 'official' THEN 0 WHEN 'shared' THEN 1 ELSE 2 END";

// ---- 模板列表（分类 + 关键词筛选，按作用域过滤与排序，支持分页）----
templates.get("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const category = (c.req.query("category") || "").trim();
  const q = (c.req.query("q") || "").trim();
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = Math.min(parseInt(c.req.query("limit") || "10", 10), 100);

  const vis = visibilityCondition(session);
  const conditions: string[] = [vis.sql];
  const params: string[] = [...vis.params];
  if (category) { conditions.push("dt.category = ?"); params.push(category); }
  if (q) { conditions.push("(dt.name LIKE ? OR dt.content LIKE ?)"); params.push(`%${q}%`, `%${q}%`); }

  const where = conditions.join(" AND ");
  const offset = (page - 1) * limit;

  const countResult = await c.env.DB.prepare(
    `SELECT COUNT(*) as total FROM doc_templates dt WHERE ${where}`
  ).bind(...params).first<{ total: number }>();

  const rows = await c.env.DB.prepare(
    `SELECT dt.*, u.name as owner_name FROM doc_templates dt LEFT JOIN users u ON dt.owner_id = u.id
     WHERE ${where} ORDER BY ${SCOPE_ORDER}, dt.updated_at DESC LIMIT ? OFFSET ?`
  ).bind(...params, limit, offset).all();

  const total = countResult?.total || 0;
  return c.json({ items: rows.results, total, page, limit, pages: Math.ceil(total / limit) });
});

// ---- 分类列表（含各分类模板数，按可见性过滤）----
templates.get("/categories", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const vis = visibilityCondition(session);
  const rows = await c.env.DB.prepare(
    `SELECT category, COUNT(*) as count FROM doc_templates dt WHERE ${vis.sql} GROUP BY category ORDER BY count DESC`
  ).bind(...vis.params).all();
  return c.json({ items: rows.results });
});

// ---- 模板详情 ----
templates.get("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const row = await c.env.DB.prepare(
    "SELECT dt.*, u.name as owner_name FROM doc_templates dt LEFT JOIN users u ON dt.owner_id = u.id WHERE dt.id = ?"
  ).bind(c.req.param("id")).first<TemplateRow>();
  if (!row) return c.json({ error: "模板不存在" }, 404);
  if (row.scope === "private" && row.owner_id !== session.userId && session.role !== "admin") {
    return c.json({ error: "无权查看该模板" }, 403);
  }
  return c.json(row);
});

// ---- 新建模板 ----
templates.post("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const body = await c.req.json<any>();
  if (!body.name || !body.content) return c.json({ error: "模板名称和内容不能为空" }, 400);

  // 仅管理员可创建官方模板；普通用户提交 official 一律降级为 shared
  let scope: string = SCOPES.includes(body.scope) ? body.scope : "shared";
  if (scope === "official" && session.role !== "admin") scope = "shared";

  const id = genId();
  await c.env.DB.prepare(
    "INSERT INTO doc_templates (id, owner_id, name, category, content, scope) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, session.userId, body.name, body.category || "其他", body.content, scope).run();
  return c.json({ id, name: body.name, scope });
});

// ---- 复制为己用（生成个人副本）----
templates.post("/:id/duplicate", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  const src = await c.env.DB.prepare(
    "SELECT name, category, content, scope, owner_id FROM doc_templates WHERE id = ?"
  ).bind(id).first<{ name: string; category: string; content: string; scope: string; owner_id: string }>();
  if (!src) return c.json({ error: "模板不存在" }, 404);
  if (src.scope === "private" && src.owner_id !== session.userId && session.role !== "admin") {
    return c.json({ error: "无权复制该模板" }, 403);
  }

  const newId = genId();
  const name = `${src.name}（副本）`;
  await c.env.DB.prepare(
    "INSERT INTO doc_templates (id, owner_id, name, category, content, scope) VALUES (?, ?, ?, ?, ?, 'private')"
  ).bind(newId, session.userId, name, src.category, src.content).run();
  return c.json({ id: newId, name });
});

// ---- 编辑模板 ----
templates.put("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT owner_id, scope FROM doc_templates WHERE id = ?").bind(id).first<TemplateRow>();
  if (!existing) return c.json({ error: "模板不存在" }, 404);
  if (!canModify(session, existing)) return c.json({ error: "无权修改该模板" }, 403);

  const body = await c.req.json<any>();
  // 仅管理员可调整作用域（如把共享模板提升为官方）；普通用户保持原 scope
  let scope: string | null = null;
  if (session.role === "admin" && SCOPES.includes(body.scope)) scope = body.scope;

  await c.env.DB.prepare(
    `UPDATE doc_templates SET
       name = COALESCE(?, name),
       category = COALESCE(?, category),
       content = COALESCE(?, content),
       scope = COALESCE(?, scope),
       updated_at = datetime('now')
     WHERE id = ?`
  ).bind(body.name, body.category, body.content, scope, id).run();
  return c.json({ id });
});

// ---- 删除模板 ----
templates.delete("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT owner_id, scope FROM doc_templates WHERE id = ?").bind(id).first<TemplateRow>();
  if (!existing) return c.json({ error: "模板不存在" }, 404);
  if (!canModify(session, existing)) return c.json({ error: "无权删除该模板" }, 403);

  await c.env.DB.prepare("DELETE FROM doc_templates WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

export { templates as templateRoutes };
