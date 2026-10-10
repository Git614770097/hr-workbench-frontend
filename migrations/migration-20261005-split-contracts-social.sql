-- 2026-10-05：合同管理 / 社保公积金 从「人才库管理(talents)」拆为独立菜单权限
--
-- 背景：/contracts 与 /social 两个页面此前复用 talents 权限 key
--       （两者数据都挂在 talents 表上），导致任何有 talents 的角色都必然看到
--       这两块 HR 台账；猎头角色想关掉它们，就得连人才库一起关掉，做不到。
--       现在拆出 contracts / social 两个 key，改由「角色管理」逐个勾选。
--
-- 后端：/api/talents/contracts/* 与 /api/talents/social/* 已在 worker/index.ts
--       的同一中间件内分流校验（Hono 的 /api/talents/* 也会匹配裸路径，
--       不能靠再注册一个 app.use 来叠加，否则会变成必须同时拥有两个权限）。
--       ⚠️ 接口层仍会调用 /api/talents 读人才数据，所以 contracts / social
--          需与实际使用方一起勾选「人才库管理」。
--
-- 回填策略：
--   1. 现有「含 talents 的角色」补齐 contracts + social，保证存量角色不丢菜单；
--   2. role_headhunter（猎头）本次刻意不补 —— 猎头不做社保公积金台账，
--      这正是本次拆分要达成的效果。若之后仍要给猎头开放，在「角色管理」里勾选即可。
--   3. 幂等：已含 contracts 的角色不再重复追加。

UPDATE roles
SET permissions = json_insert(permissions, '$[#]', 'contracts', '$[#]', 'social')
WHERE permissions LIKE '%"talents"%'
  AND permissions NOT LIKE '%"contracts"%'
  AND id <> 'role_headhunter';

-- 校验（执行后可单独跑一遍确认）：
--   SELECT id, name, permissions FROM roles;
-- 预期：
--   role_default    普通员工 -> [...,"talents","templates",...,"contracts","social"]
--   role_headhunter 猎头     -> ["talents","jobs","pipeline","funnel","tasks","profiles"]（不变）
