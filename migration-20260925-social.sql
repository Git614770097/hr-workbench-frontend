-- 社保公积金模块：入职日期 + 参保台账
-- 2026-09-25

-- 入职日期（社保增员待办的基准日；Offer/工龄统计后续也用它）
ALTER TABLE talents ADD COLUMN hire_date TEXT;

-- 参保台账：一人一条（talent_id 唯一），记录缴费基数与比例。
-- 基数/比例全部由用户按参保地政策自行填写——系统只做记录、提醒、待办联动，不维护费率规则库。
CREATE TABLE IF NOT EXISTS talent_social (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  talent_id TEXT NOT NULL UNIQUE REFERENCES talents(id) ON DELETE CASCADE,
  si_status TEXT NOT NULL DEFAULT 'none',  -- none 未参保 / active 参保中 / stopped 已停缴
  si_city TEXT,                            -- 参保地
  si_base REAL,                            -- 社保月缴费基数
  hf_base REAL,                            -- 公积金月缴费基数
  si_rate_personal REAL,                   -- 社保个人比例（%）
  si_rate_company REAL,                    -- 社保单位比例（%）
  hf_rate_personal REAL,                   -- 公积金个人比例（%）
  hf_rate_company REAL,                    -- 公积金单位比例（%）
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_talent_social_talent ON talent_social(talent_id);
CREATE INDEX IF NOT EXISTS idx_talent_social_owner ON talent_social(owner_id);
