-- 背景调查（候选人背调）：独立于招聘看板的轻量模块，逻辑挂在「Offer → 入职」之间。
-- 合规硬性前置：必须候选人单独明示授权（consent_status='granted'）才能发起核验 /
-- 查看敏感结论 / 上传报告 / 推进入职（后端强制闸门，前端仅做提示）。
-- 核验仅采集「最小必要」信息：身份 / 学历 / 工作履历 / 竞业限制；
-- 犯罪记录 / 征信属高敏数据（high_risk=1），授权时需二次明示确认。
CREATE TABLE IF NOT EXISTS background_checks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  talent_id TEXT NOT NULL REFERENCES talents(id),
  talent_job_id TEXT REFERENCES talent_jobs(id) ON DELETE CASCADE,
  -- pending 待发起 / processing 核验中 / completed 已出报告待判定 / passed 已通过并入职 / failed 未通过 / cancelled 已取消
  status TEXT NOT NULL DEFAULT 'pending',
  -- none 未授权 / requested 已发授权请求 / granted 已授权 / declined 候选人拒绝
  consent_status TEXT NOT NULL DEFAULT 'none',
  consent_at TEXT,                 -- 授权时间
  consent_method TEXT,             -- 授权方式留痕（如「书面授权书」「电子签署」）
  provider TEXT NOT NULL DEFAULT 'manual',  -- manual 内部人工 / 第三方机构名
  high_risk INTEGER NOT NULL DEFAULT 0,     -- 是否涉及犯罪/征信等高敏项（需二次确认）
  items_json TEXT,                 -- 分项核验结果 JSON：[{type,label,status,note}]
  -- 报告原件存 KV（bgcheck: 前缀），元数据存此处
  report_kv_key TEXT,
  report_name TEXT,
  summary TEXT,                    -- 背调小结（人工填写或 AI 生成草稿）
  result TEXT,                     -- 结论：pass 建议通过 / fail 建议不通过（completed 后填写）
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bgcheck_owner ON background_checks(owner_id);
CREATE INDEX IF NOT EXISTS idx_bgcheck_talent ON background_checks(talent_id);
CREATE INDEX IF NOT EXISTS idx_bgcheck_job ON background_checks(talent_job_id);
CREATE INDEX IF NOT EXISTS idx_bgcheck_status ON background_checks(status);
