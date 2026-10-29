-- 飞书应用三级作用域（2026-10-29）
-- 1) feishu_apps.user_id：个人自配行（team_id IS NULL AND user_id 非空）。
--    解析顺序：团队行 → 个人行 → 全局行（team_id/user_id 均 NULL），跨企业用户可自助配自己企业的应用。
-- 2) users.feishu_app_id：绑定时实际使用的飞书应用 app_id。
--    open_id 是应用级标识（同人不同应用 open_id 不同），发消息必须用绑定时同一应用，否则投递不到。
ALTER TABLE feishu_apps ADD COLUMN user_id TEXT;
ALTER TABLE users ADD COLUMN feishu_app_id TEXT;
