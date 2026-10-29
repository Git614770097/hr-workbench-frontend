import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { sessionGet } from "../kv";
import { genId } from "../helpers";
import { encryptAiKey, decryptAiKey } from "../aiKey";
import {
  resolveFeishuApp,
  resolveFeishuAppByAppId,
  buildAuthorizeUrl,
  exchangeCodeForUser,
  sendFeishuText,
  decryptFeishuEvent,
  isFeishuWebhookUrl,
  sendFeishuWebhook,
  createFeishuReserve,
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
    "SELECT id, team_id, user_id, name, app_id, encrypt_key_enc, verification_token_enc, enabled FROM feishu_apps WHERE team_id IS NULL AND user_id IS NULL"
  ).first<{ id: string; team_id: string | null; user_id: string | null; name: string | null; app_id: string; encrypt_key_enc: string | null; verification_token_enc: string | null; enabled: number }>();
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
    .prepare("SELECT id, app_secret_enc, encrypt_key_enc, verification_token_enc FROM feishu_apps WHERE team_id IS NULL AND user_id IS NULL")
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
      "INSERT INTO feishu_apps (id, team_id, user_id, name, app_id, app_secret_enc, encrypt_key_enc, verification_token_enc) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?)"
    ).bind(genId(), body.name?.trim() || null, appId, secretEnc, encKeyEnc, verTokEnc).run();
  }
  return c.json({ ok: true });
});

// ---- 我的飞书应用（任何登录用户自助）：跨企业用户配自己企业的应用 ----
// scope key = team_id ?? user_id：manager 保存落到团队行（全团队共用），其余落到个人行。
// 解析顺序 团队 → 个人 → 全局，见 resolveFeishuApp。

/** 我的飞书应用配置回显（任何登录用户）。敏感字段只回「是否已配」。
 *  scope：仅 manager 管团队行（team_id=自己的 id）；普通成员一律个人行——
 *  不能拿「有无 teamId」当判定（成员的 teamId=管理员 id，会误写团队行把全队配置劫持掉）。 */
feishu.get("/my-app", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const scopeTeam = session.role === "manager" && !!session.teamId;
  const row = scopeTeam
    ? await c.env.DB.prepare(
        "SELECT id, name, app_id, encrypt_key_enc, verification_token_enc, enabled FROM feishu_apps WHERE team_id = ? AND user_id IS NULL"
      ).bind(session.teamId).first<{ id: string; name: string | null; app_id: string; encrypt_key_enc: string | null; verification_token_enc: string | null; enabled: number }>()
    : await c.env.DB.prepare(
        "SELECT id, name, app_id, encrypt_key_enc, verification_token_enc, enabled FROM feishu_apps WHERE user_id = ?"
      ).bind(session.userId).first<{ id: string; name: string | null; app_id: string; encrypt_key_enc: string | null; verification_token_enc: string | null; enabled: number }>();
  return c.json({
    scope: scopeTeam ? "team" : "user",
    configured: !!row,
    name: row?.name ?? null,
    app_id: row?.app_id ?? null,
    has_encrypt_key: !!row?.encrypt_key_enc,
    has_verification_token: !!row?.verification_token_enc,
    enabled: row ? !!row.enabled : false,
  });
});

/**
 * 保存我的飞书应用凭证（任何登录用户）。Secret/Key 一律加密落库；主密钥缺失则拒绝。
 * manager（有 team_id）落到团队行=全团队共用；其余落到个人行=只影响自己。
 * App Secret 留空 = 保留原值（支持只改名称的局部保存）。
 */
