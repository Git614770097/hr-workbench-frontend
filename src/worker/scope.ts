// 团队数据共享：统一的数据范围（data scope）条件生成器。
//
// 背景：改造前数据隔离是硬编码的两层——admin 看全量，其余只看 owner_id=自己。
// 团队共享需求在中间加了一层：同 team_id 的用户（管理员 + 其创建的子用户）
// 互相可见/可编辑业务数据。
//
// 约定：
//  - admin：不加任何条件（全量）
//  - 有 team_id（管理员或团队成员）：owner_id 落在同队用户集合内（子查询 users 表）
//  - 无 team_id：仅自己
//
// 用法：
//   const sc = ownerScope(session, "t.owner_id");
//   const rows = await db.prepare(`SELECT ... FROM talents t WHERE 1=1 ${sc.sql}`).bind(...sc.params).all();
// 注意：SQL 里每出现一次 sc.sql 就要展开一次 sc.params（占位符数量必须与参数一致）。

export interface ScopeSession {
  userId: string;
  role: string;
  teamId?: string | null;
}

export function ownerScope(session: ScopeSession, col = "owner_id"): { sql: string; params: string[] } {
  if (session.role === "admin") return { sql: "", params: [] };
  if (session.teamId) {
    return { sql: ` AND ${col} IN (SELECT id FROM users WHERE team_id = ?)`, params: [session.teamId] };
  }
  return { sql: ` AND ${col} = ?`, params: [session.userId] };
}

// 便捷版：返回「WHERE 之后第一个条件」形态（无前导 AND），用于 conditions 数组模式。
// conditions.push(...scopeConds(session, "t.owner_id")) 后 params.push(...scopeParams(session))。
// 注意该形态每个 session 只用一次；同一 SQL 若有两个 scope 条件请改用 ownerScope 拼串。
export function scopeConds(session: ScopeSession, col = "owner_id"): string[] {
  if (session.role === "admin") return [];
  if (session.teamId) return [`${col} IN (SELECT id FROM users WHERE team_id = ?)`];
  return [`${col} = ?`];
}

export function scopeParams(session: ScopeSession): string[] {
  if (session.role === "admin") return [];
  if (session.teamId) return [session.teamId];
  return [session.userId];
}

// 管理员（manager）及以上：后端接口的守卫判断。
export function isPrivileged(session: ScopeSession): boolean {
  return session.role === "admin" || session.role === "manager";
}

/** 行级归属校验：给定记录的 owner_id，判断当前会话是否可读/可写该记录。
 *  用于「先查行再判断」的写接口（PUT/DELETE），替代散落的
 *  `session.role !== "admin" && row.owner_id !== session.userId` 判断。
 *  admin 恒真；本人恒真；同 team_id 的其他成员可读可写。 */
export async function canTouch(env: { DB: { prepare: (s: string) => { bind: (...a: string[]) => { first: <T>() => Promise<T | null> } } } }, session: ScopeSession, ownerId: string): Promise<boolean> {
  if (session.role === "admin") return true;
  if (ownerId === session.userId) return true;
  if (!session.teamId) return false;
  const u = await env.DB.prepare("SELECT team_id FROM users WHERE id = ?").bind(ownerId).first<{ team_id: string | null }>();
  return !!u && u.team_id === session.teamId;
}
