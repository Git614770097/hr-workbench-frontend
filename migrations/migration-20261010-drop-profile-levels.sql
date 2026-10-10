-- 2026-10-10 人才画像分级（match_profile_levels）已整体下线，
-- 代码不再读写该表。此迁移删除废弃表及索引，清理历史技术债。
-- 注意：仅对已无该表使用需求的环境执行；全新环境通过 schema.sql 建表时已不再创建此表。

DROP INDEX IF EXISTS idx_match_profile_levels_profile;
DROP TABLE IF EXISTS match_profile_levels;
