-- 待办日历：talent_tasks 新增 task_type 枚举字段
-- 目的：
--   1. 替代 title LIKE '试用期跟进%' 这种脆弱的去重逻辑（L1）
--   2. 让系统自动待办可以按类型做不同样式、不同模板（N2）
-- 执行：npx wrangler d1 execute hr-workbench --remote --file=./migrations/20261022-task-type.sql
--
-- task_type 取值：
--   manual            手动创建（用户自己建的）
--   probation         试用期跟进（入职 30/60/90 天）
--   social_add        社保增员
--   social_leave      社保减员
--   contract_expire   合同到期续签
--   pipeline_stall    流程停滞（招聘看板触发）
--   follow_up         跟进反馈（面试后自动生成）
--   interview_remind  面试提醒

ALTER TABLE talent_tasks ADD COLUMN task_type TEXT DEFAULT 'manual';

-- 回填：根据 title 模糊匹配已有系统待办，给它们补上 task_type
-- （title LIKE 只是过渡，新创建的都会显式传 task_type）
UPDATE talent_tasks SET task_type = 'probation'      WHERE task_type = 'manual' AND title LIKE '试用期跟进%';
UPDATE talent_tasks SET task_type = 'social_add'     WHERE task_type = 'manual' AND title LIKE '社保增员%';
UPDATE talent_tasks SET task_type = 'social_leave'   WHERE task_type = 'manual' AND title LIKE '社保减员%';
UPDATE talent_tasks SET task_type = 'contract_expire'WHERE task_type = 'manual' AND (title LIKE '合同到期%' OR title LIKE '试用期到期%');
UPDATE talent_tasks SET task_type = 'pipeline_stall' WHERE task_type = 'manual' AND title LIKE '阶段停滞%';
UPDATE talent_tasks SET task_type = 'follow_up'      WHERE task_type = 'manual' AND title LIKE '面试反馈跟进%';
UPDATE talent_tasks SET task_type = 'interview_remind' WHERE task_type = 'manual' AND title LIKE '面试提醒%';
