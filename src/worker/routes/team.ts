// 团队管理（管理员 / manager）
//
// 角色模型：超管（admin）→ 管理员（manager）→ 子用户（user）。
// - 管理员的 team_id = 自己的 id（自建团队）；子用户 team_id = 管理员 id。
// - 数据共享通过 scope.ts 的 ownerScope 实现（同 team_id 互相可见可编辑）。
// - 这里只负责「人」和「角色」：创建子用户、分配角色、停用/移出、建团队角色。
//
// 权限红线：
// - 管理员不能创建/提升 admin 或 manager；
// - 管理员分配的角色不许包含超管专属菜单（users）；
// - 管理员只能改自己团队内的成员；角色只能改自己创建的（全局角色只读）。

import { Hono } from "hono";
import type { Env } from "../index";
import { getSession, hashPassword } from "./auth";
import { isPrivileged } from "../scope";
import { parsePermissions } from "../permissions";
import { genId } from "../helpers";
import { newReferralCode } from "../referral";

const team = new Hono<{ Bindings: Env }>();

// 超管专属菜单：管理员创建/分配角色时一律剔除，防止子用户摸到用户管理
const ADMIN_ONLY_KEYS = new Set(["users"]);

function cleanPerms(perms: unknown): string[] {
  if (!Array.isArray(perms)) return [];
  return perms.filter((k): k is string => typeof k === "string" && !ADMIN_ONLY_KEYS.has(k));
}

async function requireManager(c: any) {
  const session = await getSession(c);
  if (!session) return { session: null, err: c.json({ error: "未登录" }, 401) };
  if (!isPrivileged(session)) return { session: null, err: c.json({ error: "无权限，仅管理员可操作" }, 403) };
  // manager 的 team_id 即自己的 id；admin 的 team_id 为 NULL，操作对象为空团队（admin 用用户管理页）
  const teamId = session.role === "manager" ? session.userId : (session.teamId || session.userId);
  return { session, teamId, err: null };
}

/** 校验角色对当前管理员可见且合规：全局角色（owner_id IS NULL）或自己创建的，且不含超管菜单 */
async function assignableRole(db: D1Database, teamId: string, roleId: string) {
  const r = await db.prepare("SELECT id, permissions, owner_id FROM roles WHERE id = ?").bind(roleId).first<{ id: string; permissions: string; owner_id: string | null }>();
  if (!r) return { ok: false as const, error: "角色不存在" };
  if (r.owner_id && r.owner_id !== teamId) return { ok: false as const, error: "只能使用全局角色或自己创建的角色" };
  const perms = parsePermissions(r.permissions);
  if (perms.some((k) => ADMIN_ONLY_KEYS.has(k))) return { ok: false as const, error: "该角色包含超管专属权限，不能分配给子用户" };
  return { ok: true as const, role: r };
}

// ---- 团队成员列表 ----
team.get("/members", async (c) => {
  const { session, teamId, err } = await requireManager(c);
  if (err) return err;
  const rows = await c.env.DB.prepare(
    "SELECT u.id, u.phone, u.name, u.status, u.role_id, u.created_at, u.must_change_password, r.name AS role_name " +
    "FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.team_id = ? ORDER BY u.created_at ASC"
  ).bind(teamId).all();
  const me = { id: session!.userId, name: session!.name };
  return c.json({ me, items: rows.results || [] });
});

