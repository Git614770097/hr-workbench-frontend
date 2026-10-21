-- 飞书群自定义机器人 webhook：零应用依赖的推送通道。
-- 管理员在飞书「群设置 → 群机器人 → 添加自定义机器人」复制 webhook 地址后贴入本系统，
-- 提醒即可发到群里（全员可见，不能精准私信个人）。
-- URL 含敏感 token，复用 aiKey AES-GCM 加密范式存储（主密钥 AI_KEY_SECRET）。
CREATE TABLE IF NOT EXISTS feishu_webhooks (
  id TEXT PRIMARY KEY,
  team_id TEXT,                 -- NULL=全局默认；非空=该 team 自配（与 feishu_apps 同模式）
  name TEXT NOT NULL,
  url_enc TEXT NOT NULL,        -- webhook URL 密文（v1:<iv>:<ciphertext> base64）
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 发送模式存 site_settings（key = feishu_notify_mode）：both=群+个人 / group=仅群 / personal=仅个人
