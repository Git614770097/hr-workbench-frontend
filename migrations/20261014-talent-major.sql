-- 人才库检索增强：talents 表新增 major（专业）字段
-- 执行：npx wrangler d1 execute hr-workbench --remote --file=./migrations/20261014-talent-major.sql
-- 存量数据默认 NULL，不影响现有查询与列表渲染；简历解析/录入表单/导入核对统一补该字段。
ALTER TABLE talents ADD COLUMN major TEXT;
