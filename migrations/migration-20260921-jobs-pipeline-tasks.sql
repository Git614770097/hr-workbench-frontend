-- ============================================================
-- 2026-09-21  P0 功能：岗位管理 + 招聘流程看板 + 跟进待办
-- 在已部署的 hr-workbench 库上执行一次（幂等，可重复执行）：
--   npx wrangler d1 execute hr-workbench --remote --file=./migration-20260921-jobs-pipeline-tasks.sql
-- ============================================================

-- ---------- 岗位表 ----------
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,               -- 岗位名称
  department TEXT,                   -- 用人部门
  city TEXT,                         -- 工作城市
  job_type TEXT DEFAULT 'fulltime',  -- fulltime 全职 / parttime 兼职 / intern 实习 / outsourced 外包
  headcount INTEGER DEFAULT 1,       -- 招聘人数（HC）
  priority TEXT DEFAULT 'normal',    -- high 紧急 / normal 常规 / low 储备
  status TEXT DEFAULT 'open',        -- open 在招 / paused 暂停 / closed 已关闭
  salary_range TEXT,                 -- 薪资范围，如 25-40K
  education TEXT,                    -- 学历要求
  experience TEXT,                   -- 经验要求，如 3-5年
  description TEXT,                  -- 岗位职责
  requirements TEXT,                 -- 任职要求
  opened_at TEXT,                    -- 开放日期 YYYY-MM-DD
  closed_at TEXT,                    -- 关闭日期
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ---------- 候选人-岗位关联表（一名人才可应聘多个岗位）----------
CREATE TABLE IF NOT EXISTS talent_jobs (
  id TEXT PRIMARY KEY,
  talent_id TEXT NOT NULL REFERENCES talents(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  stage TEXT NOT NULL DEFAULT 'screening',  -- 见下方阶段说明
  rating INTEGER,                           -- 1-5 面试评价
  notes TEXT,                               -- 该岗位下的备注
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (talent_id, job_id)
);

-- 阶段取值：screening 简历筛选 / interview1 初试 / interview2 复试 /
--          offer Offer / hired 已入职 / rejected 已淘汰 / withdrawn 已放弃

-- ---------- 阶段流转日志 ----------
CREATE TABLE IF NOT EXISTS job_stage_logs (
  id TEXT PRIMARY KEY,
  talent_job_id TEXT NOT NULL REFERENCES talent_jobs(id),
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  remark TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ---------- 跟进待办表 ----------
CREATE TABLE IF NOT EXISTS talent_tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  talent_id TEXT REFERENCES talents(id),
  job_id TEXT REFERENCES jobs(id),
  title TEXT NOT NULL,
  content TEXT,
  due_date TEXT,                     -- 到期日 YYYY-MM-DD，空表示不限时
  priority TEXT DEFAULT 'normal',    -- high / normal / low
  status TEXT DEFAULT 'pending',     -- pending 待办 / done 已完成 / cancelled 已取消
  source TEXT DEFAULT 'manual',      -- manual 手动创建 / follow_up 沟通记录生成 / system 系统生成
  done_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ---------- 索引 ----------
CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_talent_jobs_talent ON talent_jobs(talent_id);
CREATE INDEX IF NOT EXISTS idx_talent_jobs_job ON talent_jobs(job_id);
CREATE INDEX IF NOT EXISTS idx_talent_jobs_stage ON talent_jobs(stage);
CREATE INDEX IF NOT EXISTS idx_stage_logs_tj ON job_stage_logs(talent_job_id);
CREATE INDEX IF NOT EXISTS idx_tasks_owner_status ON talent_tasks(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON talent_tasks(due_date);

-- ---------- talents 表补充字段 ----------
-- 注意：SQLite 不支持 ADD COLUMN IF NOT EXISTS，重复执行会报
-- "duplicate column name"，可忽略。首列写入即代表迁移已生效。
ALTER TABLE talents ADD COLUMN stage TEXT DEFAULT 'new';
-- stage：new 新录入 / screening 筛选中 / interview 面试中 / offer Offer 中 /
--        hired 已入职 / archived 已归档（人才库全局状态，与岗位下的阶段相互独立）
ALTER TABLE talents ADD COLUMN source TEXT;
-- source：boss / liepin / 51job / zhaopin / referral 内推 / campus 校招 /
--         official 官网 / headhunter 猎头 / other 其他
