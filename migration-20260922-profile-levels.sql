-- 2026-09-22 人物画像分级：一个职位画像下挂多个「级别」（初级/中级/高级…）
-- 每个级别绑定：年限区间、学历、技能、城市，以及该级别对应的市场薪资（区间 + 说明）。
-- 匹配时按候选人经验年限自动落位到对应级别，用该级别的硬指标打分。

CREATE TABLE IF NOT EXISTS match_profile_levels (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES match_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                -- 级别名，如「初级」「中级」「高级」
  min_years INTEGER,                 -- 年限下限
  max_years INTEGER,                 -- 年限上限（NULL = 不设上限）
  education TEXT,                    -- 学历门槛
  city TEXT,                         -- 工作城市
  must_skills TEXT,                  -- JSON 数组：必备技能
  nice_skills TEXT,                  -- JSON 数组：加分技能
  requirements TEXT,                 -- 其它要求
  salary_min INTEGER,                -- 市场薪资下限（月薪，元）
  salary_max INTEGER,                -- 市场薪资上限（月薪，元）
  salary_note TEXT,                  -- 薪资说明，如「一线城市」「13 薪」
  sort_order INTEGER DEFAULT 0,      -- 级别排序（初级在前）
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_match_profile_levels_profile ON match_profile_levels(profile_id);