feishu.post("/my-app", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (!c.env.AI_KEY_SECRET) return c.json({ error: "未配置主密钥（AI_KEY_SECRET），无法安全保存" }, 400);

  const body = await c.req.json<{
    name?: string; app_id?: string; app_secret?: string; encrypt_key?: string; verification_token?: string;
  }>();
  const appId = (body.app_id || "").trim();
  const appSecret = (body.app_secret || "").trim();
  const encKey = (body.encrypt_key || "").trim();
  const verTok = (body.verification_token || "").trim();
  if (!appId) return c.json({ error: "App ID 必填" }, 400);

  // 仅 manager 的保存落团队行；普通成员一律落个人行（见 GET 注释）
  const scopeTeam = session.role === "manager" && !!session.teamId;
  const existing = scopeTeam
    ? await c.env.DB.prepare(
        "SELECT id, app_id, app_secret_enc, encrypt_key_enc, verification_token_enc FROM feishu_apps WHERE team_id = ? AND user_id IS NULL"
      ).bind(session.teamId).first<{ id: string; app_id: string; app_secret_enc: string; encrypt_key_enc: string | null; verification_token_enc: string | null }>()
    : await c.env.DB.prepare(
        "SELECT id, app_id, app_secret_enc, encrypt_key_enc, verification_token_enc FROM feishu_apps WHERE user_id = ?"
      ).bind(session.userId).first<{ id: string; app_id: string; app_secret_enc: string; encrypt_key_enc: string | null; verification_token_enc: string | null }>();
  if (!appSecret && !existing) return c.json({ error: "App ID 与 App Secret 必填" }, 400);

  const secretEnc = appSecret ? await encryptAiKey(appSecret, c.env.AI_KEY_SECRET) : existing!.app_secret_enc;
  const encKeyEnc = encKey ? await encryptAiKey(encKey, c.env.AI_KEY_SECRET) : existing?.encrypt_key_enc ?? null;
  const verTokEnc = verTok ? await encryptAiKey(verTok, c.env.AI_KEY_SECRET) : existing?.verification_token_enc ?? null;

  if (existing) {
    const stmts: D1PreparedStatement[] = [
      c.env.DB.prepare(
        "UPDATE feishu_apps SET name = ?, app_id = ?, app_secret_enc = ?, encrypt_key_enc = ?, verification_token_enc = ?, enabled = 1, updated_at = datetime('now') WHERE id = ?"
      ).bind(body.name?.trim() || null, appId, secretEnc, encKeyEnc, verTokEnc, existing.id),
    ];
    // 换了 App ID：老应用下的 open_id 全部失效（open_id 是应用级标识），连带解绑，
    // 否则用户拿着旧 open_id 永远发不出消息还查不出原因。
    if (existing.app_id !== appId) {
      stmts.push(
        c.env.DB.prepare("UPDATE users SET feishu_open_id = NULL, feishu_app_id = NULL, notify_channel = 'pushplus' WHERE feishu_app_id = ?").bind(existing.app_id)
      );
    }
    await c.env.DB.batch(stmts);
  } else if (scopeTeam) {
    await c.env.DB.prepare(
      "INSERT INTO feishu_apps (id, team_id, user_id, name, app_id, app_secret_enc, encrypt_key_enc, verification_token_enc) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)"
    ).bind(genId(), session.teamId, body.name?.trim() || null, appId, secretEnc, encKeyEnc, verTokEnc).run();
  } else {
    await c.env.DB.prepare(
      "INSERT INTO feishu_apps (id, team_id, user_id, name, app_id, app_secret_enc, encrypt_key_enc, verification_token_enc) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)"
    ).bind(genId(), session.userId, body.name?.trim() || null, appId, secretEnc, encKeyEnc, verTokEnc).run();
  }
  return c.json({ ok: true, scope: scopeTeam ? "team" : "user" });
});

/**
 * 删除我的飞书应用配置（任何登录用户）。删掉后回落上一级（个人删→回落团队/全局；团队删→回落全局）。
 * 只允许删自己 scope 的行——个人行 user_id=自己；团队行仅 manager（team_id=自己 team）。
 * 连带清掉指向该应用的绑定（users.feishu_app_id）：应用没了 open_id 无从投递，
 * 不清的话绑定用户之后每条发信都静默失败到「配置不完整」，要等用户自己发现。
 */
feishu.delete("/my-app", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const scopeTeam = session.role === "manager" && !!session.teamId;
  const row = scopeTeam
    ? await c.env.DB.prepare("SELECT id, app_id FROM feishu_apps WHERE team_id = ? AND user_id IS NULL").bind(session.teamId).first<{ id: string; app_id: string }>()
    : await c.env.DB.prepare("SELECT id, app_id FROM feishu_apps WHERE user_id = ?").bind(session.userId).first<{ id: string; app_id: string }>();
  if (!row) return c.json({ ok: true, deleted: 0 });
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM feishu_apps WHERE id = ?").bind(row.id),
    // 解绑用过该应用的用户（open_id 是应用级的，应用一废绑定即失效；置空后回落 pushplus）
    c.env.DB.prepare("UPDATE users SET feishu_open_id = NULL, feishu_app_id = NULL, notify_channel = 'pushplus' WHERE feishu_app_id = ?").bind(row.app_id),
  ]);
  return c.json({ ok: true, deleted: 1 });
});

