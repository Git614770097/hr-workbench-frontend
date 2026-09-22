import { Hono } from "hono";
import { setCookie, getCookie } from "hono/cookie";
import type { Env } from "../index";
import { genId } from "../helpers";

const auth = new Hono<{ Bindings: Env }>();

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + "hr-talent-salt");
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

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

// ---- 自助注册 ----
// 说明：注册后状态为 pending，登录会被拒绝，必须由管理员在「用户管理」中
//       审批通过并分配角色后才能进入系统。这样既省去管理员手输资料的麻烦，
//       又保证未经审批的人进不来。
auth.post("/register", async (c) => {
  const { phone, name, password, captcha_id, captcha } = await c.req.json<{
    phone: string; name: string; password: string; captcha_id?: string; captcha?: string;
  }>();

  if (!phone || !name || !password) return c.json({ error: "手机号、姓名、密码均为必填" }, 400);
  if (!/^1[3-9]\d{9}$/.test(phone)) return c.json({ error: "请输入正确的手机号" }, 400);
  if (password.length < 6) return c.json({ error: "密码至少 6 位" }, 400);

  // 校验图文验证码（注册接口同样需要，防止脚本批量灌垃圾申请）
  if (!captcha_id || !captcha) return c.json({ error: "请输入验证码" }, 400);
  const storedCode = await c.env.SESSIONS.get(`captcha:${captcha_id}`);
  if (!storedCode) return c.json({ error: "验证码已过期，请刷新" }, 400);
  await c.env.SESSIONS.delete(`captcha:${captcha_id}`);
  if (storedCode.toUpperCase() !== captcha.trim().toUpperCase()) {
    return c.json({ error: "验证码错误" }, 400);
  }

  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE phone = ?").bind(phone).first();
  if (existing) return c.json({ error: "该手机号已注册，请直接登录或联系管理员" }, 409);

  const id = genId();
  const passwordHash = await hashPassword(password);
  // role_id 留空 —— 权限由管理员审批时分配，不做任何默认授权
  await c.env.DB.prepare(
    "INSERT INTO users (id, phone, name, password_hash, role, role_id, status) VALUES (?, ?, ?, ?, 'user', NULL, 'pending')"
  ).bind(id, phone, name, passwordHash).run();

  return c.json({ ok: true, message: "注册已提交，请等待管理员审批后登录" });
});

// ---- 忘记密码：提交重置申请 ----
// 本系统没有短信/邮件通道，无法做短信验证码自助重置。
// 流程：用户填写手机号 + 姓名（双要素核对）+ 验证码 → 提交申请 →
//       管理员在「用户管理」中核对身份后批准并设置新密码。
// 安全：无论手机号是否存在、姓名是否匹配，都返回同一句提示，
//       避免被用来枚举「哪些手机号已注册」。
auth.post("/forgot-password", async (c) => {
  const { phone, name, captcha_id, captcha } = await c.req.json<{
    phone: string; name: string; captcha_id?: string; captcha?: string;
  }>();

  if (!phone || !name) return c.json({ error: "手机号和姓名均为必填" }, 400);
  if (!/^1[3-9]\d{9}$/.test(phone)) return c.json({ error: "请输入正确的手机号" }, 400);

  // 验证码校验（防脚本批量刷申请）
  if (!captcha_id || !captcha) return c.json({ error: "请输入验证码" }, 400);
  const storedCode = await c.env.SESSIONS.get(`captcha:${captcha_id}`);
  if (!storedCode) return c.json({ error: "验证码已过期，请刷新" }, 400);
  await c.env.SESSIONS.delete(`captcha:${captcha_id}`);
  if (storedCode.toUpperCase() !== captcha.trim().toUpperCase()) {
    return c.json({ error: "验证码错误" }, 400);
  }

  const OK_MSG = "重置申请已提交，请等待管理员核对后设置新密码";

  const user = await c.env.DB.prepare("SELECT id, name FROM users WHERE phone = ?")
    .bind(phone)
    .first<{ id: string; name: string }>();

  // 手机号不存在 或 姓名不匹配 → 静默忽略，但对外返回相同提示
  if (!user || user.name.trim() !== name.trim()) {
    return c.json({ ok: true, message: OK_MSG });
  }

  await c.env.DB.prepare("UPDATE users SET reset_requested_at = datetime('now') WHERE id = ?")
    .bind(user.id).run();

  return c.json({ ok: true, message: OK_MSG });
});

