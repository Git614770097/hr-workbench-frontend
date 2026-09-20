import { Hono } from "hono";
import { setCookie, getCookie } from "hono/cookie";
import type { Env } from "../index";

const auth = new Hono<{ Bindings: Env }>();

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + "hr-talent-salt");
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function genId(): string { return crypto.randomUUID(); }
function genToken(): string { return crypto.randomUUID() + crypto.randomUUID(); }

// ---- 登录（手机号）----
// 说明：系统无注册功能，用户需由管理员在「用户管理」中创建后才能登录。
auth.post("/login", async (c) => {
  const { phone, password } = await c.req.json<{ phone: string; password: string }>();
  if (!phone || !password) return c.json({ error: "手机号和密码为必填" }, 400);

  const user = await c.env.DB.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first<{ id: string; phone: string; name: string; password_hash: string; role: string }>();

  if (!user) return c.json({ error: "手机号或密码错误" }, 401);

  const passwordHash = await hashPassword(password);
  if (user.password_hash !== passwordHash) return c.json({ error: "手机号或密码错误" }, 401);

  const token = genToken();
  await c.env.SESSIONS.put(token, JSON.stringify({ userId: user!.id, role: user!.role, name: user!.name }), { expirationTtl: 60 * 60 * 24 * 7 });
  setCookie(c, "token", token, { httpOnly: true, path: "/", maxAge: 60 * 60 * 24 * 7, sameSite: "Lax" });

  return c.json({ id: user!.id, phone: user!.phone, name: user!.name, role: user!.role, token });
});

// ---- 获取当前用户 ----
auth.get("/me", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const user = await c.env.DB.prepare("SELECT id, phone, name, role FROM users WHERE id = ?").bind(session.userId).first<{ id: string; phone: string; name: string; role: string }>();
  if (!user) return c.json({ error: "用户不存在" }, 401);
  return c.json(user);
});

// ---- 退出登录 ----
auth.post("/logout", async (c) => {
  const token = getCookie(c, "token") || c.req.header("Authorization")?.replace("Bearer ", "");
  if (token) await c.env.SESSIONS.delete(token);
  return c.json({ ok: true });
});

// ---- 管理员：创建普通用户 ----
auth.post("/users", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可操作" }, 403);

  const { phone, name, password } = await c.req.json<{ phone: string; name: string; password: string }>();
  if (!phone || !name || !password) return c.json({ error: "手机号、姓名、密码均为必填" }, 400);

  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE phone = ?").bind(phone).first();
  if (existing) return c.json({ error: "该手机号已存在" }, 409);

  const id = genId();
  const passwordHash = await hashPassword(password);
  await c.env.DB.prepare("INSERT INTO users (id, phone, name, password_hash, role) VALUES (?, ?, ?, ?, 'user')")
    .bind(id, phone, name, passwordHash).run();

  return c.json({ id, phone, name, role: "user" });
});

// ---- 管理员：用户列表 ----
auth.get("/users", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可操作" }, 403);

  const rows = await c.env.DB.prepare("SELECT id, phone, name, role, created_at FROM users ORDER BY created_at").all();
  return c.json(rows.results);
});

// ---- 管理员：重置用户密码 ----
auth.put("/users/:id/password", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可操作" }, 403);

  const id = c.req.param("id");
  const { password } = await c.req.json<{ password: string }>();
  if (!password || password.length < 6) return c.json({ error: "密码至少6位" }, 400);

  const passwordHash = await hashPassword(password);
  await c.env.DB.prepare("UPDATE users SET password_hash = ? WHERE id = ?").bind(passwordHash, id).run();
  return c.json({ ok: true });
});

// ---- 管理员：删除用户 ----
auth.delete("/users/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可操作" }, 403);

  const id = c.req.param("id");
  if (id === session.userId) return c.json({ error: "不能删除自己" }, 400);

  // 删除该用户的数据
  await c.env.DB.prepare("DELETE FROM talent_tags WHERE talent_id IN (SELECT id FROM talents WHERE owner_id = ?)").bind(id).run();
  await c.env.DB.prepare("DELETE FROM communications WHERE talent_id IN (SELECT id FROM talents WHERE owner_id = ?)").bind(id).run();
  await c.env.DB.prepare("DELETE FROM communications WHERE user_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM talents WHERE owner_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM tags WHERE owner_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();

  return c.json({ ok: true });
});

export { auth as authRoutes };

// ---- 会话工具 ----
export interface SessionInfo {
  userId: string;
  role: string;
  name: string;
}

export async function getSession(c: any): Promise<SessionInfo | null> {
  const token = getCookie(c, "token") || c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const session = await c.env.SESSIONS.get(token);
  if (!session) return null;
  return JSON.parse(session) as SessionInfo;
}
