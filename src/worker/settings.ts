/**
 * site_settings 简单键值表的读写助手。
 *
 * 支付收款码、数据字典、更新公告、AI 配额、老带新配置、邀请配置都存这张表
 * （都是低频读写、值型配置，为它们各建一张表反而更啰嗦）。
 * 之前每个模块各写一份 SELECT / UPSERT，新增一个配置项要在多处确认写法一致；
 * 收敛到这里后，读写只有一份实现。
 *
 * 安全：批量查询的 IN 占位符由 keys 长度生成（只拼 `?`，不拼任何外部字符串），
 *       值一律走 bind。
 */

/** 读单个配置的原始字符串值；不存在返回 null（调用方自行决定默认值） */
export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM site_settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/** 批量读：返回 key → value 映射（缺失的 key 不出现在结果里） */
export async function getSettings(
  db: D1Database,
  keys: readonly string[]
): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  const ph = keys.map(() => "?").join(",");
  const rows = await db
    .prepare(`SELECT key, value FROM site_settings WHERE key IN (${ph})`)
    .bind(...(keys as string[]))
    .all<{ key: string; value: string }>();
  const map: Record<string, string> = {};
  (rows.results || []).forEach((r) => { map[r.key] = r.value; });
  return map;
}

/**
 * 写入（存在则覆盖）一批配置项。
 * 用 upsert 而不是「先查再插/改」：少一次往返，也避免并发下重复键报错。
 */
export async function setSettings(db: D1Database, items: readonly [string, string][]): Promise<void> {
  for (const [k, v] of items) {
    await db
      .prepare(
        "INSERT INTO site_settings (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .bind(k, v)
      .run();
  }
}