// ---- 登录（手机号）----
// 说明：用户可由管理员在「用户管理」中创建，也可自助注册（需管理员审批）。
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

  const user = await c.env.DB.prepare("SELECT * FROM users WHERE phone = ?").bind(phone).first<{ id: string; phone: string; name: string; password_hash: string; role: string; role_id: string | null; status: string | null }>();

  if (!user) return c.json({ error: "手机号或密码错误" }, 401);

  const passwordHash = await hashPassword(password);
  if (user.password_hash !== passwordHash) return c.json({ error: "手机号或密码错误" }, 401);

  // 待审批 / 已拒绝的账号不允许登录。
  // 注意：这里放在密码校验之后，避免通过响应差异探测某手机号是否已注册。
  // 存量用户 status 为 'active'（迁移时的 DEFAULT），不受影响。
  if (user.status && user.status !== "active") {
    const msg =
      user.status === "pending"
        ? "账号正在等待管理员审批，通过后即可登录"
        : user.status === "rejected"
          ? "注册申请未通过，请联系管理员"
          : "账号已被停用，请联系管理员";
    return c.json({ error: msg }, 403);
  }

  const token = genToken();
  await c.env.SESSIONS.put(token, JSON.stringify({ userId: user!.id, role: user!.role, name: user!.name }), { expirationTtl: 60 * 60 * 24 * 7 });
  setCookie(c, "token", token, { httpOnly: true, path: "/", maxAge: 60 * 60 * 24 * 7, sameSite: "Lax" });

  return c.json({ id: user!.id, phone: user!.phone, name: user!.name, role: user!.role, token });
});

// ---- 获取当前用户 ----
auth.get("/me", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const user = await c.env.DB.prepare("SELECT id, phone, name, role, role_id, must_change_password FROM users WHERE id = ?").bind(session.userId).first<{ id: string; phone: string; name: string; role: string; role_id: string | null; must_change_password: number }>();
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

  return c.json({
    id: user.id, phone: user.phone, name: user.name, role: user.role, role_id: user.role_id,
    must_change_password: !!user.must_change_password,
    permissions,
  });
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
  await c.env.DB.prepare("INSERT INTO users (id, phone, name, password_hash, role, role_id, status) VALUES (?, ?, ?, ?, 'user', ?, 'active')")
    .bind(id, phone, name, passwordHash, finalRoleId).run();

  return c.json({ id, phone, name, role: "user", role_id: finalRoleId });
});

// ---- 管理员：用户列表（含注册状态，支持 ?status=pending 只看待审批）----
auth.get("/users", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可操作" }, 403);

  // 支持两种过滤：
  //   ?status=pending            —— 待审批的注册申请
  //   ?reset=1                   —— 有待处理的忘记密码申请
  const statusFilter = (c.req.query("status") || "").trim();
  const resetFilter = c.req.query("reset") === "1";

  let sql =
    "SELECT u.id, u.phone, u.name, u.role, u.role_id, u.status, u.created_at, " +
    "u.reset_requested_at, u.must_change_password, r.name as role_name " +
    "FROM users u LEFT JOIN roles r ON u.role_id = r.id";
  const params: string[] = [];
  if (statusFilter) {
    sql += " WHERE u.status = ?";
    params.push(statusFilter);
  } else if (resetFilter) {
    sql += " WHERE u.reset_requested_at IS NOT NULL";
  }
  // 待处理项置顶：待审批注册 > 待处理重置申请 > 其他
  sql +=
    " ORDER BY CASE WHEN u.status = 'pending' THEN 0" +
    " WHEN u.reset_requested_at IS NOT NULL THEN 1 ELSE 2 END, u.created_at DESC";

  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json(rows.results);
});

