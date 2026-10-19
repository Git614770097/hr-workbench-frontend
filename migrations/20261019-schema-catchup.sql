-- 归档补记：2026-10-19 schema 基线对齐
-- 背景：以下变更当时直接在生产库执行，未留迁移脚本，导致 schema.sql 基线腐坏
-- （缺表/缺列，全新部署会踩坑）。本文件补上迁移记录，生产库均已执行过。
-- ⚠️ 全新部署请以 schema.sql 全量基线为准，不要在本文件上重跑 ALTER（会报列重复）。
-- 生产执行日期（追溯）：usage 两表 2026-10-13；ai_key 2026-10-19；其余随各功能上线。

-- 社保费率模板
CREATE TABLE IF NOT EXISTS social_rate_templates (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  city TEXT NOT NULL,
  si_rate_personal REAL,
  si_rate_company REAL,
  hf_rate_personal REAL,
  hf_rate_company REAL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 模块点击率日志
CREATE TABLE IF NOT EXISTS usage_events (id TEXT PRIMARY KEY, ts TEXT NOT NULL, day TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT, menu TEXT NOT NULL, action TEXT NOT NULL DEFAULT 'view', detail TEXT, platform TEXT);
CREATE TABLE IF NOT EXISTS usage_daily (day TEXT NOT NULL, menu TEXT NOT NULL, user_id TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0, actions INTEGER NOT NULL DEFAULT 0, dwell_ms INTEGER NOT NULL DEFAULT 0, last_at TEXT, PRIMARY KEY (day, menu, user_id));

-- users：邀请制 / 通知渠道 / BYOK AI Key
ALTER TABLE users ADD COLUMN referral_code TEXT UNIQUE;
ALTER TABLE users ADD COLUMN referred_by TEXT;
ALTER TABLE users ADD COLUMN notify_channel TEXT DEFAULT 'pushplus';
ALTER TABLE users ADD COLUMN feishu_open_id TEXT;
ALTER TABLE users ADD COLUMN wecom_userid TEXT;
ALTER TABLE users ADD COLUMN ai_key TEXT;
ALTER TABLE users ADD COLUMN ai_key_masked TEXT;

-- talents：录入方式 / 标签
ALTER TABLE talents ADD COLUMN entry_type TEXT DEFAULT 'manual';
ALTER TABLE talents ADD COLUMN tags TEXT DEFAULT '[]';

-- talent_tasks：节假日顺延留底
ALTER TABLE talent_tasks ADD COLUMN original_due TEXT;
ALTER TABLE talent_tasks ADD COLUMN shifted INTEGER DEFAULT 0;

-- interviews：用人部门评价
ALTER TABLE interviews ADD COLUMN dept_result TEXT;
ALTER TABLE interviews ADD COLUMN dept_score INTEGER;
ALTER TABLE interviews ADD COLUMN dept_evaluation TEXT;

-- approval_instances：外部审批渠道（预留）
ALTER TABLE approval_instances ADD COLUMN ext_provider TEXT;
ALTER TABLE approval_instances ADD COLUMN ext_msg_id TEXT;
