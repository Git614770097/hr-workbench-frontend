# 飞书集成 · 可行性分析 & 改动清单（路线 B · BYOK）

> 目标：让 HR 工作台把待办/面试/审批等提醒通过飞书送达，并让面试官等角色能真正被触达。
> 路线决策：**B · BYOK**——每个企业客户在其自有飞书里建自建应用，把凭证授权给我们（加密存库）；其组织内成员 OAuth 授权后绑定 `feishu_open_id` 接收通知。开发者个人无企业主体认证，因此放弃"公开商店/人人自助授权"，改走 BYOK。
> 结论：**可行，且本系统已预留多处落地位**。本文给出数据模型、接口契约、文件改动、分期与验收。

---

## 0. 好底子：已存在、可直接激活的资产

| 资产 | 位置 | 用于飞书 |
|---|---|---|
| `users.notify_channel`（pushplus/feishu/wecom）、`feishu_open_id`、`wecom_userid` | `schema.sql:31-33` | 推送渠道选择 + 绑定飞书身份（零实现，本次激活） |
| `users.ai_key` + `ai_key_masked`（BYOK 加密范式，AES-GCM + 主密钥 secret） | `schema.sql:34-35` | 飞书 AppSecret/EncryptKey 加密存库照抄此范式 |
| `approval_instances.ext_provider`（预留外部审批渠道）+ `ext_msg_id`（外部审批消息 ID 回调用） | `schema.sql:308-309` | 二期：Offer 审批推送到飞书后回调 |
| `users.team_id`（同 team 共享数据；管理员=自己 id，子用户=管理员 id） | `schema.sql:30` | **BYOK 归属单位**：each 企业客户 = 一个 team，各配一个飞书应用 |
| KV 绑定 `SESSIONS` / `RESUMES` | `wrangler.jsonc` | 缓存 `tenant_access_token`；OAuth `state` 防 CSRF |
| Cron 每天 09:00（北京时间） | `wrangler.jsonc` `crons: ["0 1 * * *"]` | 每天跑联系同步 + 到期提醒 |
| Worker 路由可入站 + 出站 fetch（Hono，自定义域名） | `wrangler.jsonc` | 收飞书回调 + 调飞书开放 API |

---

## 1. 分层能力（与"个人/企业都能授权"对齐）

| 层 | 能力 | 授权方 | 依赖 |
|---|---|---|---|
| **A · 用户级**（本着一期做） | OAuth 授权 → 绑 `feishu_open_id`；用 `im/v1/messages` 给本人发待办/面试/审批通知 | 飞书用户本人（个人/企业员工均可） | 客户已建自建应用 + 开启消息 scope |
| **B · 组织级**（二期，按需） | 通讯录同步（`contact/v3/users`）、组织广播、飞书审批（`approval_instances.ext_provider`）、日历/会议室 | 客户企业的飞书管理员（安装应用 + 授予组织 scope） | 管理员配合授权 |

> 用户级与组织级代码同源，差在**凭证范围与授权主体**。个人飞书用户只能进 A 层；组织级 B 层只有企业客户的授权管理员能开。

---

## 2. 数据模型改动

**新表 `feishu_apps`（每个 team 一条，BYOK 凭证集中管理）**（迁移脚本 `migrations/migration-20261020-feishu-apps.sql`）
```sql
CREATE TABLE IF NOT EXISTS feishu_apps (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,              -- 归属：该企业客户的 team_id（管理员自己的 id）
  name TEXT,                           -- 展示名
  app_id TEXT NOT NULL,                -- 飞书 App ID（明文，查询/标识用）
  app_secret_enc TEXT NOT NULL,        -- App Secret（AES-GCM 密文）
  encrypt_key_enc TEXT,               -- 事件加解密 Encrypt Key（密文，可选）
  verification_token_enc TEXT,         -- Verification Token（密文，可选）
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(team_id)
);
CREATE INDEX IF NOT EXISTS idx_feishu_apps_team ON feishu_apps(team_id);
```
- 加密方式：**复用 `users.ai_key` 现有 AES-GCM 实现**（主密钥走 secret；实现时定位并复用同一 helper，不重写）。
- 不新增 KV：token 复用 `SESSIONS`（key=`feishu_token:<app_id>`，TTL≈110 分钟，因 tenant_access_token 有效期 7200s）。
- `users` 表无需改动：`feishu_open_id` / `notify_channel` 已在。

---

## 3. 新增 Feishu 客户端 `src/worker/feishu.ts`（纯函数 + fetch，便于 tsc 校验）

