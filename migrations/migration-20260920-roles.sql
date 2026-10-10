-- 权限管理：自定义角色 + 菜单权限
-- roles 表存角色及允许的菜单 key（permissions 为 JSON 数组字符串）
-- users 表加 role_id 关联角色；原 role 字段保留（admin 为内置超级管理员，不受角色权限限制）

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',  -- JSON 数组，如 ["talents","risks"]
  created_at TEXT DEFAULT (datetime('now'))
);

-- users 表增加 role_id（可空：空表示用默认/无角色权限，admin 忽略该字段）
ALTER TABLE users ADD COLUMN role_id TEXT REFERENCES roles(id);

-- 内置一个默认角色「普通员工」，仅开放人才库、风险预警、文件模板库、标签管理
-- 用户管理（users）仅 admin 可见，任何角色都不授予
INSERT OR IGNORE INTO roles (id, name, permissions) VALUES (
  'role_default',
  '普通员工',
  '["talents","risks","templates","tags"]'
);
