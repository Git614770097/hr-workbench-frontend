import { Hono } from "hono";
import type { Env } from "../index";
import { getUserId } from "./auth";

const tags = new Hono<{ Bindings: Env }>();

function genId(): string { return crypto.randomUUID(); }

tags.get("/", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const rows = await c.env.DB.prepare(`SELECT t.*, (SELECT COUNT(*) FROM talent_tags tt WHERE tt.tag_id = t.id) as talent_count FROM tags t WHERE t.owner_id = ? ORDER BY t.name`).bind(userId).all();
  return c.json(rows.results);
});

tags.post("/", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const { name, color } = await c.req.json<{ name: string; color?: string }>();
  if (!name) return c.json({ error: "标签名称为必填" }, 400);
  const id = genId();
  await c.env.DB.prepare("INSERT INTO tags (id, name, color, owner_id) VALUES (?, ?, ?, ?)").bind(id, name, color || "#3b82f6", userId).run();
  return c.json({ id, name, color: color || "#3b82f6" });
});

tags.put("/:id", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  const { name, color } = await c.req.json<{ name?: string; color?: string }>();
  await c.env.DB.prepare(`UPDATE tags SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ? AND owner_id = ?`).bind(name, color, id, userId).run();
  return c.json({ id });
});

tags.delete("/:id", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM talent_tags WHERE tag_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM tags WHERE id = ? AND owner_id = ?").bind(id, userId).run();
  return c.json({ ok: true });
});

export { tags as tagRoutes };
