-- 合同文件表：合同/协议原件（PDF/Word）存 KV，元数据存 D1。
-- extracted_* 为 AI 从文件文本中识别出的日期（识别结果可能被人工修改后应用，
-- 因此只作记录，档案日期以 talents.contract_end / probation_end 为准）。
CREATE TABLE IF NOT EXISTS contract_files (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,             -- 上传人（租户隔离）
  talent_id TEXT NOT NULL,            -- 关联人才
  filename TEXT NOT NULL,             -- 原始文件名
  mime TEXT NOT NULL DEFAULT 'application/pdf',
  size INTEGER NOT NULL DEFAULT 0,    -- 字节数
  kv_key TEXT NOT NULL,               -- RESUMES KV 中的存储 key（contract: 前缀）
  extracted_contract_end TEXT,        -- AI 识别的合同到期日（YYYY-MM-DD 或 NULL）
  extracted_probation_end TEXT,       -- AI 识别的试用期到期日
  applied INTEGER NOT NULL DEFAULT 0, -- 识别结果是否已应用到人才档案（0/1）
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contract_files_talent ON contract_files(talent_id);
