-- HR 人才库管理系统 数据库 Schema

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 人才档案表
CREATE TABLE IF NOT EXISTS talents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  current_company TEXT,
  current_title TEXT,
  years_experience INTEGER,
  city TEXT,
  skills TEXT,
  industry TEXT,
  expected_salary TEXT,
  expected_city TEXT,
  status TEXT DEFAULT 'active',
  resume_url TEXT,
  notes TEXT,
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
  type TEXT,
  content TEXT,
  rating INTEGER,
  follow_up_date TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_talents_owner ON talents(owner_id);
CREATE INDEX IF NOT EXISTS idx_talents_status ON talents(status);
CREATE INDEX IF NOT EXISTS idx_communications_talent ON communications(talent_id);
CREATE INDEX IF NOT EXISTS idx_talent_tags_talent ON talent_tags(talent_id);
CREATE INDEX IF NOT EXISTS idx_talent_tags_tag ON talent_tags(tag_id);
