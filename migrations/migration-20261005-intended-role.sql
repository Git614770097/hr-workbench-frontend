-- 注册时声明「身份」：仅作为意向标记，不参与鉴权。
-- 真正的菜单权限永远由 roles.permissions 决定（管理员审批时确认/调整）。
-- 这样以后新增身份（如 RPO、校园招聘）只需加一个取值 + 配一个角色模板，
-- 不需要改任何鉴权代码。
ALTER TABLE users ADD COLUMN intended_role TEXT;
