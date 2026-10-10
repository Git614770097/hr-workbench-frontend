-- 忘记密码：用户提交重置申请，管理员在「用户管理」中批准并设置新密码
--
-- 设计说明：
--   本系统没有短信/邮件通道，无法做「验证码自助重置」。
--   因此采用「用户提交申请 -> 管理员核对身份后批准并设置新密码」的流程，
--   与注册审批共用同一套思路，复用用户管理页的审批区块。
--
-- 新增列：
--   reset_requested_at  — 申请时间，NULL 表示当前没有待处理的重置申请
--   must_change_password — 管理员设置临时密码后置 1，用户下次登录需自行修改

ALTER TABLE users ADD COLUMN reset_requested_at TEXT;
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_users_reset ON users(reset_requested_at);
