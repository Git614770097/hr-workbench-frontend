// 飞书开放平台客户端（BYOK）。
//
// 背景：把 HR 工作台的到期待办/面试/审批/管理事件通过飞书送达。凭证由客户各自的
// 飞书自建应用提供（BYOK），敏感字段 AES-GCM 加密落库（复用 aiKey 的加密实现，主密钥
// 走 AI_KEY_SECRET）。A 层（用户级）走 OAuth 授权拿 open_id + im/v1/messages 发消息；
// 事件回调解密用 WebCrypto（Workers 无 Node crypto）。
//
// 端点路径以飞书开放平台当前文档为准（版本可能调整），集中在下方常量，便于核对。

import { decryptAiKey } from "./aiKey";

const FEISHU_BASE = "https://open.feishu.cn";
// 授权页主机与 API 主机不同：OpenAPI（token/发消息）在 open.feishu.cn，
// 用户授权页 authen/v1/authorize 在 accounts.feishu.cn（官方文档示例，
// 曾误用 open.feishu.cn 导致绑定链接打不开）。见飞书文档「获取授权码」。
const FEISHU_AUTHORIZE_HOST = "https://accounts.feishu.cn";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
}

interface FeishuAppRow {
  id: string;
  team_id: string | null;
  name: string | null;
  app_id: string;
  app_secret_enc: string;
  encrypt_key_enc: string | null;
  verification_token_enc: string | null;
  enabled: number;
}

/** 把一行落库配置解密成可用凭证；主密钥缺失或解密失败返回 null（调用方按「未配置」处理）。 */
async function decodeAppRow(row: FeishuAppRow, secret: string | undefined): Promise<FeishuConfig | null> {
  if (!secret) return null;
  const appSecret = await decryptAiKey(row.app_secret_enc, secret);
  if (!appSecret) return null;
  const encryptKey = row.encrypt_key_enc ? await decryptAiKey(row.encrypt_key_enc, secret) : undefined;
  const verificationToken = row.verification_token_enc ? await decryptAiKey(row.verification_token_enc, secret) : undefined;
  return { appId: row.app_id, appSecret, encryptKey: encryptKey || undefined, verificationToken: verificationToken || undefined };
}

/**
 * 解析本次该用的飞书应用：优先本团队自配（team_id 匹配，多企业 BYOK 覆盖），
 * 否则回落全局默认（team_id IS NULL，单运营部署即用此条）。主密钥未配置则整体关闭。
 */
export async function resolveFeishuApp(
  db: D1Database,
  teamId?: string | null,
  secret?: string
): Promise<FeishuConfig | null> {
  if (teamId) {
    const teamRow = await db
      .prepare("SELECT * FROM feishu_apps WHERE team_id = ? AND enabled = 1")
      .bind(teamId)
      .first<FeishuAppRow>();
    if (teamRow) {
      const cfg = await decodeAppRow(teamRow, secret);
      if (cfg) return cfg;
    }
  }
  const globalRow = await db
    .prepare("SELECT * FROM feishu_apps WHERE team_id IS NULL AND enabled = 1")
    .first<FeishuAppRow>();
  return globalRow ? await decodeAppRow(globalRow, secret) : null;
}

/**
 * 取 tenant_access_token，带 KV 缓存（规避飞书申请频率限制）。
 * tenant_access_token 有效期 7200s，这里提前 ~10 分钟续，且不低于 KV 下限 60s。
 */
export async function getTenantAccessToken(kv: KVNamespace, cfg: FeishuConfig): Promise<string | null> {
  const cacheKey = `feishu:token:${cfg.appId}`;
  const cached = await kv.get(cacheKey);
  if (cached) return cached;
  let res: Response;
  try {
    res = await fetch(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    });
  } catch (err) {
    console.error("[feishu] token request failed:", err);
    return null;
  }
  const data = (await res.json()) as { code?: number; tenant_access_token?: string; expire?: number; msg?: string };
  if (data.code !== 0 || !data.tenant_access_token) {
    console.error("[feishu] token error:", data.code, data.msg);
    return null;
  }
  const ttl = Math.max(60, Math.min(6600, (data.expire || 7200) - 600));
  await kv.put(cacheKey, data.tenant_access_token, { expirationTtl: ttl });
  return data.tenant_access_token;
}

/** 给某个 open_id 发一条纯文本消息。返回结构与 sendPushPlus 一致，便于调用方统一处理。 */
export async function sendFeishuText(
  kv: KVNamespace,
  cfg: FeishuConfig,
  openId: string,
  text: string
): Promise<{ ok: boolean; message: string }> {
  const token = await getTenantAccessToken(kv, cfg);
  if (!token) return { ok: false, message: "获取飞书 tenant_access_token 失败" };
  let res: Response;
  try {
    res = await fetch(`${FEISHU_BASE}/open-apis/im/v1/messages?receive_id_type=open_id`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) }),
    });
  } catch (err) {
    return { ok: false, message: `飞书发送请求异常：${err instanceof Error ? err.message : String(err)}` };
  }
  const data = (await res.json()) as { code?: number; msg?: string };
  const ok = res.ok && data.code === 0;
  return { ok, message: ok ? "发送成功" : `飞书发送失败：code ${data.code} ${data.msg || ""}` };
}

