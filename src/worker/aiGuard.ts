// AI 辅助能力的横切护栏：出域脱敏 / 调用配额 / 输入截断 / 结果落库与缓存。
// 为什么单独一个文件：简历解读、沟通文案、面试问题、综合评估四个功能共用同一套
// 安全策略，散进各路由必然有人漏写——集中一处，新增 AI 功能只调这里即可。
//
// 设计取舍：配额不用 KV 而用 ai_artifacts 表按日 COUNT。
// 原因：① 不用新增 KV namespace（省一次 wrangler kv create + 两份配置改动）；
//       ② 避开「KV expirationTtl 必须 ≥60s」的坑（按日配额天然需要 24h+ TTL）；
//       ③ 同一张表顺便承担缓存职责，一举两得。

/** 每用户每日 AI 调用上限；超出返回 429，按中国时区凌晨重置 */
export const AI_DAILY_LIMIT = 10;

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
  limit: number;
}

/** 今日已用次数（只 COUNT，不写库） */
export async function checkQuota(db: D1Database, userId: string): Promise<QuotaInfo> {
  const row = await db
    .prepare("SELECT COUNT(*) AS c FROM ai_artifacts WHERE owner_id = ? AND created_at >= ?")
    .bind(userId, chinaDayStartUtc())
    .first<{ c: number }>();
  const used = row?.c ?? 0;
  return { ok: used < AI_DAILY_LIMIT, used, limit: AI_DAILY_LIMIT };
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
