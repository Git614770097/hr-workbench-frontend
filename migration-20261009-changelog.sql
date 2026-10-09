-- 更新公告种子（site_settings 键值，前端首屏读取版本号弹窗）
-- 仅 admin 可改；version 改变即触发所有用户下次打开弹窗。WHERE NOT EXISTS 保证幂等。
INSERT INTO site_settings (key, value)
SELECT 'app_changelog', '{"version":"v1.0","title":"v1.0 更新公告","updated_at":"2026-10-09","items":["侧栏菜单重新归类为一/二级结构（功能与权限不变，只是更好找）","面试管理 / 审批中心 / 入职办理三模块业务打通，关键节点自动流转","注册与找回密码改用短信验证码，并修复了验证码校验失败的问题"]}'
WHERE NOT EXISTS (SELECT 1 FROM site_settings WHERE key = 'app_changelog');
