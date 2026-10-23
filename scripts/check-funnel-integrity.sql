-- ============================================================
-- 招聘概览 · 数据口径自检（只读，不改数据）
-- 用法：
--   npx wrangler d1 execute hr-workbench --remote --file=./scripts/check-funnel-integrity.sql
-- 背景：2026-10-22 修复了漏斗「上小下大」与「今日面试环比恒为新增」两个口径问题，
--       本脚本用于确认线上数据现状与修复效果（前两条是数据质量，后两条是口径验证）。
-- ============================================================

-- ① 阶段跳跃：到达后阶段，但日志里从未出现 interview1
--   修复前这些记录会让漏斗倒挂（初试 0 人 → Offer N 人）；
--   修复后统计层会自动补齐，这条查询用于衡量「历史数据缺口」有多大。
SELECT '① 阶段跳跃(缺前级日志)' AS check_item, COUNT(*) AS affected
FROM (
  SELECT tj.id
  FROM talent_jobs tj
  JOIN job_stage_logs l ON l.talent_job_id = tj.id
  GROUP BY tj.id
  HAVING SUM(CASE WHEN l.to_stage = 'interview1' THEN 1 ELSE 0 END) = 0
     AND SUM(CASE WHEN l.to_stage IN ('interview2','offer','hired') THEN 1 ELSE 0 END) > 0
);

-- ② 双终态：同一「人·岗位」既到达已入职、又到达已淘汰/已放弃
--   业务上不该出现，出现说明看板被反复拖拽过，会导致 summary 里 hired 与 rejected 重叠。
SELECT '② 双终态(既入职又淘汰)' AS check_item, COUNT(*) AS affected
FROM (
  SELECT tj.id
  FROM talent_jobs tj
  JOIN job_stage_logs l ON l.talent_job_id = tj.id
  GROUP BY tj.id
  HAVING SUM(CASE WHEN l.to_stage = 'hired' THEN 1 ELSE 0 END) > 0
     AND SUM(CASE WHEN l.to_stage IN ('rejected','withdrawn') THEN 1 ELSE 0 END) > 0
);

-- ③ 上周同日面试的状态分布
--   修复前「今日面试」环比只数 status='scheduled'，而这一批早已变成 done，
--   导致 prev 恒为 0、永远显示「新增」。修复后计数口径为 status <> 'cancelled'。
SELECT '③ 上周同日面试状态' AS check_item, status, COUNT(*) AS cnt
FROM interviews
WHERE substr(scheduled_at, 1, 10) = date('now', '-7 day')
GROUP BY status;

-- ④ 近 3 天到期待办条数（>20 说明旧版 KPI 用列表长度会被截断成 20）
SELECT '④ 近 3 天到期待办' AS check_item, COUNT(*) AS cnt
FROM talent_tasks
WHERE status = 'pending'
  AND due_date IS NOT NULL
  AND due_date >= date('now', '+8 hours')
  AND due_date <= date('now', '+8 hours', '+3 day');