// ---- 创建子用户（立即生效，免超管审批；首次登录需改密）----
team.post("/members", async (c) => {
  const { teamId, err } = await requireManager(c);
  if (err) return err;
  const body = await c.req.json<{ name?: string; phone?: string; password?: string; role_id?: string | null }>().catch(() => null);
  if (!body) return c.json({ error: "请求参数格式不正确" }, 400);
  const name = (body.name || "").trim();
  const phone = (body.phone || "").trim();
  const password = body.password || "";
  if (!name) return c.json({ error: "请输入姓名" }, 400);
  if (!/^1[3-9]\d{9}$/.test(phone)) return c.json({ error: "手机号格式不正确" }, 400);
  if (password.length < 6) return c.json({ error: "初始密码至少 6 位" }, 400);

  const dup = await c.env.DB.prepare("SELECT id FROM users WHERE phone = ?").bind(phone).first();
  if (dup) return c.json({ error: "该手机号已被注册" }, 400);

  if (body.role_id) {
    const check = await assignableRole(c.env.DB, teamId!, body.role_id);
    if (!check.ok) return c.json({ error: check.error }, 400);
  }

  const id = genId();
  const code = await newReferralCode(c.env.DB);
  // paid_until 继承管理员自己的：不填会被次日定时任务判为「NULL=过期」冻成只读，
  // 新成员建完第二天就变冻结、管理员还找不到原因（建队流程与付费口径必须闭环）。
  await c.env.DB.prepare(
    "INSERT INTO users (id, phone, name, password_hash, role, role_id, status, team_id, referral_code, intended_role, must_change_password, paid_until) " +
    "SELECT ?, ?, ?, ?, 'user', ?, 'active', ?, ?, 'hr', 1, paid_until FROM users WHERE id = ?"
  ).bind(id, phone, name, await hashPassword(password), body.role_id || null, teamId, code, teamId).run();
  return c.json({ ok: true, id });
});

// ---- 修改成员：分配角色 / 改名 / 停用 / 启用 ----
team.put("/members/:id", async (c) => {
  const { teamId, err } = await requireManager(c);
  if (err) return err;
  const id = c.req.param("id");
  const target = await c.env.DB.prepare("SELECT id, role, team_id FROM users WHERE id = ?").bind(id).first<{ id: string; role: string; team_id: string | null }>();
  if (!target || target.team_id !== teamId) return c.json({ error: "成员不存在或不属于本团队" }, 404);
  if (target.role !== "user") return c.json({ error: "不能操作管理员账号" }, 400);

  const body: { role_id?: string | null; status?: string; name?: string } =
    await c.req.json<{ role_id?: string | null; status?: string; name?: string }>().catch(() => ({}));
  if (body.role_id !== undefined) {
    if (body.role_id === null) {
      await c.env.DB.prepare("UPDATE users SET role_id = NULL WHERE id = ?").bind(id).run();
    } else {
      const check = await assignableRole(c.env.DB, teamId!, body.role_id);
      if (!check.ok) return c.json({ error: check.error }, 400);
      await c.env.DB.prepare("UPDATE users SET role_id = ? WHERE id = ?").bind(body.role_id, id).run();
    }
  }
  if (body.status === "active" || body.status === "disabled") {
    await c.env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(body.status, id).run();
  }
  const name = (body.name || "").trim();
  if (name) await c.env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name, id).run();
  return c.json({ ok: true });
});

// ---- 重置成员密码（生成临时密码，首次登录强制修改）----
team.post("/members/:id/reset-password", async (c) => {
  const { teamId, err } = await requireManager(c);
  if (err) return err;
  const id = c.req.param("id");
  const target = await c.env.DB.prepare("SELECT id, role, team_id FROM users WHERE id = ?").bind(id).first<{ id: string; role: string; team_id: string | null }>();
  if (!target || target.team_id !== teamId) return c.json({ error: "成员不存在或不属于本团队" }, 404);
  if (target.role !== "user") return c.json({ error: "不能操作管理员账号" }, 400);

  const body: { password?: string } = await c.req.json<{ password?: string }>().catch(() => ({}));
  const password = body.password || "";
  if (password.length < 6) return c.json({ error: "新密码至少 6 位" }, 400);
  await c.env.DB.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?").bind(await hashPassword(password), id).run();
  return c.json({ ok: true });
});

