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
  birth_date TEXT,          -- 出生日期（生日提醒）
  contract_end TEXT,        -- 合同到期日
  probation_end TEXT,       -- 试用期结束日
  resignation_date TEXT,    -- 预计离职日期（离职倒计时）
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
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