// ---- 管理员：审批通过注册申请（同时分配角色）----
auth.put("/users/:id/approve", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可操作" }, 403);

  const id = c.req.param("id");
  const body = await c.req.json<{ role_id?: string | null }>().catch(() => ({ role_id: null as string | null }));

  const target = await c.env.DB.prepare("SELECT role, status FROM users WHERE id = ?").bind(id).first<{ role: string; status: string }>();
  if (!target) return c.json({ error: "用户不存在" }, 404);

  // 校验角色存在（允许不分配角色，此时用户登录后看不到任何菜单）
  let finalRoleId: string | null = null;
  if (body.role_id) {
    const r = await c.env.DB.prepare("SELECT id FROM roles WHERE id = ?").bind(body.role_id).first();
    if (!r) return c.json({ error: "角色不存在" }, 400);
    finalRoleId = body.role_id;
  }

  await c.env.DB.prepare("UPDATE users SET status = 'active', role_id = ? WHERE id = ?")
    .bind(finalRoleId, id).run();
  return c.json({ ok: true });
});

// ---- 管理员：拒绝注册申请（保留记录，标记 rejected，便于对方看到明确提示）----
auth.put("/users/:id/reject", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可操作" }, 403);

  const id = c.req.param("id");
  if (id === session.userId) return c.json({ error: "不能操作自己" }, 400);

  const target = await c.env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(id).first();
  if (!target) return c.json({ error: "用户不存在" }, 404);

  await c.env.DB.prepare("UPDATE users SET status = 'rejected' WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ---- 管理员：处理忘记密码申请 ----
// action = "reset"  → 同时设置新密码（建议用临时密码，用户登录后自行修改）
// action = "dismiss" → 仅清除申请（例如核对后确认是本人误操作，不改密码）
auth.put("/users/:id/reset-password", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可操作" }, 403);

  const id = c.req.param("id");
  const body = await c.req.json<{ action?: string; password?: string }>()
    .catch(() => ({ action: "reset", password: "" }));

  const target = await c.env.DB.prepare("SELECT id, name FROM users WHERE id = ?")
    .bind(id).first<{ id: string; name: string }>();
  if (!target) return c.json({ error: "用户不存在" }, 404);

  if (body.action === "dismiss") {
    await c.env.DB.prepare("UPDATE users SET reset_requested_at = NULL WHERE id = ?").bind(id).run();
    return c.json({ ok: true });
  }

  if (!body.password || body.password.length < 6) {
    return c.json({ error: "新密码至少 6 位" }, 400);
  }

  const passwordHash = await hashPassword(body.password);
  // 清除申请 + 打上「需自行修改密码」标记，让用户下次登录后马上改掉临时密码
  await c.env.DB.prepare(
    "UPDATE users SET password_hash = ?, reset_requested_at = NULL, must_change_password = 1 WHERE id = ?"
  ).bind(passwordHash, id).run();

  return c.json({ ok: true });
});

// ---- 修改自己的密码（登录后可用）----
// 忘记密码被管理员重置后，用户用临时密码登录，这里提供自行修改入口。
auth.put("/me/password", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const { old_password, new_password } = await c.req.json<{ old_password: string; new_password: string }>();
  if (!old_password || !new_password) return c.json({ error: "原密码和新密码均为必填" }, 400);
  if (new_password.length < 6) return c.json({ error: "新密码至少 6 位" }, 400);
  if (old_password === new_password) return c.json({ error: "新密码不能与原密码相同" }, 400);

  const user = await c.env.DB.prepare("SELECT id, password_hash FROM users WHERE id = ?")
    .bind(session.userId).first<{ id: string; password_hash: string }>();
  if (!user) return c.json({ error: "用户不存在" }, 401);

  if (user.password_hash !== await hashPassword(old_password)) {
    return c.json({ error: "原密码不正确" }, 400);
  }

  await c.env.DB.prepare(
    "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?"
  ).bind(await hashPassword(new_password), session.userId).run();

  return c.json({ ok: true });
});

// ---- 管理员：修改用户角色 ----
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
