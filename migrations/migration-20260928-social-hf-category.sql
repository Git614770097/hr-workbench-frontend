-- 迁移：模板分类独立出「社保公积金」（第 7 大类）
-- 执行：npx wrangler d1 execute hr-workbench --remote --file=./migration-20260928-social-hf-category.sql
-- 把原挂在 招聘入职/薪酬福利/离职退休/证明文档 下的社保公积金模板统一归入新分类

UPDATE doc_templates SET category = '社保公积金' WHERE id IN (
  'tpl-builtin-social-ins-change',      -- 社保公积金增减员表
  'tpl-builtin-social-ins-base',        -- 社保基数调整通知
  'tpl-builtin-housing-fund-adjust',    -- 公积金缴存基数调整通知
  'tpl-builtin-social-intake',          -- 新员工社保公积金信息采集表
  'tpl-builtin-si-transfer',            -- 社保关系转移接续申请表
  'tpl-builtin-hf-transfer',            -- 住房公积金转移接续申请表
  'tpl-builtin-hf-withdrawal',          -- 住房公积金提取申请表
  'tpl-builtin-social-backpay',         -- 社保公积金补缴申请表
  'tpl-builtin-medical-reimburse',      -- 医疗费用报销申请表
  'tpl-builtin-si-stop-confirm',        -- 社保公积金停缴封存确认表
  'tpl-builtin-social-payment-cert'     -- 社保公积金缴纳证明
);
