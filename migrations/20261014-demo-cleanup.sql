-- 2026-10-14 demo 收口 + 死表清理
-- 背景：产品正式化 P0。演示数据功能（一键载入/清除）已从代码下线，
-- 线上残留 52 个演示人才 + 15 个演示岗位（is_demo=1）需按外键序级联清除；
-- 另删 9 张早期探索遗留的死表（代码零引用）。

-- ---- 1. 死表（均为 0-1 行早期残留，代码零引用）----
-- 注意顺序：attendance/leave_requests/processes/payroll 外键引用 employees(id)，必须先删子表
DROP TABLE IF EXISTS attendance;
DROP TABLE IF EXISTS leave_requests;
DROP TABLE IF EXISTS processes;
DROP TABLE IF EXISTS payroll;
DROP TABLE IF EXISTS employees;
DROP TABLE IF EXISTS candidates;
DROP TABLE IF EXISTS resumes;
DROP TABLE IF EXISTS materials;
DROP TABLE IF EXISTS feishu_configs;

-- ---- 2. 演示数据（is_demo=1）按外键序级联清除 ----
-- 审批链（实例为 0，防御性保留）
DELETE FROM approval_steps WHERE instance_id IN (
  SELECT id FROM approval_instances WHERE talent_id IN (SELECT id FROM talents WHERE is_demo = 1)
);
DELETE FROM approval_instances WHERE talent_id IN (SELECT id FROM talents WHERE is_demo = 1);

-- 入职材料
DELETE FROM onboarding_items WHERE talent_id IN (SELECT id FROM talents WHERE is_demo = 1);

-- 合同（原件在 KV contract: 前缀，另行删除）
DELETE FROM contract_files WHERE talent_id IN (SELECT id FROM talents WHERE is_demo = 1);

-- 面试
DELETE FROM interviews WHERE talent_id IN (SELECT id FROM talents WHERE is_demo = 1);

-- 社保台账
DELETE FROM talent_social WHERE talent_id IN (SELECT id FROM talents WHERE is_demo = 1);

-- AI 缓存
DELETE FROM ai_artifacts WHERE biz_id IN (SELECT id FROM talents WHERE is_demo = 1);

-- 沟通记录
DELETE FROM communications WHERE talent_id IN (SELECT id FROM talents WHERE is_demo = 1);

-- 看板轨迹日志 → 投递 → 待办（无 owner 列的按 talent/job 两端归属删）
DELETE FROM job_stage_logs WHERE talent_job_id IN (
  SELECT id FROM talent_jobs
  WHERE talent_id IN (SELECT id FROM talents WHERE is_demo = 1)
     OR job_id IN (SELECT id FROM jobs WHERE is_demo = 1)
);
DELETE FROM talent_jobs
WHERE talent_id IN (SELECT id FROM talents WHERE is_demo = 1)
   OR job_id IN (SELECT id FROM jobs WHERE is_demo = 1);
DELETE FROM talent_tasks
WHERE talent_id IN (SELECT id FROM talents WHERE is_demo = 1)
   OR job_id IN (SELECT id FROM jobs WHERE is_demo = 1);

-- 主体
DELETE FROM talents WHERE is_demo = 1;
DELETE FROM jobs WHERE is_demo = 1;

-- ---- 3. 摘除 is_demo 列（演示功能已下线，SQLite 3.35+ 支持 DROP COLUMN）----
ALTER TABLE talents DROP COLUMN is_demo;
ALTER TABLE jobs DROP COLUMN is_demo;
