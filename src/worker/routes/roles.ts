import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { MENU_KEYS } from "../permissions";
import { genId } from "../helpers";

const roles = new Hono<{ Bindings: Env }>();

interface RoleRow {
  id: string;
  name: string;
  permissions: string;
  created_at: string;
}

function parsePermissions(raw: string): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// 校验 permissions 只含合法菜单 key，返回清理后的数组
function sanitizePermissions(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter((k): k is string => typeof k === "string" && (MENU_KEYS as readonly string[]).includes(k));
}

// 所有角色操作仅管理员可用
async function requireAdmin(c: any) {
  const session = await getSession(c);
  if (!session) return { error: "未登录", status: 401 };
  if (session.role !== "admin") return { error: "无权限，仅管理员可操作", status: 403 };
  return { session };
}

// 列表
roles.get("/", async (c) => {
  const admin = await requireAdmin(c);
  if ("error" in admin) return c.json({ error: admin.error }, admin.status as any);

  const rows = await c.env.DB.prepare("SELECT id, name, permissions, created_at FROM roles ORDER BY created_at").all<RoleRow>();
  const list = rows.results.map((r) => ({
    id: r.id,
    name: r.name,
    permissions: parsePermissions(r.permissions),
    created_at: r.created_at,
  }));
  return c.json(list);
});

// 新建角色
roles.post("/", async (c) => {
  const admin = await requireAdmin(c);
  if ("error" in admin) return c.json({ error: admin.error }, admin.status as any);

  const { name, permissions } = await c.req.json<{ name: string; permissions: string[] }>();
  if (!name || !name.trim()) return c.json({ error: "角色名不能为空" }, 400);

  const existing = await c.env.DB.prepare("SELECT id FROM roles WHERE name = ?").bind(name.trim()).first();
  if (existing) return c.json({ error: "角色名已存在" }, 409);

  const id = genId();
  const perms = sanitizePermissions(permissions);
  await c.env.DB.prepare("INSERT INTO roles (id, name, permissions) VALUES (?, ?, ?)")
    .bind(id, name.trim(), JSON.stringify(perms)).run();

  return c.json({ id, name: name.trim(), permissions: perms });
});

// 更新角色（名 + 权限）
roles.put("/:id", async (c) => {
  const admin = await requireAdmin(c);
  if ("error" in admin) return c.json({ error: admin.error }, admin.status as any);

  const id = c.req.param("id");
  const { name, permissions } = await c.req.json<{ name?: string; permissions?: string[] }>();

  const role = await c.env.DB.prepare("SELECT * FROM roles WHERE id = ?").bind(id).first<RoleRow>();
  if (!role) return c.json({ error: "角色不存在" }, 404);

  const nextName = name && name.trim() ? name.trim() : role.name;
  if (name && name.trim()) {
    const dup = await c.env.DB.prepare("SELECT id FROM roles WHERE name = ? AND id != ?").bind(nextName, id).first();
    if (dup) return c.json({ error: "角色名已存在" }, 409);
  }

  const nextPerms = permissions !== undefined ? sanitizePermissions(permissions) : parsePermissions(role.permissions);

  await c.env.DB.prepare("UPDATE roles SET name = ?, permissions = ? WHERE id = ?")
    .bind(nextName, JSON.stringify(nextPerms), id).run();

  return c.json({ id, name: nextName, permissions: nextPerms });
});

// 删除角色（有用户引用的角色不允许删）
roles.delete("/:id", async (c) => {
  const admin = await requireAdmin(c);
  if ("error" in admin) return c.json({ error: admin.error }, admin.status as any);

  const id = c.req.param("id");
  const used = await c.env.DB.prepare("SELECT COUNT(*) as n FROM users WHERE role_id = ?").bind(id).first<{ n: number }>();
  if ((used?.n || 0) > 0) return c.json({ error: "该角色下仍有用户，无法删除" }, 400);

  await c.env.DB.prepare("DELETE FROM roles WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

export { roles as roleRoutes };
