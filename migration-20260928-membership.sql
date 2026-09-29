-- 会员有效期 + 支付收款配置（2026-09-28）
-- 用户扫码付款后，由管理员在「用户管理」手动开通/续期/清空。

ALTER TABLE users ADD COLUMN paid_until TEXT;

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
