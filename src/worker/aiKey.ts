// 用户自有 AI Key（BYOK：Bring Your Own Key）。
// 场景：系统每日 AI 配额用完时，用户可填自己的 DeepSeek Key 继续用——花自己的钱，
// 不占系统配额，也不用等管理员扩额度。
//
// 安全设计：
//   · Key 不明文落库：AES-GCM 256 加密后存 users.ai_key，主密钥走 wrangler secret
//     （AI_KEY_SECRET），代码/仓库/数据库里都拿不到明文；
//   · 主密钥未配置时功能整体关闭（PUT 直接拒绝），绝不降级成明文存储；
//   · 保存前先调 DeepSeek /models 验证 Key 真实有效，避免用户存错了还以为在用自己的额度；
//   · 掩码单独存一列（ai_key_masked），展示不依赖解密，secret 轮换也不影响显示。

/** 密文版本前缀（将来换算法时可识别旧数据） */
const CIPHER_PREFIX = "v1";

/** 把任意长度 secret 派生成 32 字节 AES 密钥（SHA-256） */
async function deriveKey(secret: string): Promise<CryptoKey> {
  const bytes = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 加密：返回 `v1:<iv>:<ciphertext>`（均 base64）。IV 每次随机 12 字节。 */
export async function encryptAiKey(plain: string, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain)
  );
  return `${CIPHER_PREFIX}:${toBase64(iv.buffer)}:${toBase64(cipher)}`;
}

/** 解密：secret 不匹配/数据损坏时返回 null（调用方按「未配置」处理，回落系统 Key） */
export async function decryptAiKey(stored: string, secret: string): Promise<string | null> {
  try {
    const parts = stored.split(":");
    if (parts.length !== 3 || parts[0] !== CIPHER_PREFIX) return null;
    const key = await deriveKey(secret);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(parts[1]) },
      key,
      fromBase64(parts[2])
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** 掩码：sk-****abcd（前后各留几位，足够用户认出是哪个 Key） */
export function maskAiKey(plain: string): string {
  const t = plain.trim();
  if (t.length <= 8) return "****";
  const head = t.slice(0, 3);
  const tail = t.slice(-4);
  return `${head}****${tail}`;
}

/** 调 DeepSeek /models 验证 Key 是否有效（最轻量的真实调用，不烧额度） */
export async function verifyDeepSeekKey(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch("https://api.deepseek.com/models", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.ok) return { ok: true };
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, error: "Key 无效或已过期，请检查后重填" };
    }
    return { ok: false, error: `DeepSeek 校验服务异常（${resp.status}），请稍后重试` };
  } catch {
    return { ok: false, error: "无法连接 DeepSeek 校验服务，请检查网络后重试" };
  }
}

/** DeepSeek Key 的宽松格式校验（先挡掉明显不是 Key 的输入，省一次网络请求） */
export function looksLikeDeepSeekKey(key: string): boolean {
  const t = key.trim();
  return t.length >= 20 && t.length <= 200 && /^[A-Za-z0-9_-]+$/.test(t);
}

export interface ResolvedAiKey {
  /** 实际可用的 Key；都没有时为 null */
  key: string | null;
  /** true = 用户自有 Key（花用户的钱，不占系统配额） */
  own: boolean;
  /**
   * 智谱 GLM Key（系统级，兜底使用）。
   * 未配置 ZHIPU_API_KEY 时为 null，调用层就只有 DeepSeek 一条路。
   */
  zhipu: string | null;
}

/**
 * 解析本次 AI 调用该用哪个 Key：
 * - `key` 是**主路径**：用户配了自有 Key 就用用户的，否则用系统 DeepSeek Key；
 * - `zhipu` 是**兜底**：仅在主路径失败（超时/限流/异常）时由调用层自动切换；
 * - 解密失败按未配处理。
 */
export async function resolveAiKey(
  env: { DB: D1Database; DEEPSEEK_API_KEY?: string; ZHIPU_API_KEY?: string; AI_KEY_SECRET?: string },
  userId: string
): Promise<ResolvedAiKey> {
  const systemKey = env.DEEPSEEK_API_KEY ?? null;
  const zhipu = env.ZHIPU_API_KEY ?? null;
  if (!env.AI_KEY_SECRET) return { key: systemKey, own: false, zhipu };
  try {
    const row = await env.DB.prepare("SELECT ai_key FROM users WHERE id = ?").bind(userId).first<{ ai_key: string | null }>();
    if (!row?.ai_key) return { key: systemKey, own: false, zhipu };
    const plain = await decryptAiKey(row.ai_key, env.AI_KEY_SECRET);
    if (!plain) return { key: systemKey, own: false, zhipu };
    return { key: plain, own: true, zhipu };
  } catch {
    return { key: systemKey, own: false, zhipu };
  }
}

/** 读取用户自有 Key 的展示信息（掩码在保存时算好，不依赖 secret） */
export async function loadOwnKeyInfo(
  db: D1Database,
  userId: string
): Promise<{ configured: boolean; masked: string | null }> {
  try {
    const row = await db
      .prepare("SELECT ai_key_masked FROM users WHERE id = ?")
      .bind(userId)
      .first<{ ai_key_masked: string | null }>();
    return { configured: !!row?.ai_key_masked, masked: row?.ai_key_masked ?? null };
  } catch {
    return { configured: false, masked: null };
  }
}
