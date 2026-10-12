-- 用户级 UI 偏好设置（key-value 形式，便于后续扩展）
-- 首个用途：工作台「调整模块」的模块显隐配置（key = workbench_modules，value = JSON 字符串）
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL REFERENCES users(id),
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, key)
);
