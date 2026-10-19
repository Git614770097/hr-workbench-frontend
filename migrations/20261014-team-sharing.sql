-- 团队数据共享 + 管理员（manager）角色
-- users.team_id：NULL=个人（数据仅自己可见）；非 NULL=所属团队标识。
--   约定：管理员（role='manager'）的 team_id = 自己的 id（自建团队）；
--   子用户 team_id = 其管理员的 id。同 team_id 的用户互相共享业务数据。
-- roles.owner_id：角色创建者。NULL=系统/超管创建的全局角色；
--   管理员创建的角色记录自己的 id，超管可见全部，管理员仅见自己创建的。
ALTER TABLE users ADD COLUMN team_id TEXT;
ALTER TABLE roles ADD COLUMN owner_id TEXT;
CREATE INDEX IF NOT EXISTS idx_users_team ON users(team_id);
