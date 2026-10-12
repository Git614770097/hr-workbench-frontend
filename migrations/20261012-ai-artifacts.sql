-- 2026-10-12 AI 辅助产出落库（简历解读 / 沟通文案 / 面试问题 / 综合评估）
-- 两个用途：
--   1) 缓存：同用户、同对象、同场景 10 分钟内的重复请求直接读库，不重复烧 token
--   2) 配额：按日 COUNT 做每用户每日 10 次的上限（超限返回 429）
-- 全新环境由 schema.sql 建表；本脚本仅用于已有库增量执行，重复执行无副作用（IF NOT EXISTS）。
CREATE TABLE IF NOT EXISTS ai_artifacts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  biz_type TEXT NOT NULL,                 -- resume_insight / outreach / interview_questions / candidate_summary
  biz_id TEXT NOT NULL,                   -- 人才 id；导入核对中的未入库记录用 "pre:{recordKey}"
  scene TEXT,                             -- 仅 outreach 用：场景+语气，如 reject:warm
  content TEXT NOT NULL,                  -- 结构化结果 JSON 字符串
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_artifacts_lookup ON ai_artifacts(owner_id, biz_type, biz_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_artifacts_quota ON ai_artifacts(owner_id, created_at);
