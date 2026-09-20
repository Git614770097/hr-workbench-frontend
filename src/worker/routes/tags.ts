import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";

const tags = new Hono<{ Bindings: Env }>();

function genId(): string { return crypto.randomUUID(); }

// ---- 标签列表 ----
// 管理员：看所有标签；普通用户：只看自己的
tags.get("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  let sql = `SELECT t.*, (SELECT COUNT(*) FROM talent_tags tt WHERE tt.tag_id = t.id) as talent_count, u.name as owner_name FROM tags t JOIN users u ON t.owner_id = u.id`;
  const params: string[] = [];
  if (session.role !== "admin") { sql += " WHERE t.owner_id = ?"; params.push(session.userId); }
  sql += " ORDER BY t.name";

  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(rows.results);
});

// ---- 新增标签 ----
tags.post("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const { name, color } = await c.req.json<{ name: string; color?: string }>();
  if (!name) return c.json({ error: "标签名称为必填" }, 400);

  const id = genId();
  await c.env.DB.prepare("INSERT INTO tags (id, name, color, owner_id) VALUES (?, ?, ?, ?)")
    .bind(id, name, color || "#3b82f6", session.userId).run();
  return c.json({ id, name, color: color || "#3b82f6" });
});

// ---- 编辑标签 ----
// 管理员：可编辑任何标签；普通用户：只能编辑自己的
tags.put("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  const { name, color } = await c.req.json<{ name?: string; color?: string }>();

  let sql = `UPDATE tags SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?`;
  const params: (string | undefined)[] = [name, color, id];
  if (session.role !== "admin") { sql += " AND owner_id = ?"; params.push(session.userId); }

  await c.env.DB.prepare(sql).bind(...params).run();
  return c.json({ id });
});

// ---- 删除标签 ----
// 管理员：可删除任何标签；普通用户：只能删除自己的
tags.delete("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  let checkSql = "SELECT id FROM tags WHERE id = ?";
  const checkParams: string[] = [id];
  if (session.role !== "admin") { checkSql += " AND owner_id = ?"; checkParams.push(session.userId); }
  const existing = await c.env.DB.prepare(checkSql).bind(...checkParams).first();
  if (!existing) return c.json({ error: "标签不存在" }, 404);

  await c.env.DB.prepare("DELETE FROM talent_tags WHERE tag_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM tags WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

export { tags as tagRoutes };