/**
 * 飞书集成是否已配置（任何登录用户可查）。
 * 用途：前端常驻入口按此分流——已配置直接进授权，管理员未配置跳设置页，成员未配置提示找管理员。
 * 只回布尔，不泄露 App ID / 掩码等敏感信息。
 */
feishu.get("/status", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const cfg = await resolveFeishuApp(c.env.DB, session.teamId, session.userId, c.env.AI_KEY_SECRET);
  return c.json({ configured: !!cfg });
});

/**
 * 一键创建飞书会议（预约会议）——面试表单「生成飞书会议」用。
 * 只负责建会并返回链接，不落库：前端把链接回填到表单，用户保存面试时正常写入。
 * 前置条件（失败时把原因说清楚，别让用户对着飞书错误码猜）：
 * 1. 管理员已配置飞书应用（feishu_apps）；
 * 2. 当前用户已完成飞书 OAuth 绑定——tenant token 下 owner_id（会议归属人）必传；
 * 3. 应用已添加「视频会议」权限（vc:reserve）并发布版本。
 */
feishu.post("/meeting", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const body = await c.req.json<{ topic?: string; minutes?: number }>().catch(() => ({}) as { topic?: string; minutes?: number });

  const user = await c.env.DB.prepare("SELECT feishu_open_id, feishu_app_id FROM users WHERE id = ?")
    .bind(session.userId).first<{ feishu_open_id: string | null; feishu_app_id: string | null }>();
  const ownerOpenId = (user?.feishu_open_id || "").trim();
  if (!ownerOpenId) {
    return c.json({ error: "你还没有绑定飞书（会议需要登记归属人）。请点页面右上角飞书图标完成绑定" }, 400);
  }
  // open_id 是应用级标识：必须用绑定时的同一应用建会，否则归属人对不上。
  // 闸门不能先看三级解析——成员经团队应用绑定后被移出团队时三级可能解析不到，
  // 但绑定应用仍在（直取可用），先卡三级会误报「尚未配置」。
  const meetCfg = user?.feishu_app_id
    ? await resolveFeishuAppByAppId(c.env.DB, user.feishu_app_id, c.env.AI_KEY_SECRET)
    : await resolveFeishuApp(c.env.DB, session.teamId, session.userId, c.env.AI_KEY_SECRET);
  if (!meetCfg) return c.json({ error: "绑定时使用的飞书应用已停用或删除，请重新扫码绑定飞书（或在消息推送设置里配置飞书应用）" }, 400);

  // 会议时长=面试时长（15 分钟~8 小时，越界夹紧）；end_time 为 unix 秒
  const minutes = Math.min(480, Math.max(15, Number(body.minutes) || 60));
  const endTimeSec = Math.floor(Date.now() / 1000) + minutes * 60;
  const r = await createFeishuReserve(c.env.SESSIONS, meetCfg, {
    ownerOpenId,
    topic: (body.topic || "").trim() || "面试",
    endTimeSec,
  });
  if (!r.ok) return c.json({ error: r.message }, 502);
  return c.json({ ok: true, url: r.url, meeting_no: r.meetingNo, password: r.password });
});

