-- 2026-09-22 下线「标签管理」功能
-- 下线原因：标签表建了 3 个、但 talent_tags 关联 0 条，22 位人才无一人打过标签；
--   且它能提供的分类能力已被「状态 + 招聘阶段 + 技能 + 行业」覆盖，列表按标签筛选的
--   后端条件也没在前端接上（半成品）。留着只是负担。
-- 外键是开启的，必须按依赖顺序删：先删关联表，再删主表。
DROP TABLE IF EXISTS talent_tags;
DROP TABLE IF EXISTS tags;

-- 如需恢复，用下面的语句重建（与下线前结构一致）：
-- CREATE TABLE IF NOT EXISTS tags (
--   id TEXT PRIMARY KEY,
--   name TEXT NOT NULL,
--   color TEXT DEFAULT '#3b82f6',
--   owner_id TEXT NOT NULL REFERENCES users(id)
-- );
-- CREATE TABLE IF NOT EXISTS talent_tags (
--   talent_id TEXT NOT NULL REFERENCES talents(id),
--   tag_id TEXT NOT NULL REFERENCES tags(id),
--   PRIMARY KEY (talent_id, tag_id)
-- );
