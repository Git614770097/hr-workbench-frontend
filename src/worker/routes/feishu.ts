import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { sessionGet } from "../kv";
import { genId } from "../helpers";
import { encryptAiKey } from "../aiKey";
import {
  resolveFeishuApp,
  buildAuthorizeUrl,
  exchangeCodeForUser,
  sendFeishuText,
  decryptFeishuEvent,
} from "../feishu";

const feishu = new Hono<{ Bindings: Env }>();

// OAuth state 存 KV，防 CSRF；TTL 10 分钟够一次授权往返。
const OAUTH_STATE_TTL = 600;

/** 读取本 team / 全局的飞书配置（用于回显，敏感字段只回「是否已配」与掩码）。 */
feishu.get("/settings", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可配置" }, 403);
  const row = await c.env.DB.prepare(
    "SELECT id, team_id, name, app_id, encrypt_key_enc, verification_token_enc, enabled FROM feishu_apps WHERE team_id IS NULL"
  ).first<{ id: string; team_id: string | null; name: string | null; app_id: string; encrypt_key_enc: string | null; verification_token_enc: string | null; enabled: number }>();
  if (!row) return c.json({ configured: false });
  return c.json({
    configured: true,
    name: row.name,
    app_id: row.app_id,
    has_encrypt_key: !!row.encrypt_key_enc,
    has_verification_token: !!row.verification_token_enc,
    enabled: !!row.enabled,
  });
});

/** 保存/更新全局飞书应用凭证（admin）。Secret/Key 一律加密落库；主密钥缺失则拒绝。 */
feishu.post("/settings", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可配置" }, 403);
  if (!c.env.AI_KEY_SECRET) return c.json({ error: "未配置主密钥（AI_KEY_SECRET），无法安全保存，飞书集成不可用" }, 400);

  const body = await c.req.json<{
    name?: string; app_id?: string; app_secret?: string; encrypt_key?: string; verification_token?: string;
  }>();
  const appId = (body.app_id || "").trim();
  const appSecret = (body.app_secret || "").trim();
  const encKey = (body.encrypt_key || "").trim();
  const verTok = (body.verification_token || "").trim();

  const existing = await c.env.DB
    .prepare("SELECT id, app_secret_enc, encrypt_key_enc, verification_token_enc FROM feishu_apps WHERE team_id IS NULL")
    .first<{ id: string; app_secret_enc: string; encrypt_key_enc: string | null; verification_token_enc: string | null }>();

  // App ID 必填；App Secret 仅首次配置必填，之后留空 = 保留原值（支持只改名称/Key 的局部保存）
  if (!appId) return c.json({ error: "App ID 必填" }, 400);
  if (!appSecret && !existing) return c.json({ error: "App ID 与 App Secret 必填" }, 400);

  const secretEnc = appSecret ? await encryptAiKey(appSecret, c.env.AI_KEY_SECRET!) : existing!.app_secret_enc;
  // Encrypt Key / Verification Token 留空 = 保留原值
  const encKeyEnc = encKey ? await encryptAiKey(encKey, c.env.AI_KEY_SECRET!) : existing?.encrypt_key_enc ?? null;
  const verTokEnc = verTok ? await encryptAiKey(verTok, c.env.AI_KEY_SECRET!) : existing?.verification_token_enc ?? null;

  if (existing) {
    await c.env.DB.prepare(
      "UPDATE feishu_apps SET name = ?, app_id = ?, app_secret_enc = ?, encrypt_key_enc = ?, verification_token_enc = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(body.name?.trim() || null, appId, secretEnc, encKeyEnc, verTokEnc, existing.id).run();
  } else {
    await c.env.DB.prepare(
      "INSERT INTO feishu_apps (id, team_id, name, app_id, app_secret_enc, encrypt_key_enc, verification_token_enc) VALUES (?, NULL, ?, ?, ?, ?, ?)"
    ).bind(genId(), body.name?.trim() || null, appId, secretEnc, encKeyEnc, verTokEnc).run();
  }
  return c.json({ ok: true });
});

/** 生成飞书 OAuth 授权 URL（登录用户）。state 绑 userId 存 KV。 */
feishu.get("/oauth/start", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const cfg = await resolveFeishuApp(c.env.DB, session.teamId, c.env.AI_KEY_SECRET);
  if (!cfg) return c.json({ error: "尚未配置飞书应用" }, 400);
  const state = crypto.randomUUID();
  await c.env.SESSIONS.put(`feishu:oauth:${state}`, JSON.stringify({ userId: session.userId }), { expirationTtl: OAUTH_STATE_TTL });
  const origin = new URL(c.req.url).origin;
  const url = buildAuthorizeUrl(cfg, state, `${origin}/api/feishu/oauth/callback`);
  return c.json({ url });
});

/**
 * OAuth 回调破框：扫码登录在飞书官方 iframe 内完成授权，若用普通 302，
 * 回调页只会渲染在那个小 iframe 里。返回一段脚本把顶层窗口带到目标地址
 * （iframe 内外都正确：顶层场景 top === self，catch 分支等价于 302）。
 */