/** 生成飞书 OAuth 授权 URL（登录用户）。state 绑 userId 存 KV。 */
feishu.get("/oauth/start", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const cfg = await resolveFeishuApp(c.env.DB, session.teamId, session.userId, c.env.AI_KEY_SECRET);
  if (!cfg) return c.json({ error: "尚未配置飞书应用" }, 400);
  const state = crypto.randomUUID();
  // 记下发起时的 appId：open_id 是应用级标识，回调换 open_id 与后续发信必须用同一应用
  await c.env.SESSIONS.put(`feishu:oauth:${state}`, JSON.stringify({ userId: session.userId, appId: cfg.appId }), { expirationTtl: OAUTH_STATE_TTL });
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
  let startAppId: string | null = null;
  try {
    const st = JSON.parse(raw) as { userId: string; appId?: string };
    userId = st.userId;
    startAppId = st.appId ?? null;
  } catch { return c.html(breakoutRedirect(`${origin}/?feishu=error&reason=bad_state`)); }

  // 换 open_id 必须用发起授权时的同一应用（open_id 是应用级标识）；老 state 无 appId 则按三级解析兜底
  const teamRow = await c.env.DB.prepare("SELECT team_id FROM users WHERE id = ?").bind(userId).first<{ team_id: string | null }>();
  const cfg = startAppId
    ? await resolveFeishuAppByAppId(c.env.DB, startAppId, c.env.AI_KEY_SECRET)
    : await resolveFeishuApp(c.env.DB, teamRow?.team_id ?? null, userId, c.env.AI_KEY_SECRET);
  if (!cfg) return c.html(breakoutRedirect(`${origin}/?feishu=error&reason=no_app`));

  const redirected = `${origin}/api/feishu/oauth/callback`;
  const { user, error } = await exchangeCodeForUser(cfg, code, redirected);
  if (!user) return c.html(breakoutRedirect(`${origin}/?feishu=error&reason=${encodeURIComponent(error || "exchange")}`));
  // 不直接写库——授权页会默认带出浏览器里已登录的飞书账号（成员可能在他人电脑上
  // 操作、或旧登录态没清），静默绑定会把提醒推到一个错误的飞书上。生成一次性
  // 确认 token 存 KV，由前端「绑定确认页」展示飞书昵称/头像、用户点确认后才写库。
  const ck = crypto.randomUUID();
  await c.env.SESSIONS.put(`feishu:bind:${ck}`, JSON.stringify({
    userId, openId: user.openId, name: user.name || "", avatarUrl: user.avatarUrl || "", appId: cfg.appId,
  }), { expirationTtl: 600 });
  return c.html(breakoutRedirect(`${origin}/?feishu=confirm&ck=${ck}`));
});

/**
 * 绑定确认页的数据（登录用户）：只读待确认的飞书昵称/头像，不消费 token。
 */
feishu.get("/bind/pending", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const ck = c.req.query("ck") || "";
  const raw = await sessionGet(c.env, `feishu:bind:${ck}`);
  if (!raw) return c.json({ error: "确认已过期，请重新扫码" }, 400);
  let pending: { userId: string; openId: string; name: string; avatarUrl: string; appId?: string };
  try { pending = JSON.parse(raw) as typeof pending; } catch { return c.json({ error: "确认数据损坏" }, 400); }
  if (pending.userId !== session.userId) return c.json({ error: "确认链接与当前账号不匹配" }, 403);
  return c.json({ name: pending.name, avatar_url: pending.avatarUrl });
});

/**
 * 绑定确认（登录用户）：展示过飞书昵称/头像、用户点「确认绑定」后才真正写库。
 * token 在**绑定成功后**才消费（写库成即删）；失败（409 被占用 / 参数损坏除外）不删，
 * 用户可原地重试而不必重新扫码。ttl 10 分钟兜底回收。open_id 唯一性校验同回调。
 */
feishu.post("/bind/confirm", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const body = await c.req.json<{ ck?: string }>().catch(() => ({} as { ck?: string }));
  if (!body.ck) return c.json({ error: "参数缺失" }, 400);
  const raw = await sessionGet(c.env, `feishu:bind:${body.ck}`);
  if (!raw) return c.json({ error: "确认已过期，请重新扫码" }, 400);
  let pending: { userId: string; openId: string; name: string; avatarUrl: string; appId?: string };
  try { pending = JSON.parse(raw) as typeof pending; } catch {
    // 内容已损坏，重试无意义——这种才就地消费掉
    await c.env.SESSIONS.delete(`feishu:bind:${body.ck}`);
    return c.json({ error: "确认数据损坏" }, 400);
  }
  // 只允许确认自己的绑定（防拿别人的确认链接恶意绑定）
  if (pending.userId !== session.userId) return c.json({ error: "确认链接与当前账号不匹配" }, 403);
  // open_id 全局唯一：同一飞书不允许绑到多个系统账号
  const clash = await c.env.DB.prepare("SELECT id FROM users WHERE feishu_open_id = ? AND id != ?")
    .bind(pending.openId, session.userId).first<{ id: string }>();
  if (clash) return c.json({ error: "这个飞书已经绑定到其他账号了（一个飞书只能绑一个系统账号）" }, 409);
  // feishu_app_id：记下 open_id 是哪个应用发的——发信必须同应用，否则投递不到
  await c.env.DB.prepare("UPDATE users SET feishu_open_id = ?, feishu_app_id = ?, notify_channel = 'feishu' WHERE id = ?")
    .bind(pending.openId, pending.appId ?? null, session.userId).run();
  // 成功才消费 token：失败路径保留 token 供重试（userId 已绑定，无被冒用风险）
  await c.env.SESSIONS.delete(`feishu:bind:${body.ck}`);
  return c.json({ ok: true, name: pending.name });
});

