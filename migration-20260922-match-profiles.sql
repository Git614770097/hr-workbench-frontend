-- 2026-09-22 智能匹配：人物画像表
-- 用于「上传多份简历 + 人物画像 → 排序推荐」的画像（招聘需求）存储
CREATE TABLE IF NOT EXISTS match_profiles (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,                 -- 画像名称，如「前端负责人-深圳」
  job_title TEXT,                     -- 目标职位
  city TEXT,                          -- 工作城市
  education TEXT,                     -- 学历门槛（高中及以下/中专/大专/本科/硕士/博士/MBA-EMBA/其他）
  min_years INTEGER,                  -- 经验年限下限
  max_years INTEGER,                  -- 经验年限上限（NULL 表示不限）
  salary_range TEXT,                  -- 薪资范围，如「20-35K」
  industry TEXT,                      -- 行业背景要求
  must_skills TEXT,                   -- JSON 数组：必备技能
  nice_skills TEXT,                   -- JSON 数组：加分技能
  requirements TEXT,                  -- 其它要求（软性素质/管理经验等）
  jd_raw TEXT,                        -- 原始 JD 文本（AI 生成画像时的输入，便于回溯）
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_match_profiles_owner ON match_profiles(owner_id);