- `getTenantAccessToken(env, appId, appSecret)`：调 `auth/v3/tenant_access_token/internal`，先读 KV 缓存，命中即返回；否则请求并写 KV（TTL 110 分钟）。规避飞书申请 token 频率限制。
- `sendFeishuText(env, cfg, openId, text)`：`POST im/v1/messages?receive_id_type=open_id`，body `{receive_id, msg_type:"text", content: JSON.stringify({text})}`，头 `Authorization: Bearer <token>`。返回 `{ok, message}`（对齐 `sendPushPlus` 返回结构）。
- OAuth：`buildAuthorizeUrl(cfg, state, redirectUri)`、`exchangeCodeForUser(env, cfg, code)`（code→user_access_token→取 open_id）。
- `decryptFeishuEvent(encryptKey, encrypted)`：**WebCrypto `crypto.subtle`**（AES-CBC，PKCS7；Workers 无 Node `crypto`）。用于事件回调解密。
- 复用现有 `escapeHtml` 做文本转义；所有出/入站字段按现有 `cleanText`/长度上限处理。
> 具体 API 路径/参数以飞书开放平台当前文档为准（路径与授权流程可能随版本调整，实现时核对）。

---

## 4. 新增 API 路由 `src/worker/routes/feishu.ts`

| 路由 | 方法 | 用途 | 权限 |
|---|---|---|---|
| `/api/feishu/settings` | GET | 读本 team 的飞书配置（AppSecret 等脱敏返回） | 管理员 |
| `/api/feishu/settings` | POST | 保存/更新飞书应用凭证（加密落库） | 管理员 |
| `/api/feishu/oauth/start` | GET | 生成授权 URL（带随机 `state` 存 KV，防 CSRF） | 登录用户 |
| `/api/feishu/oauth/callback` | GET | 飞书回跳：校验 `state` → 换 token → 拿 open_id → 写 `users.feishu_open_id` + `notify_channel='feishu'` | 公开（带 state） |
| `/api/feishu/event` | POST | 事件订阅：URL 校验（challenge）+ 解密 + 卡片回调（二期审批用） | 公开（验签） |
| `/api/feishu/test` | POST | 给当前登录用户发一条测试飞书消息 | 登录用户 |

- 回调域名：`https://hr-work.club/api/feishu/oauth/callback` 与 `/api/feishu/event`，在客户飞书后台配置。
- **多客户共用同一 Worker**：event 回调需按 `app_id`（或请求体特征）反查对应 `feishu_apps` 行，路由到正确的解密与处理逻辑。

---

## 5. 通知接线（改 `src/worker/reminders.ts`）

- 新增 `sendFeishuTo(env, cfg, openId, title, html)`，与 `sendPushPlus` 并列。
- `notifyAdmins` / `runReminders` 增加分支：优先读该 team 的 `feishu_apps`（enabled 且有 `feishu_open_id` 的用户走飞书，其余保持 PushPlus）。
- **兜底不变**：未配飞书/未绑定的用户仍走 PushPlus；两者都无则记 skipped（沿用现有 `skippedNoToken` 语义）。
- 事件通知（注册/审批/密码重置/会员开通）在 `notify*` 系列里同样加飞书分支。

---

## 6. 前端改动

- 「系统设置」页新增「飞书集成」区（管理员）：填 App ID / App Secret / Encrypt Key / Verification Token → 保存（密文）→ 「发送测试」。
- 个人「设置/资料」页新增「绑定飞书」：点击跳 OAuth，完成后回显已绑定；通知渠道下拉增加「飞书」。
- Landing 文案：**删除/修正「与企业微信打通」的空话**；如已上线飞书能力再据实描述（飞书≠企业微信，别混写）。

---

## 7. 分期与验收

| 期 | 范围 | 验收 |
|---|---|---|
| **P1（先做）** | 新表 + `feishu.ts` + settings 路由 + OAuth 绑定 + `im` 测试消息 + reminders 飞书分支（用户级 A） | 管理员存凭证→用户 OAuth 绑 open_id→发测试消息成功→待办到期按渠道触达 |
| **P2（按需）** | 通讯录同步（cron）+ 交互卡片 + 飞书审批（`ext_provider`/`ext_msg_id`） | 面试官按通讯录匹配 open_id；审批卡片点按后回写 `approval_instances` |

---

## 8. 需要客户（企业方）提供/配合（BYOK 前置）

1. 在其飞书后台建**企业自建应用**，提供：`App ID` / `App Secret` / `Encrypt Key` / `Verification Token`。
2. 为应用开启所需权限：A 层至少 `im:message`（发消息）；B 层再加 `contact:user.base:readonly` 等。
3. 配置事件订阅与回调 URL（`/api/feishu/event`）、OAuth 重定向 URL（`/api/feishu/oauth/callback`）。
4. 组织级能力需其**飞书管理员授权**安装应用。

---

## 9. 风险与坑

- **飞书 token 频率限制**：必须 KV 缓存 `tenant_access_token`（110 分钟），不要每消息都申请。
- **事件解密**：用 WebCrypto（Workers 无 Node crypto）；AES-CBC + PKCS7 填充需处理正确。
- **回调要快回**：`/api/feishu/event` 先 ACK，重活放 `ctx.waitUntil`，避免飞书超时重推。
- **多客户回调隔离**：单 Worker 承载多 team，event 需按 app_id 反查配置，勿用全局单一密钥解密。
- **飞书 ≠ 企业微信**：落地前先修 landing 上头口不一的宣传。
- **个人散客不覆盖**：纯粹无组织的个人飞书无法授权第三方应用，属预期限制；保留 PushPlus 兜底。
