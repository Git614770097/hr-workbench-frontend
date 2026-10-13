// AI 辅助能力的横切护栏：出域脱敏 / 调用配额 / 输入截断 / 结果落库与缓存。
// 为什么单独一个文件：简历解读、沟通文案、面试问题、综合评估四个功能共用同一套
// 安全策略，散进各路由必然有人漏写——集中一处，新增 AI 功能只调这里即可。
//
// 设计取舍：配额不用 KV 而用 ai_artifacts 表按日 COUNT。
// 原因：① 不用新增 KV namespace（省一次 wrangler kv create + 两份配置改动）；
//       ② 避开「KV expirationTtl 必须 ≥60s」的坑（按日配额天然需要 24h+ TTL）；
//       ③ 同一张表顺便承担缓存职责，一举两得。

/** 普通用户每日 AI 调用上限默认值；可在系统设置→AI 配额里改，管理员不受限 */
export const AI_DAILY_LIMIT = 20;

/** site_settings 里存该配置的 key（值为 JSON：{ "limit": 20 }） */
export const AI_QUOTA_SETTING_KEY = "ai_quota_config";

/** 同对象同场景的缓存有效期（分钟）：期内重复请求直接读库，不烧 token */
export const AI_CACHE_MINUTES = 10;

/**
 * 出域前脱敏：手机号 / 邮箱 / 身份证。
 * HR 数据出域是底线——AI 写文案、做解读都不需要真实手机号，所以一律掩码后再进 prompt。
 * 注意：只掩码，不删除上下文，模型仍能看出"这里有个联系方式"。
 */
export function maskPii(text: string): string {
  if (!text) return "";
  return text
    .replace(/(1[3-9]\d)\d{4}(\d{4})/g, "$1****$2") // 手机号 138****1234
    .replace(/([A-Za-z0-9._%+-]{2})[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1***$2") // 邮箱 li***@xx.com
    .replace(/(\d{6})\d{8}(\d{4})/g, "$1********$2"); // 18 位身份证
}

/** 输入截断：防止超长简历/文本把账单刷爆 */
export function truncate(text: string, max = 4000): string {
  const t = (text || "").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max)}\n…（原文过长，已截断）` : t;
}

/** 中国时区当天 00:00 对应的 UTC 时刻（D1 存 UTC，按日统计必须显式换算，否则凌晨跨天错位） */
export function chinaDayStartUtc(d: Date = new Date()): string {
  const cn = new Date(d.getTime() + 8 * 3600 * 1000);
  cn.setUTCHours(0, 0, 0, 0);
  return new Date(cn.getTime() - 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

/** N 分钟前的 UTC 时刻（缓存窗口用） */
function minutesAgoUtc(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

export interface QuotaInfo {
  ok: boolean;
  used: number;
  /** 生效上限；管理员为 -1 表示不限 */
  limit: number;
  unlimited: boolean;
}

/**
 * 读当前生效的每日上限（管理员可在系统设置里改）。
 * 配置不存在/非法时回落到 AI_DAILY_LIMIT 默认值。
 */
export async function loadDailyLimit(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM site_settings WHERE key = ?")
    .bind(AI_QUOTA_SETTING_KEY)
    .first<{ value: string }>();
  if (!row?.value) return AI_DAILY_LIMIT;
  try {
    const v = JSON.parse(row.value);
    const n = Math.floor(Number(v?.limit));
    // 0 视为"不限"，其余非法值回落默认；上界 9999 防手滑
    if (Number.isFinite(n) && n >= 0 && n <= 9999) return n;
  } catch {
    /* 落到默认 */
  }
  return AI_DAILY_LIMIT;
}

/** 今日已用次数（只 COUNT，不写库）。管理员不限额，但仍统计已用次数便于展示。 */
export async function checkQuota(db: D1Database, userId: string, role?: string): Promise<QuotaInfo> {
  const row = await db
    .prepare("SELECT COUNT(*) AS c FROM ai_artifacts WHERE owner_id = ? AND created_at >= ?")
    .bind(userId, chinaDayStartUtc())
    .first<{ c: number }>();
  const used = row?.c ?? 0;
  // 管理员不限：limit 记 -1，前端据此隐藏进度/不显示"已用完"
  if (role === "admin") return { ok: true, used, limit: -1, unlimited: true };
  const limit = await loadDailyLimit(db);
  // limit = 0 语义为「不限制」（管理员可把普通用户也放开）
  if (limit === 0) return { ok: true, used, limit: 0, unlimited: true };
  return { ok: used < limit, used, limit, unlimited: false };
}

/** 读缓存：同用户 + 同对象 + 同场景，且创建时间在有效期内（用于「重新生成」时省 token） */
export async function loadRecentArtifact(
  db: D1Database,
  userId: string,
  bizType: string,
  bizId: string,
  scene: string | null
): Promise<Record<string, unknown> | null> {
  const row = await db
    .prepare(
      `SELECT content FROM ai_artifacts
       WHERE owner_id = ? AND biz_type = ? AND biz_id = ?
         AND IFNULL(scene, '') = ? AND created_at >= ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(userId, bizType, bizId, scene ?? "", minutesAgoUtc(AI_CACHE_MINUTES))
    .first<{ content: string }>();
  if (!row?.content) return null;
  try {
    const obj = JSON.parse(row.content);
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * 读「最近一次」已生成结果，不限时间（用于下次进入页面时直接展示历史产出）。
 * 不消耗配额、不调 AI——只是把上次落库的内容取回来。
 * scene 传 undefined 表示「不限场景，取该对象最近一条」（沟通文案用）；
 * 传具体值（含 ""）则按场景精确匹配。
 */
export async function loadLatestArtifact(
  db: D1Database,
  userId: string,
  bizType: string,
  bizId: string,
  scene?: string
): Promise<Record<string, unknown> | null> {
  let sql = `SELECT content FROM ai_artifacts
       WHERE owner_id = ? AND biz_type = ? AND biz_id = ?`;
  const binds: (string | null)[] = [userId, bizType, bizId];
  if (scene !== undefined) {
    sql += ` AND IFNULL(scene, '') = ?`;
    binds.push(scene ?? "");
  }
  sql += ` ORDER BY created_at DESC LIMIT 1`;
  const row = await db
    .prepare(sql)
    .bind(...(binds as string[]))
    .first<{ content: string }>();
  if (!row?.content) return null;
  try {
    const obj = JSON.parse(row.content);
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 落库：同时充当配额计数与缓存源 */
export async function saveArtifact(
  db: D1Database,
  userId: string,
  bizType: string,
  bizId: string,
  scene: string | null,
  content: unknown
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO ai_artifacts (id, owner_id, biz_type, biz_id, scene, content) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(crypto.randomUUID(), userId, bizType, bizId, scene, JSON.stringify(content))
    .run();
}
