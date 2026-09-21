-- ============================================================
-- 迁移：给 talents 增加 gender（性别）列
-- 背景：AI 简历解析（worker/routes/aiParse.ts）一直会识别并返回 gender，
--       但数据表没有对应列、表单没有输入框，解析出来的值被直接丢弃。
--       本次补齐链路：DB 列 → 表单输入 → 详情展示。
-- 执行：npx wrangler d1 execute hr-workbench --remote --file=./migration-20260921-add-gender.sql
-- 注意：SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS，重复执行会报
--       "duplicate column name: gender"，属正常，可忽略。
-- ============================================================

ALTER TABLE talents ADD COLUMN gender TEXT;