function breakoutRedirect(url: string): string {
  const target = JSON.stringify(url);
  return `<!doctype html><html><head><meta charset="utf-8"><title>正在返回系统…</title></head><body style="margin:0;font-family:sans-serif;color:#64748b;display:flex;align-items:center;justify-content:center;height:100vh">正在返回系统，请稍候…<script>try{top.location.replace(${target})}catch(e){location.replace(${target})}<\/script></body></html>`;
}

/** 飞书授权回跳：校验 state → 换 open_id → 绑定当前用户 → 回前端。 */
feishu.get("/oauth/callback", async (c) => {
  const origin = new URL(c.req.url).origin;
  const code = c.req.query("code");
  const state = c.req.query("state");
  // 用户拒绝授权时飞书回跳 error=access_denied（无 code），与参数缺失区分开
  const denied = c.req.query("error");
  if (denied) return c.html(breakoutRedirect(`${origin}/?feishu=error&reason=${encodeURIComponent(denied)}`));
  if (!code || !state) return c.html(breakoutRedirect(`${origin}/?feishu=error&reason=missing_params`));
  const raw = await sessionGet(c.env, `feishu:oauth:${state}`);
  await c.env.SESSIONS.delete(`feishu:oauth:${state}`);
  if (!raw) return c.html(breakoutRedirect(`${origin}/?feishu=error&reason=bad_state`));
  let userId: string;
  try { ({ userId } = JSON.parse(raw) as { userId: string }); } catch { return c.html(breakoutRedirect(`${origin}/?feishu=error&reason=bad_state`)); }

  // 用全局应用（或该用户所属 team 的应用）换 open_id
  const teamRow = await c.env.DB.prepare("SELECT team_id FROM users WHERE id = ?").bind(userId).first<{ team_id: string | null }>();
  const cfg = await resolveFeishuApp(c.env.DB, teamRow?.team_id ?? null, c.env.AI_KEY_SECRET);
  if (!cfg) return c.html(breakoutRedirect(`${origin}/?feishu=error&reason=no_app`));

  const redirected = `${origin}/api/feishu/oauth/callback`;
  const { user, error } = await exchangeCodeForUser(cfg, code, redirected);
  if (!user) return c.html(breakoutRedirect(`${origin}/?feishu=error&reason=${encodeURIComponent(error || "exchange")}`));
  await c.env.DB.prepare("UPDATE users SET feishu_open_id = ?, notify_channel = 'feishu' WHERE id = ?")
    .bind(user.openId, userId).run();
  return c.html(breakoutRedirect(`${origin}/?feishu=bound`));
});

/** 事件订阅回调（公开）。P1 支持 URL 校验 + 事件 ACK；卡片交互/加密回包为 P2。 */
feishu.post("/event", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();

  // 若启用了 Encrypt Key（body.encrypt），尽力解密后按明文处理
  let payload = body as { type?: string; challenge?: string; token?: string; header?: unknown; event?: unknown; encrypt?: string };
  if (payload.encrypt && typeof payload.encrypt === "string") {
    const row = await c.env.DB.prepare("SELECT id FROM feishu_apps WHERE team_id IS NULL AND enabled = 1").first<{ id: string }>();
    const cfg = await resolveFeishuApp(c.env.DB, null, c.env.AI_KEY_SECRET);
    if (row && cfg?.encryptKey) {
      const plain = await decryptFeishuEvent(cfg.encryptKey, payload.encrypt);
      if (plain) {
        try { payload = JSON.parse(plain) as typeof payload; } catch { /* 保持原 body */ }
      }
    }
  }

  // URL 校验：飞书后台配置回调时的握手
  if (payload.type === "url_verification") {
    // 若配置了 Verification Token 则校验（P1 建议回调仅用 Verification Token，不开 Encrypt Key）
    if (payload.challenge) return c.json({ challenge: payload.challenge });
  }

  // 其余（事件推送、消息回执、卡片回调 v1/v2）先 ACK；具体处理 P2
  console.log("[feishu] event received:", JSON.stringify(payload).slice(0, 500));
  return c.json({ code: 0, msg: "ok" });
});

/** 给当前登录用户发一条测试飞书消息，验证绑定与配置是否生效。 */
feishu.post("/test", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const row = await c.env.DB.prepare("SELECT feishu_open_id, notify_channel FROM users WHERE id = ?")
    .bind(session.userId).first<{ feishu_open_id: string | null; notify_channel: string | null }>();
  if (!row?.feishu_open_id) return c.json({ ok: false, message: "请先绑定飞书（设置 → 绑定飞书）" }, 400);
  const cfg = await resolveFeishuApp(c.env.DB, session.teamId, c.env.AI_KEY_SECRET);
  if (!cfg) return c.json({ ok: false, message: "尚未配置飞书应用" }, 400);
  const res = await sendFeishuText(c.env.SESSIONS, cfg, row.feishu_open_id, "【HR 工作台】飞书通道测试：你已成功绑定，后续到期待办/面试提醒将推送到这里。");
  return c.json(res);
});

export const feishuRoutes = feishu;
