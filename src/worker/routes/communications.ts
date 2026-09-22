import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { genId } from "../helpers";

const communications = new Hono<{ Bindings: Env }>();

// ---- 获取某人才的沟通记录 ----
// 管理员：可看任何人才的记录；普通用户：只能看自己创建的人才的记录
communications.get("/talent/:talentId", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const talentId = c.req.param("talentId");

  // 权限检查：普通用户只能看自己创建的人才的沟通记录
  if (session.role !== "admin") {
    const talent = await c.env.DB.prepare("SELECT owner_id FROM talents WHERE id = ?").bind(talentId).first();
    if (!talent || (talent as any).owner_id !== session.userId) {
      return c.json({ error: "无权限" }, 403);
    }
  }

  const rows = await c.env.DB.prepare(
    `SELECT c.*, u.name as user_name FROM communications c JOIN users u ON c.user_id = u.id WHERE c.talent_id = ? ORDER BY c.created_at DESC`
  ).bind(talentId).all();
  return c.json(rows.results);
});

// ---- 添加沟通记录 ----
// 管理员：可给任何人才添加记录；普通用户：只能给自己的添加
communications.post("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const body = await c.req.json<{ talent_id: string; type: string; content: string; rating?: number; follow_up_date?: string }>();
  if (!body.talent_id || !body.type) return c.json({ error: "人才ID和沟通类型为必填" }, 400);

  // 权限检查
  if (session.role !== "admin") {
    const talent = await c.env.DB.prepare("SELECT owner_id FROM talents WHERE id = ?").bind(body.talent_id).first();
    if (!talent || (talent as any).owner_id !== session.userId) {
      return c.json({ error: "无权限" }, 403);
    }
  }

  const id = genId();
  await c.env.DB.prepare(`INSERT INTO communications (id, talent_id, user_id, type, content, rating, follow_up_date) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, body.talent_id, session.userId, body.type, body.content || null, body.rating || null, body.follow_up_date || null).run();
  return c.json({ id, ...body });
});

// ---- 删除沟通记录 ----
// 管理员：可删除任何记录；普通用户：只能删除自己的
communications.delete("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  let sql = "DELETE FROM communications WHERE id = ?";
  const params: string[] = [id];
  if (session.role !== "admin") { sql += " AND user_id = ?"; params.push(session.userId); }

  await c.env.DB.prepare(sql).bind(...params).run();
  return c.json({ ok: true });
});

export { communications as communicationRoutes };
