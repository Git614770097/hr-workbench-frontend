-- 飞书集成（BYOK）：飞书自建应用凭证集中存库。
-- 归属：team_id IS NULL = 全局默认（运营方自己的飞书应用，单运营部署即用这条）；
--       非空 = 该团队自配应用（多企业 BYOK 场景按 team 覆盖，二期）。
-- 安全：app_secret / encrypt_key / verification_token 一律 AES-GCM 密文（格式 v1:iv:ct，
--       复用 aiKey 的 encryptAiKey/decryptAiKey），主密钥为 wrangler secret AI_KEY_SECRET；
--       主密钥未配置时飞书集成整体关闭，绝不降级明文。
-- app_id 明文存放：用于构造授权 URL 与反查事件回调归属，非机密。
CREATE TABLE IF NOT EXISTS feishu_apps (
  id TEXT PRIMARY KEY,
  team_id TEXT,                          -- NULL=全局；否则该 team_id 的自配应用
  name TEXT,                             -- 展示名（如「XX 公司飞书」）
  app_id TEXT NOT NULL,                  -- 飞书 App ID
  app_secret_enc TEXT NOT NULL,          -- App Secret（AES-GCM 密文）
  encrypt_key_enc TEXT,                  -- 事件加密 Encrypt Key（密文，可选）
  verification_token_enc TEXT,           -- 事件校验 Verification Token（密文，可选）
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feishu_apps_team ON feishu_apps(team_id);
