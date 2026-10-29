-- feishu_apps 作用域唯一约束（2026-10-29）
-- 三级作用域（团队行 / 个人行 / 全局行）原无唯一约束，POST /my-app 是 SELECT→INSERT 两步，
-- 并发保存会插出重复行，之后 .first() 任意取一行、UPDATE 只改一行，两级数据互相打架且无法自愈。
-- SQLite 的 UNIQUE 对 NULL 不生效（NULL != NULL），故按作用域拆三个部分索引：
--   ① 个人行：user_id 非空时唯一
--   ② 团队行：team_id 非空且 user_id 为空时唯一
--   ③ 全局行：两者皆空时只允许一行（表达式常量索引）

CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_apps_user_scope
  ON feishu_apps(user_id) WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_apps_team_scope
  ON feishu_apps(team_id) WHERE team_id IS NOT NULL AND user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_apps_global_scope
  ON feishu_apps((1)) WHERE team_id IS NULL AND user_id IS NULL;
