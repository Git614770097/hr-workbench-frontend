-- 迁移：社保公积金「参保城市费率模板」
--
-- 背景：参保比例原本只能逐人手填 4 个数字（社保个人/单位 + 公积金个人/单位），
-- 同城员工每次都要重填。本表按城市存一份默认比例，编辑参保信息时选城市自动带出。
--
-- 分层沿用模板库的 official/shared/private 思路：
--   owner_id = 'system' → 内置的参考值，所有人可读；
--   owner_id = <用户 id> → 用户自己的，同城优先命中自己的（可覆盖 system）。

CREATE TABLE IF NOT EXISTS social_rate_templates (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  city TEXT NOT NULL,
  si_rate_personal REAL,
  si_rate_company REAL,
  hf_rate_personal REAL,
  hf_rate_company REAL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 同一 owner 下城市不重复（system 的参考值也受此约束）
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_rate_owner_city
  ON social_rate_templates (owner_id, city);

-- 预置参考值：全国性框架大致值（养老个人 8% + 医疗约 2% + 失业 0.5%），
-- 各地在单位侧比例、公积金区间上差异较大，这些只是「能直接用」的起点，
-- 页面上必须提示按当地社保/公积金中心最新口径核对。
INSERT OR IGNORE INTO social_rate_templates
  (id, owner_id, city, si_rate_personal, si_rate_company, hf_rate_personal, hf_rate_company)
VALUES
  ('sr-sys-sh', 'system', '上海', 10.5, 26.5, 7, 7),
  ('sr-sys-bj', 'system', '北京', 10.5, 27.0, 12, 12),
  ('sr-sys-sz', 'system', '深圳', 9.5, 24.0, 5, 5),
  ('sr-sys-gz', 'system', '广州', 10.5, 25.5, 5, 5),
  ('sr-sys-hz', 'system', '杭州', 10.5, 25.5, 12, 12);
