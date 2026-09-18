import { Hono } from "hono";
import type { Env } from "../index";
import { getUserId } from "./auth";

const communications = new Hono<{ Bindings: Env }>();

function genId(): string { return crypto.randomUUID(); }

communications.get("/talent/:talentId", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const talentId = c.req.param("talentId");
  const rows = await c.env.DB.prepare(`SELECT c.*, u.name as user_name FROM communications c JOIN users u ON c.user_id = u.id WHERE c.talent_id = ? ORDER BY c.created_at DESC`).bind(talentId).all();
  return c.json(rows.results);
});

communications.post("/", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const body = await c.req.json<{ talent_id: string; type: string; content: string; rating?: number; follow_up_date?: string }>();
  if (!body.talent_id || !body.type) return c.json({ error: "人才ID和沟通类型为必填" }, 400);
  const id = genId();
  await c.env.DB.prepare(`INSERT INTO communications (id, talent_id, user_id, type, content, rating, follow_up_date) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, body.talent_id, userId, body.type, body.content || null, body.rating || null, body.follow_up_date || null).run();
  return c.json({ id, ...body });
});

communications.delete("/:id", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM communications WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return c.json({ ok: true });
});

export { communications as communicationRoutes };
