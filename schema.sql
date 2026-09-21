-- HR 人才库管理系统 数据库 Schema
-- 注意：users 表结构已变更（email → phone，新增 role），
-- 如已存在旧表需先执行：DROP TABLE IF EXISTS users;

-- 角色表（自定义角色 + 菜单权限）
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',  -- JSON 数组，如 ["talents","risks"]
  created_at TEXT DEFAULT (datetime('now'))
);

-- 用户表（手机号登录 + 角色）
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',  -- admin / user
  role_id TEXT REFERENCES roles(id), -- 关联自定义角色（admin 忽略）
  created_at TEXT DEFAULT (datetime('now'))
);

-- 人才档案表
CREATE TABLE IF NOT EXISTS talents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  age INTEGER,
  gender TEXT,        -- 性别: 男 / 女（AI 简历解析会识别并落库）
  education TEXT,     -- 学历: 高中及以下 / 中专 / 大专 / 本科 / 硕士 / 博士 / MBA/EMBA / 其他
  school TEXT,        -- 毕业院校
  current_company TEXT,
  current_title TEXT,
  years_experience INTEGER,
  city TEXT,
  skills TEXT,          -- JSON 数组: ["Java","Spring","MySQL"]
  industry TEXT,
  expected_salary TEXT,
  expected_city TEXT,
  status TEXT DEFAULT 'active',  -- active / passive / placed / do_not_contact
  resume_url TEXT,
  notes TEXT,
  stage TEXT DEFAULT 'new', -- 全局招聘阶段: new/screening/interview/offer/hired/archived
  source TEXT,              -- 来源渠道: boss/liepin/51job/zhaopin/referral/campus/...
  birth_date TEXT,          -- 出生日期（生日提醒）
  contract_end TEXT,        -- 合同到期日
  probation_end TEXT,       -- 试用期结束日
  resignation_date TEXT,    -- 预计离职日期（离职倒计时）
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 岗位表
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,               -- 岗位名称
  department TEXT,                   -- 用人部门
  city TEXT,                         -- 工作城市
  job_type TEXT DEFAULT 'fulltime',  -- fulltime / parttime / intern / outsourced
  headcount INTEGER DEFAULT 1,       -- 招聘人数（HC）
  priority TEXT DEFAULT 'normal',    -- high / normal / low
  status TEXT DEFAULT 'open',        -- open 在招 / paused 暂停 / closed 已关闭
  salary_range TEXT,
  education TEXT,
  experience TEXT,
  description TEXT,
  requirements TEXT,
  opened_at TEXT,
  closed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 候选人-岗位关联表（一名人才可应聘多个岗位）
CREATE TABLE IF NOT EXISTS talent_jobs (
  id TEXT PRIMARY KEY,
  talent_id TEXT NOT NULL REFERENCES talents(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  stage TEXT NOT NULL DEFAULT 'screening',  -- screening/interview1/interview2/offer/hired/rejected/withdrawn
  rating INTEGER,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (talent_id, job_id)
);

-- 阶段流转日志
CREATE TABLE IF NOT EXISTS job_stage_logs (
  id TEXT PRIMARY KEY,
  talent_job_id TEXT NOT NULL REFERENCES talent_jobs(id),
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  remark TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 跟进待办表
CREATE TABLE IF NOT EXISTS talent_tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  talent_id TEXT REFERENCES talents(id),
  job_id TEXT REFERENCES jobs(id),
  title TEXT NOT NULL,
  content TEXT,
  due_date TEXT,
  priority TEXT DEFAULT 'normal',    -- high / normal / low
  status TEXT DEFAULT 'pending',     -- pending / done / cancelled
  source TEXT DEFAULT 'manual',      -- manual / follow_up / system
  done_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 标签表
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#3b82f6',
  owner_id TEXT NOT NULL REFERENCES users(id)
);

-- 人才-标签关联表
CREATE TABLE IF NOT EXISTS talent_tags (
  talent_id TEXT NOT NULL REFERENCES talents(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (talent_id, tag_id)
);

-- 沟通记录表
CREATE TABLE IF NOT EXISTS communications (
  id TEXT PRIMARY KEY,
  talent_id TEXT NOT NULL REFERENCES talents(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT,            -- call / wechat / interview / email / other
  content TEXT,
  rating INTEGER,      -- 1-5 评分
  follow_up_date TEXT,  -- 跟进提醒日期
  created_at TEXT DEFAULT (datetime('now'))
);

-- 文档模板表（模板库全员共享可读；创建者或管理员可改/删，内置模板 owner_id='system'）
CREATE TABLE IF NOT EXISTS doc_templates (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,      -- 劳动合同 / 离职证明 / 调薪通知 / 警告信 / 在职证明 / 其他
  content TEXT NOT NULL,       -- 富文本 HTML，支持 {{姓名}} {{公司}} 等占位符
  scope TEXT NOT NULL DEFAULT 'shared',  -- official 官方（管理员维护，全员只读）/ shared 共享（创建者可改）/ private 个人（仅本人+管理员可见）
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_talents_owner ON talents(owner_id);
CREATE INDEX IF NOT EXISTS idx_talents_status ON talents(status);
CREATE INDEX IF NOT EXISTS idx_communications_talent ON communications(talent_id);
CREATE INDEX IF NOT EXISTS idx_talent_tags_talent ON talent_tags(talent_id);
CREATE INDEX IF NOT EXISTS idx_talent_tags_tag ON talent_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_doc_templates_category ON doc_templates(category);
CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_talent_jobs_talent ON talent_jobs(talent_id);
CREATE INDEX IF NOT EXISTS idx_talent_jobs_job ON talent_jobs(job_id);
CREATE INDEX IF NOT EXISTS idx_talent_jobs_stage ON talent_jobs(stage);
CREATE INDEX IF NOT EXISTS idx_stage_logs_tj ON job_stage_logs(talent_job_id);
CREATE INDEX IF NOT EXISTS idx_tasks_owner_status ON talent_tasks(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON talent_tasks(due_date);