/** 拼接 OAuth 授权 URL（不带 scope，仅取基础身份，降低权限申请摩擦）。 */
export function buildAuthorizeUrl(cfg: FeishuConfig, state: string, redirectUri: string): string {
  // 官方参数：client_id 即应用的 App ID；response_type 固定 code；
  // scope 省略——本系统只用 code 换 open_id，不调用用户级 API（最小权限）。
  const u = new URL(`${FEISHU_AUTHORIZE_HOST}/open-apis/authen/v1/authorize`);
  u.searchParams.set("client_id", cfg.appId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

export interface FeishuUserInfo {
  openId: string;
  name?: string;
}

/**
 * 用授权码换 user_access_token → 读用户信息 → 返回 open_id。
 * OAuth 流程与参数以飞书当前文档为准。
 */
export async function exchangeCodeForUser(
  cfg: FeishuConfig,
  code: string,
  redirectUri: string
): Promise<{ user?: FeishuUserInfo; error?: string }> {
  // 1) code → user_access_token
  let tokenRes: Response;
  try {
    tokenRes = await fetch(`${FEISHU_BASE}/open-apis/authen/v2/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: cfg.appId,
        client_secret: cfg.appSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
  } catch (err) {
    return { error: `飞书授权请求异常：${err instanceof Error ? err.message : String(err)}` };
  }
  const tokenData = (await tokenRes.json()) as { code?: number; access_token?: string; error?: string; error_description?: string };
  if (tokenData.code !== 0 || !tokenData.access_token) {
    return { error: `飞书授权失败：${tokenData.error || tokenData.code}` };
  }
  // 2) user_access_token → 用户信息（open_id）
  let infoRes: Response;
  try {
    infoRes = await fetch(`${FEISHU_BASE}/open-apis/authen/v1/user_info`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
  } catch (err) {
    return { error: `飞书用户信息请求异常：${err instanceof Error ? err.message : String(err)}` };
  }
  const infoData = (await infoRes.json()) as { code?: number; data?: { open_id?: string; name?: string } };
  if (infoData.code !== 0 || !infoData.data?.open_id) {
    return { error: `读取飞书用户信息失败：code ${infoData.code}` };
  }
  return { user: { openId: infoData.data.open_id, name: infoData.data.name } };
}

/**
 * 解密飞书事件推送（Encrypt Key 方案）：AES-256-CBC，key = SHA256(encrypt_key)，PKCS7。
 * Workers 无 Node crypto，用 WebCrypto crypto.subtle。失败返回 null。
 */
export async function decryptFeishuEvent(encryptKey: string, encrypted: string): Promise<string | null> {
  try {
    const raw = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
    if (raw.length < 17) return null;
    const keyBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encryptKey)));
    const iv = raw.slice(0, 16);
    const body = raw.slice(16);
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, body);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

// ---- 群自定义机器人（webhook）：零应用依赖的群推送通道 ----

export interface FeishuWebhookRow {
  id: string;
  name: string;
  url: string;
}

/** 群机器人 webhook 形态粗校验（open.feishu.cn/open-apis/bot/v2/hook/xxx）。 */
export function isFeishuWebhookUrl(url: string): boolean {
  return /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+$/.test(url.trim());
}

/**
 * 往飞书群自定义机器人发一条文本消息。机器人只需在群里「添加自定义机器人」即可，
 * 无需应用凭证；但消息群里全员可见，且无法精准私信个人。
 * 飞书返回 code=0 为成功；常见失败：19021 关键词校验 / 19022 签名校验 / 19024 机器人被移出群。
 */
export async function sendFeishuWebhook(
  url: string,
  text: string
): Promise<{ ok: boolean; message: string }> {
  if (!isFeishuWebhookUrl(url)) return { ok: false, message: "webhook 地址格式不正确（应为 https://open.feishu.cn/open-apis/bot/v2/hook/... 形式）" };
  let res: Response;
  try {
    res = await fetch(url.trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text } }),
    });
  } catch (err) {
    return { ok: false, message: `飞书群机器人请求异常：${err instanceof Error ? err.message : String(err)}` };
  }
  const data = (await res.json().catch(() => null)) as { code?: number; msg?: string } | null;
  const ok = res.ok && data?.code === 0;
  const hint = data?.code === 19021 ? "（机器人设置了关键词校验，消息需包含约定关键词）"
    : data?.code === 19022 ? "（机器人设置了签名校验，暂不支持，请在群里关闭签名或改用应用私信）"
    : data?.code === 19024 ? "（机器人已被移出群聊）"
    : data?.code === 230006 ? "（机器人在群里被关闭，或企业管理员禁用了自定义机器人能力：群设置 → 群机器人 → 确认该机器人已开启）"
    : data?.code === 9499 ? "（请求体格式或大小不合规，应联系管理员）"
    : "";
  return { ok, message: ok ? "发送成功" : `飞书群机器人发送失败：code ${data?.code ?? "?"} ${data?.msg || ""}${hint}` };
}

/** 取启用中的群机器人 webhook：优先 team 自配，回落全局（team_id IS NULL），与 feishu_apps 同模式。 */
export async function resolveFeishuWebhooks(
  db: D1Database,
  teamId?: string | null,
  secret?: string
): Promise<FeishuWebhookRow[]> {
  if (!secret) return [];
  const { results } = await db.prepare(
    "SELECT id, team_id, name, url_enc FROM feishu_webhooks WHERE enabled = 1 AND (team_id IS NULL OR team_id = ?)"
  ).bind(teamId ?? null).all<{ id: string; team_id: string | null; name: string; url_enc: string }>();
  const teamRows: FeishuWebhookRow[] = [];
  const globalRows: FeishuWebhookRow[] = [];
  for (const r of results || []) {
    const url = await decryptAiKey(secret, r.url_enc).catch(() => null);
    if (!url) continue;
    const row: FeishuWebhookRow = { id: r.id, name: r.name, url };
    if (r.team_id) teamRows.push(row); // team 自配优先，全部缺失才回落全局
    else globalRows.push(row);
  }
  return teamRows.length > 0 ? teamRows : globalRows;
}