// ---- 移出团队：team_id 置空，其数据立刻对团队不可见（getSession 每次现查 team_id，立即生效）----
team.post("/members/:id/remove", async (c) => {
  const { teamId, err } = await requireManager(c);
  if (err) return err;
  const id = c.req.param("id");
  const target = await c.env.DB.prepare("SELECT id, role, team_id FROM users WHERE id = ?").bind(id).first<{ id: string; role: string; team_id: string | null }>();
  if (!target || target.team_id !== teamId) return c.json({ error: "成员不存在或不属于本团队" }, 404);
  if (target.role !== "user") return c.json({ error: "不能操作管理员账号" }, 400);
  await c.env.DB.prepare("UPDATE users SET team_id = NULL, role_id = NULL WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ---- 团队角色：列表（全局 + 自己创建的，剔除含超管菜单的）----
team.get("/roles", async (c) => {
  const { teamId, err } = await requireManager(c);
  if (err) return err;
  const rows = await c.env.DB.prepare(
    "SELECT id, name, permissions, owner_id, created_at FROM roles WHERE owner_id IS NULL OR owner_id = ? ORDER BY created_at ASC"
  ).bind(teamId).all<any>();
  const items = (rows.results || [])
    .map((r) => ({ ...r, permissions: parsePermissions(r.permissions) }))
    .filter((r) => !r.permissions.some((k: string) => ADMIN_ONLY_KEYS.has(k)));
  return c.json({ items });
});

// ---- 团队角色：创建 ----
team.post("/roles", async (c) => {
  const { teamId, err } = await requireManager(c);
  if (err) return err;
  const body = await c.req.json<{ name?: string; permissions?: string[] }>().catch(() => null);
  if (!body) return c.json({ error: "请求参数格式不正确" }, 400);
  const name = (body.name || "").trim();
  if (!name) return c.json({ error: "请输入角色名称" }, 400);
  const permissions = cleanPerms(body.permissions);
  const id = genId();
  await c.env.DB.prepare("INSERT INTO roles (id, name, permissions, owner_id) VALUES (?, ?, ?, ?)")
    .bind(id, name, JSON.stringify(permissions), teamId).run();
  return c.json({ ok: true, id });
});

// ---- 团队角色：修改（仅自己创建的）----
team.put("/roles/:id", async (c) => {
  const { teamId, err } = await requireManager(c);
  if (err) return err;
  const id = c.req.param("id");
  const role = await c.env.DB.prepare("SELECT owner_id FROM roles WHERE id = ?").bind(id).first<{ owner_id: string | null }>();
  if (!role) return c.json({ error: "角色不存在" }, 404);
  if (role.owner_id !== teamId) return c.json({ error: "只能修改自己创建的角色" }, 403);
  const body: { name?: string; permissions?: string[] } = await c.req.json<{ name?: string; permissions?: string[] }>().catch(() => ({}));
  if ((body.name || "").trim()) await c.env.DB.prepare("UPDATE roles SET name = ? WHERE id = ?").bind(body.name!.trim(), id).run();
  if (Array.isArray(body.permissions)) {
    await c.env.DB.prepare("UPDATE roles SET permissions = ? WHERE id = ?").bind(JSON.stringify(cleanPerms(body.permissions)), id).run();
  }
  return c.json({ ok: true });
});

// ---- 团队角色：删除（仅自己创建的，且有成员使用时禁止）----
team.delete("/roles/:id", async (c) => {
  const { teamId, err } = await requireManager(c);
  if (err) return err;
  const id = c.req.param("id");
  const role = await c.env.DB.prepare("SELECT owner_id, name FROM roles WHERE id = ?").bind(id).first<{ owner_id: string | null; name: string }>();
  if (!role) return c.json({ error: "角色不存在" }, 404);
  if (role.owner_id !== teamId) return c.json({ error: "只能删除自己创建的角色" }, 403);
  const used = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role_id = ?").bind(id).first<{ n: number }>();
  if (used && used.n > 0) return c.json({ error: `仍有 ${used.n} 个成员使用该角色，请先调整成员角色` }, 400);
  await c.env.DB.prepare("DELETE FROM roles WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

export default team;
