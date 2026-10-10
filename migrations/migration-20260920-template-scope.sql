-- 2026-09-20 模板作用域：official（官方）/ shared（共享）/ private（个人）
-- 在已部署的 hr-workbench 库上执行一次：
--   npx wrangler d1 execute hr-workbench --remote --file=./migration-20260920-template-scope.sql

ALTER TABLE doc_templates ADD COLUMN scope TEXT DEFAULT 'shared';

-- 内置模板升级为官方模板
UPDATE doc_templates SET scope = 'official' WHERE owner_id = 'system';
