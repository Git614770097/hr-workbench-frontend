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

auth.post("/register", async (c) => {
  const { email, name, password } = await c.req.json<{ email: string; name: string; password: string }>();
  if (!email || !name || !password) return c.json({ error: "邮箱、姓名、密码均为必填" }, 400);
  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (existing) return c.json({ error: "该邮箱已注册" }, 409);
  const id = genId();
  const passwordHash = await hashPassword(password);
  await c.env.DB.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)").bind(id, email, name, passwordHash).run();
  const token = genToken();
  await c.env.SESSIONS.put(token, JSON.stringify({ userId: id, name }), { expirationTtl: 60 * 60 * 24 * 7 });
  setCookie(c, "token", token, { httpOnly: true, path: "/", maxAge: 60 * 60 * 24 * 7, sameSite: "Lax" });
  return c.json({ id, email, name, token });
});

auth.post("/login", async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  if (!email || !password) return c.json({ error: "邮箱和密码为必填" }, 400);
  const user = await c.env.DB.prepare("SELECT id, email, name, password_hash FROM users WHERE email = ?").bind(email).first<{ id: string; email: string; name: string; password_hash: string }>();
  if (!user) return c.json({ error: "邮箱或密码错误" }, 401);
  const passwordHash = await hashPassword(password);
  if (user.password_hash !== passwordHash) return c.json({ error: "邮箱或密码错误" }, 401);
  const token = genToken();
  await c.env.SESSIONS.put(token, JSON.stringify({ userId: user.id, name: user.name }), { expirationTtl: 60 * 60 * 24 * 7 });
  setCookie(c, "token", token, { httpOnly: true, path: "/", maxAge: 60 * 60 * 24 * 7, sameSite: "Lax" });
  return c.json({ id: user.id, email: user.email, name: user.name, token });
});

auth.get("/me", async (c) => {
  const token = getCookie(c, "token") || c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return c.json({ error: "未登录" }, 401);
  const session = await c.env.SESSIONS.get(token);
  if (!session) return c.json({ error: "会话已过期" }, 401);
  const { userId } = JSON.parse(session);
  const user = await c.env.DB.prepare("SELECT id, email, name FROM users WHERE id = ?").bind(userId).first<{ id: string; email: string; name: string }>();
  if (!user) return c.json({ error: "用户不存在" }, 401);
  return c.json(user);
});

auth.post("/logout", async (c) => {
  const token = getCookie(c, "token") || c.req.header("Authorization")?.replace("Bearer ", "");
  if (token) await c.env.SESSIONS.delete(token);
  return c.json({ ok: true });
});

export { auth as authRoutes };

export async function getUserId(c: Parameters<Parameters<typeof auth.get>[1]>[0]): Promise<string | null> {
  const token = getCookie(c, "token") || c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const session = await c.env.SESSIONS.get(token);
  if (!session) return null;
  return JSON.parse(session).userId as string;
}
