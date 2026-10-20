-- 操作审计日志（合规刚需）：谁、在何时、对什么对象、做了什么。
-- 覆盖：所有增删改（自动）、敏感查看（简历/合同/背调报告预览、导出）、登录/登出/授权等。
-- 与 usage_events（前端埋点热度）不同，audit_logs 记的是「影响数据的操作」，是追溯与个保合规的依据。
-- 设计取舍：不按菜单权限细分，只按 role 存快照即可；查询仅管理员可见。

CREATE TABLE IF NOT EXISTS audit_logs (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL DEFAULT (datetime('now')),
  user_id     TEXT,
  user_name   TEXT,
  role        TEXT,                 -- 操作时的角色快照
  action      TEXT NOT NULL,        -- create/update/delete/view/export/login/logout/grant/verify/approve/reset
  target_type TEXT NOT NULL,        -- talent/job/contract/resume/bgcheck/user/role/template/system
  target_id   TEXT,
  target_name TEXT,
  detail      TEXT,                 -- JSON：补充上下文（如改了哪些字段、导出了多少条）
  ip          TEXT,
  ua          TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, ts);
