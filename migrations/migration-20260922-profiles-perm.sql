-- 2026-09-22 「人才画像」升级为独立菜单（权限 key: profiles）
-- 给已有角色补上 profiles 权限，避免老账号登录后看不到新菜单。
-- 注意：roles.permissions 是 JSON 数组字符串，这里用 SQLite 的字符串处理判断是否已含 profiles，
-- 未含才追加，保证幂等（重复执行不会重复加）。

UPDATE roles
SET permissions = json_insert(permissions, '$[#]', 'profiles')
WHERE permissions IS NOT NULL
  AND permissions != ''
  AND NOT EXISTS (
    SELECT 1 FROM json_each(roles.permissions) WHERE json_each.value = 'profiles'
  );
