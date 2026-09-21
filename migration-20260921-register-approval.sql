-- ============================================================
-- 迁移：users 增加 status 列，支撑「自助注册 + 管理员审批」
-- 背景：原设计只能由管理员创建用户。现增加注册入口，
--       但新注册用户状态为 pending，必须管理员审批并分配角色后才能登录。
-- 状态取值：active（正常，可登录） / pending（待审批，拒绝登录）
-- 注意：DEFAULT 'active' 是关键 —— 存量用户（含 admin）自动保持可用，
--       不会因为加这列而被锁在门外。
-- 执行：npx wrangler d1 execute hr-workbench --remote --file=./migration-20260921-register-approval.sql
-- 幂等性：SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS，重复执行会报
--         "duplicate column name: status"，属正常，可忽略。
-- ============================================================

ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

-- 存量用户明确置为 active（DEFAULT 已保证，此处仅做显式收口，双保险）
UPDATE users SET status = 'active' WHERE status IS NULL OR status = '';

-- 按状态查询是审批列表的主要场景，加索引
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