/** 事件订阅回调（公开）。P1 支持 URL 校验 + 事件 ACK；卡片交互/加密回包为 P2。 */
feishu.post("/event", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();

  // 若启用了 Encrypt Key（body.encrypt），尽力解密后按明文处理
  let payload = body as { type?: string; challenge?: string; token?: string; header?: unknown; event?: unknown; encrypt?: string };
  if (payload.encrypt && typeof payload.encrypt === "string") {
    const cfg = await resolveFeishuApp(c.env.DB, null, null, c.env.AI_KEY_SECRET);
    if (cfg?.encryptKey) {
      const plain = await decryptFeishuEvent(cfg.encryptKey, payload.encrypt);
      if (plain) {
        try { payload = JSON.parse(plain) as typeof payload; } catch { /* 保持原 body */ }
      }
    }
  }

  // URL 校验：飞书后台配置回调时的握手。
  // Verification Token 校验：配置了就必须比对，否则任何人都能伪造事件刷日志。
  if (payload.type === "url_verification") {
    if (payload.challenge) return c.json({ challenge: payload.challenge });
  }
  // 事件推送同样校验 token（url_verification 除外——它本身就是握手，token 未配时放行）
  const vCfg = await resolveFeishuApp(c.env.DB, null, null, c.env.AI_KEY_SECRET);
  if (vCfg?.verificationToken && payload.token && payload.token !== vCfg.verificationToken) {
    return c.json({ code: 403, msg: "verification token mismatch" }, 403);
  }

  // 其余（事件推送、消息回执、卡片回调 v1/v2）先 ACK；具体处理 P2
  console.log("[feishu] event received:", JSON.stringify(payload).slice(0, 500));
  return c.json({ code: 0, msg: "ok" });
});

/** 给当前登录用户发一条测试飞书消息，验证绑定与配置是否生效。 */
feishu.post("/test", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const row = await c.env.DB.prepare("SELECT feishu_open_id, feishu_app_id FROM users WHERE id = ?")
    .bind(session.userId).first<{ feishu_open_id: string | null; feishu_app_id: string | null }>();
  if (!row?.feishu_open_id) return c.json({ ok: false, message: "请先绑定飞书（点右上角飞书图标完成绑定）" }, 400);
  // open_id 是应用级标识：必须用绑定时的同一应用发信
  const cfg = row.feishu_app_id
    ? await resolveFeishuAppByAppId(c.env.DB, row.feishu_app_id, c.env.AI_KEY_SECRET)
    : await resolveFeishuApp(c.env.DB, session.teamId, session.userId, c.env.AI_KEY_SECRET);
  if (!cfg) return c.json({ ok: false, message: "绑定时使用的飞书应用已停用或删除，请重新扫码绑定飞书" }, 400);
  const res = await sendFeishuText(c.env.SESSIONS, cfg, row.feishu_open_id, "【HR 工作台】飞书通道测试：你已成功绑定，后续到期待办/面试提醒将推送到这里。");
  return c.json(res);
});

/** 解绑当前用户的飞书（登录用户自助）。解绑后推送渠道回退 pushplus 默认值。 */
feishu.delete("/bind", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  await c.env.DB.prepare("UPDATE users SET feishu_open_id = NULL, feishu_app_id = NULL, notify_channel = 'pushplus' WHERE id = ?")
    .bind(session.userId).run();
  return c.json({ ok: true });
});

// ---- 群自定义机器人（webhook）：零应用依赖的群推送 ----

