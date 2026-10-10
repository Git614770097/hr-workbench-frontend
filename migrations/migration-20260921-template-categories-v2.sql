-- 迁移：模板分类缩减为 6 大类（旧 15 类 → 新 6 类）
-- 执行：npx wrangler d1 execute hr-workbench --remote --file=./migration-20260921-template-categories-v2.sql
-- 映射：招聘录用/入职管理 → 招聘入职；劳动合同/保密竞业/实习劳务 → 合同协议；
--       试用转正/异动管理/培训发展 → 员工异动；薪酬绩效/休假考勤 → 薪酬福利；
--       离职管理/工伤退休 → 离职退休；证明文件/制度公示/其他 → 证明文档

UPDATE doc_templates SET category = '招聘入职' WHERE category IN ('招聘录用', '入职管理');
UPDATE doc_templates SET category = '合同协议' WHERE category IN ('劳动合同', '保密竞业', '实习劳务');
UPDATE doc_templates SET category = '员工异动' WHERE category IN ('试用转正', '异动管理', '培训发展');
UPDATE doc_templates SET category = '薪酬福利' WHERE category IN ('薪酬绩效', '休假考勤');
UPDATE doc_templates SET category = '离职退休' WHERE category IN ('离职管理', '工伤退休');
UPDATE doc_templates SET category = '证明文档' WHERE category IN ('证明文件', '制度公示', '其他');
