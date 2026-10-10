-- 迁移：talents 表新增 年龄 / 学历 / 院校 字段（2026-09-18）
-- 对已有数据库执行一次：
--   npx wrangler d1 execute hr-workbench --remote --file=./migration-20260918-add-edu-fields.sql
-- 注意：SQLite 不支持 ADD COLUMN IF NOT EXISTS，重复执行会报错（可忽略"duplicate column name"）

ALTER TABLE talents ADD COLUMN age INTEGER;
ALTER TABLE talents ADD COLUMN education TEXT;  -- 学历
ALTER TABLE talents ADD COLUMN school TEXT;     -- 毕业院校
