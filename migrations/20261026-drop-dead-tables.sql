-- 2026-10-26 项目瘦身 A1：出清死表 communications / background_checks
-- 业务侧（沟通记录、背调中心）早已下线，代码只剩级联 DELETE；今日从 schema 与运行库一并移除。
-- 审计 TARGET_META.bgcheck 标签保留（历史审计行仍可读）。KV 里 bgcheck: 前缀报告原件不主动扫删，闲置即可。
DROP TABLE IF EXISTS communications;
DROP TABLE IF EXISTS background_checks;
