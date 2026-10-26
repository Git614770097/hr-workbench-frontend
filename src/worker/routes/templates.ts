import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { genId } from "../helpers";
import { stripDangerousHtml } from "../../utils/htmlStrip";

const templates = new Hono<{ Bindings: Env }>();

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

// 每个 target 最多保留的版本数（超出剪最老的）
const VERSION_KEEP = 20;

/**
 * 保存前把旧文入版本表（version 自增由 SQL 完成），并剪掉超出保留数的老版本。
 * 只在内容真正变化时调用；与主表 UPDATE 组成一个 batch，避免半截状态。
 */
function snapshotStmts(
  db: D1Database,
  targetType: string,
  targetId: string,
  oldContent: string,
  editorId: string | null,
  note: string | null,
): D1PreparedStatement[] {
  return [
    db.prepare(
      `INSERT INTO content_versions (id, target_type, target_id, version, content, editor_id, note)
       SELECT ?, ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?
       FROM content_versions WHERE target_type = ? AND target_id = ?`
    ).bind(genId(), targetType, targetId, oldContent, editorId, note, targetType, targetId),
    db.prepare(
      `DELETE FROM content_versions WHERE target_type = ? AND target_id = ?
       AND version <= (SELECT MAX(version) - ? FROM content_versions WHERE target_type = ? AND target_id = ?)`
    ).bind(targetType, targetId, VERSION_KEEP, targetType, targetId),
  ];
}

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
  ).bind(id, session.userId, body.name, body.category || "证明文档", stripDangerousHtml(String(body.content || "")), scope).run();
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
  ).bind(newId, session.userId, name, src.category, stripDangerousHtml(src.content)).run();
  return c.json({ id: newId, name });
});

// ---- 编辑模板 ----
templates.put("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT owner_id, scope, content FROM doc_templates WHERE id = ?").bind(id).first<TemplateRow & { content: string }>();
  if (!existing) return c.json({ error: "模板不存在" }, 404);
  if (!canModify(session, existing)) return c.json({ error: "无权修改该模板" }, 403);

  const body = await c.req.json<any>();
  // 仅管理员可调整作用域（如把共享模板提升为官方）；普通用户保持原 scope
  let scope: string | null = null;
  if (session.role === "admin" && SCOPES.includes(body.scope)) scope = body.scope;

  const nextContent = body.content === undefined ? null : stripDangerousHtml(String(body.content));
  const contentChanged = nextContent !== null && nextContent !== existing.content;

  // 内容真变了才留底；改名/改分类/改作用域不动正文，不产生版本噪音
  const stmts: D1PreparedStatement[] = [];
  if (contentChanged) {
    stmts.push(...snapshotStmts(c.env.DB, "template", id, existing.content, session.userId, null));
  }
  stmts.push(
    c.env.DB.prepare(
      `UPDATE doc_templates SET
         name = COALESCE(?, name),
         category = COALESCE(?, category),
         content = COALESCE(?, content),
         scope = COALESCE(?, scope),
         updated_at = datetime('now')
       WHERE id = ?`
    ).bind(body.name, body.category, nextContent, scope, id)
  );
  await c.env.DB.batch(stmts);
  return c.json({ id, versioned: contentChanged });
});

// ---- 删除模板（连同历史快照一起清） ----
templates.delete("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  const existing = await c.env.DB.prepare("SELECT owner_id, scope FROM doc_templates WHERE id = ?").bind(id).first<TemplateRow>();
  if (!existing) return c.json({ error: "模板不存在" }, 404);
  if (!canModify(session, existing)) return c.json({ error: "无权删除该模板" }, 403);

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM content_versions WHERE target_type = 'template' AND target_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM doc_templates WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

// ---- 历史版本列表（只回元数据，正文按需取）----
templates.get("/:id/versions", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT id FROM doc_templates WHERE id = ?").bind(id).first<{ id: string }>();
  if (!row) return c.json({ error: "模板不存在" }, 404);

  const res = await c.env.DB.prepare(
    `SELECT cv.version, cv.note, cv.created_at, LENGTH(cv.content) AS size, u.name AS editor_name
     FROM content_versions cv LEFT JOIN users u ON cv.editor_id = u.id
     WHERE cv.target_type = 'template' AND cv.target_id = ?
     ORDER BY cv.version DESC`
  ).bind(id).all();
  return c.json({ items: res.results });
});

// ---- 取单个历史版本正文（预览用）----
templates.get("/:id/versions/:ver", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  const ver = parseInt(c.req.param("ver"), 10);
  if (!Number.isFinite(ver)) return c.json({ error: "版本号无效" }, 400);

  const row = await c.env.DB.prepare("SELECT id FROM doc_templates WHERE id = ?").bind(id).first<{ id: string }>();
  if (!row) return c.json({ error: "模板不存在" }, 404);

  const v = await c.env.DB.prepare(
    `SELECT version, content, note, created_at FROM content_versions
     WHERE target_type = 'template' AND target_id = ? AND version = ?`
  ).bind(id, ver).first();
  if (!v) return c.json({ error: "版本不存在" }, 404);
  return c.json(v);
});

// ---- 恢复到指定历史版本 ----
// 语义：当前正文先入版本表（note=恢复自 vN），再把目标版本内容写回主表。
// 历史只增不删，「恢复」本身也成为可回退的一版。
templates.post("/:id/versions/:ver/restore", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  const ver = parseInt(c.req.param("ver"), 10);
  if (!Number.isFinite(ver)) return c.json({ error: "版本号无效" }, 400);

  const existing = await c.env.DB.prepare("SELECT owner_id, scope, content FROM doc_templates WHERE id = ?").bind(id).first<TemplateRow & { content: string }>();
  if (!existing) return c.json({ error: "模板不存在" }, 404);
  if (!canModify(session, existing)) return c.json({ error: "无权修改该模板" }, 403);

  const target = await c.env.DB.prepare(
    `SELECT content FROM content_versions WHERE target_type = 'template' AND target_id = ? AND version = ?`
  ).bind(id, ver).first<{ content: string }>();
  if (!target) return c.json({ error: "版本不存在" }, 404);

  if (target.content === existing.content) {
    return c.json({ id, versioned: false, restored_from: ver });
  }

  const stmts = [
    ...snapshotStmts(c.env.DB, "template", id, existing.content, session.userId, `恢复自 v${ver}`),
    c.env.DB.prepare("UPDATE doc_templates SET content = ?, updated_at = datetime('now') WHERE id = ?").bind(target.content, id),
  ];
  await c.env.DB.batch(stmts);
  return c.json({ id, versioned: true, restored_from: ver });
});

export { templates as templateRoutes };
