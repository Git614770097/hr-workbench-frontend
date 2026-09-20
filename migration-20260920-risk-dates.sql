-- 2026-09-20 风险预警：人才档案补充关键日期字段
-- 在已部署的 hr-workbench 库上执行一次：
--   npx wrangler d1 execute hr-workbench --remote --file=./migration-20260920-risk-dates.sql

ALTER TABLE talents ADD COLUMN birth_date TEXT;        -- 出生日期（生日提醒）
ALTER TABLE talents ADD COLUMN contract_end TEXT;      -- 合同到期日
ALTER TABLE talents ADD COLUMN probation_end TEXT;     -- 试用期结束日
ALTER TABLE talents ADD COLUMN resignation_date TEXT;  -- 预计离职日期（离职倒计时）
