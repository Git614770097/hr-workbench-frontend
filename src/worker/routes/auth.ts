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

// ---- 图文验证码 ----
// 生成 4 位随机字符验证码，渲染成带干扰线的 SVG 图片；
// 明文存 KV（captcha:{id}，60 秒过期，一次性使用），登录时用 captcha_id 校验。

const CAPTCHA_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉易混淆的 0/O/1/I
const CAPTCHA_LEN = 4;

function randomCode(): string {
  let s = "";
  const arr = new Uint8Array(CAPTCHA_LEN);
  crypto.getRandomValues(arr);
  for (let i = 0; i < CAPTCHA_LEN; i++) {
    s += CAPTCHA_CHARS[arr[i] % CAPTCHA_CHARS.length];
  }
  return s;
}

function renderCaptchaSvg(code: string): string {
  const w = 120;
  const h = 44;
  const chars = code.split("");
  // 每个字符一个分组：随机颜色 + 随机旋转
  const glyphs = chars
    .map((ch, i) => {
      const x = 18 + i * 24;
      const y = 30;
      const rotate = (Math.random() * 40 - 20).toFixed(0);
      const color = `hsl(${Math.floor(Math.random() * 360)}, 70%, 45%)`;
      const fontSize = 26 + Math.floor(Math.random() * 6);
      return `<text x="${x}" y="${y}" font-size="${fontSize}" font-weight="700" fill="${color}" transform="rotate(${rotate} ${x} ${y})" text-anchor="middle" font-family="Arial, sans-serif">${ch}</text>`;
    })
    .join("");

  // 干扰线
  let lines = "";
  for (let i = 0; i < 4; i++) {
    const x1 = Math.floor(Math.random() * w);
    const y1 = Math.floor(Math.random() * h);
    const x2 = Math.floor(Math.random() * w);
    const y2 = Math.floor(Math.random() * h);
    lines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="hsl(${Math.floor(Math.random() * 360)}, 60%, 60%)" stroke-width="1" />`;
  }

  // 噪点
  let dots = "";
  for (let i = 0; i < 40; i++) {
    const cx = Math.floor(Math.random() * w);
    const cy = Math.floor(Math.random() * h);
    dots += `<circle cx="${cx}" cy="${cy}" r="1" fill="hsl(0, 0%, ${30 + Math.floor(Math.random() * 40)}%)" />`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="100%" height="100%" fill="#f7f8fa" rx="6" />
  ${lines}
  ${glyphs}
  ${dots}
</svg>`;
}

// 下发验证码：返回 captcha_id + SVG，明文存 KV 一次性
auth.get("/captcha", async (c) => {
  const id = crypto.randomUUID();
  const code = randomCode();
  const svg = renderCaptchaSvg(code);
  await c.env.SESSIONS.put(`captcha:${id}`, code, { expirationTtl: 60 });
  c.header("Cache-Control", "no-store");
  return c.json({ captcha_id: id, svg });
});

// ---- 登录（手机号）----
// 说明：系统无注册功能，用户需由管理员在「用户管理」中创建后才能登录。
auth.post("/login", async (c) => {
  const { phone, password, captcha_id, captcha } = await c.req.json<{ phone: string; password: string; captcha_id?: string; captcha?: string }>();
  if (!phone || !password) return c.json({ error: "手机号和密码为必填" }, 400);

  // 校验图文验证码
  if (!captcha_id || !captcha) return c.json({ error: "请输入验证码" }, 400);
  const storedCode = await c.env.SESSIONS.get(`captcha:${captcha_id}`);
  if (!storedCode) return c.json({ error: "验证码已过期，请刷新" }, 400);
  // 一次性：无论对错都销毁，防止暴力重试
  await c.env.SESSIONS.delete(`captcha:${captcha_id}`);
  if (storedCode.toUpperCase() !== captcha.trim().toUpperCase()) {
    return c.json({ error: "验证码错误" }, 400);
  }

  const user = await c.env.DB.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first<{ id: string; phone: string; name: string; password_hash: string; role: string; role_id: string | null }>();

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
  const user = await c.env.DB.prepare("SELECT id, phone, name, role, role_id FROM users WHERE id = ?").bind(session.userId).first<{ id: string; phone: string; name: string; role: string; role_id: string | null }>();
  if (!user) return c.json({ error: "用户不存在" }, 401);

  // 管理员拥有全部权限；普通用户取角色 permissions
  let permissions: string[] = [];
  if (user.role !== "admin" && user.role_id) {
    const role = await c.env.DB.prepare("SELECT permissions FROM roles WHERE id = ?").bind(user.role_id).first<{ permissions: string }>();
    if (role) {
      try {
        const arr = JSON.parse(role.permissions);
        if (Array.isArray(arr)) permissions = arr.filter((x) => typeof x === "string");
      } catch {}
    }
  }

  return c.json({ id: user.id, phone: user.phone, name: user.name, role: user.role, role_id: user.role_id, permissions });
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

  const { phone, name, password, role_id } = await c.req.json<{ phone: string; name: string; password: string; role_id?: string | null }>();
  if (!phone || !name || !password) return c.json({ error: "手机号、姓名、密码均为必填" }, 400);

  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE phone = ?").bind(phone).first();
  if (existing) return c.json({ error: "该手机号已存在" }, 409);

  // 校验角色存在
  let finalRoleId: string | null = null;
  if (role_id) {
    const r = await c.env.DB.prepare("SELECT id FROM roles WHERE id = ?").bind(role_id).first();
    if (!r) return c.json({ error: "角色不存在" }, 400);
    finalRoleId = role_id;
  }

  const id = genId();
  const passwordHash = await hashPassword(password);
  await c.env.DB.prepare("INSERT INTO users (id, phone, name, password_hash, role, role_id) VALUES (?, ?, ?, ?, 'user', ?)")
    .bind(id, phone, name, passwordHash, finalRoleId).run();

  return c.json({ id, phone, name, role: "user", role_id: finalRoleId });
});

// ---- 管理员：用户列表 ----
auth.get("/users", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可操作" }, 403);

  const rows = await c.env.DB.prepare(
    "SELECT u.id, u.phone, u.name, u.role, u.role_id, u.created_at, r.name as role_name FROM users u LEFT JOIN roles r ON u.role_id = r.id ORDER BY u.created_at"
  ).all();
  return c.json(rows.results);
});

// ---- 管理员：更新用户角色 ----
auth.put("/users/:id/role", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可操作" }, 403);

  const id = c.req.param("id");
  const { role_id } = await c.req.json<{ role_id: string | null }>();

  const target = await c.env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(id).first<{ role: string }>();
  if (!target) return c.json({ error: "用户不存在" }, 404);
  if (target.role === "admin") return c.json({ error: "不能修改管理员的角色" }, 400);

  let finalRoleId: string | null = null;
  if (role_id) {
    const r = await c.env.DB.prepare("SELECT id FROM roles WHERE id = ?").bind(role_id).first();
    if (!r) return c.json({ error: "角色不存在" }, 400);
    finalRoleId = role_id;
  }

  await c.env.DB.prepare("UPDATE users SET role_id = ? WHERE id = ?").bind(finalRoleId, id).run();
  return c.json({ ok: true });
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