/** 群机器人列表（admin）。webhook URL 含 token 不回显，只回元信息。 */
feishu.get("/webhooks", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可配置" }, 403);
  // 只列全局行（team_id IS NULL）：写入/删除/测试都只认全局行，
  // 列表若放出团队行会出现「看得到删不掉」的假象（DELETE 带 team_id IS NULL 恒 0 行）
  const { results } = await c.env.DB.prepare(
    "SELECT id, team_id, name, enabled, created_at FROM feishu_webhooks WHERE team_id IS NULL ORDER BY created_at DESC"
  ).all<{ id: string; team_id: string | null; name: string; enabled: number; created_at: string }>();
  return c.json({ webhooks: results || [] });
});

/** 保存/新增群机器人 webhook（admin）。URL 加密落库；主密钥缺失则拒绝。 */
feishu.post("/webhooks", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可配置" }, 403);
  if (!c.env.AI_KEY_SECRET) return c.json({ error: "未配置主密钥（AI_KEY_SECRET），无法安全保存" }, 400);

  const body = await c.req.json<{ name?: string; url?: string }>();
  const name = (body.name || "").trim() || "飞书群机器人";
  const url = (body.url || "").trim();
  if (!isFeishuWebhookUrl(url)) return c.json({ error: "webhook 地址格式不正确：应为 https://open.feishu.cn/open-apis/bot/v2/hook/... 形式（在飞书群设置里复制）" }, 400);

  const existing = await c.env.DB.prepare("SELECT id FROM feishu_webhooks WHERE team_id IS NULL").first<{ id: string }>();
  const urlEnc = await encryptAiKey(url, c.env.AI_KEY_SECRET);
  if (existing) {
    await c.env.DB.prepare("UPDATE feishu_webhooks SET name = ?, url_enc = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(name, urlEnc, existing.id).run();
  } else {
    await c.env.DB.prepare("INSERT INTO feishu_webhooks (id, team_id, name, url_enc) VALUES (?, NULL, ?, ?)")
      .bind(genId(), name, urlEnc).run();
  }
  return c.json({ ok: true });
});

/** 删除群机器人（admin）。 */
feishu.delete("/webhooks/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可配置" }, 403);
  await c.env.DB.prepare("DELETE FROM feishu_webhooks WHERE id = ? AND team_id IS NULL").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

/** 群机器人测试发送（admin）：可用已保存的 id，或临时贴一个 URL 试通再保存。 */
feishu.post("/webhooks/test", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可配置" }, 403);
  const body = await c.req.json<{ id?: string; url?: string }>().catch(() => ({} as { id?: string; url?: string }));
  let url = (body.url || "").trim();
  if (!url && body.id) {
    if (!c.env.AI_KEY_SECRET) return c.json({ ok: false, message: "主密钥未配置，无法解密已保存地址" }, 400);
    const row = await c.env.DB.prepare("SELECT url_enc FROM feishu_webhooks WHERE id = ? AND team_id IS NULL")
      .bind(body.id).first<{ url_enc: string }>();
    if (!row) return c.json({ ok: false, message: "记录不存在" }, 404);
    url = (await decryptAiKey(row.url_enc, c.env.AI_KEY_SECRET).catch(() => null)) ?? "";
    if (!url) return c.json({ ok: false, message: "解密失败，请重新保存地址" }, 500);
  }
  if (!url) return c.json({ ok: false, message: "缺少 webhook 地址" }, 400);
  const res = await sendFeishuWebhook(url, "【HR 工作台】群机器人测试：配置成功，后续到期待办/审批提醒将推送到本群。");
  return c.json(res);
});

/** 读取发送模式：both=群+个人 / group=仅群 / personal=仅个人（默认 personal，不擅自改变现有行为）。 */
feishu.get("/notify-mode", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可配置" }, 403);
  const row = await c.env.DB.prepare("SELECT value FROM site_settings WHERE key = 'feishu_notify_mode'").first<{ value: string | null }>();
  const mode = row?.value;
  return c.json({ mode: mode === "both" || mode === "group" ? mode : "personal" });
});

/** 设置发送模式（admin）。 */
feishu.post("/notify-mode", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可配置" }, 403);
  const body = await c.req.json<{ mode?: string }>().catch(() => ({} as { mode?: string }));
  const mode = body.mode;
  if (mode !== "both" && mode !== "group" && mode !== "personal") return c.json({ error: "mode 仅支持 both/group/personal" }, 400);
  await c.env.DB.prepare(
    "INSERT INTO site_settings (key, value) VALUES ('feishu_notify_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(mode).run();
  return c.json({ ok: true, mode });
});

export const feishuRoutes = feishu;
