-- 老带新推广（邀请奖励）：2026-10-04
-- 说明：只加列 + 加表，不动任何既有数据。
--   users.referral_code  本人邀请码（唯一，8 位大写）
--   users.referred_by    上级 user_id（仅注册时写入一次，不做事后补填 → 互推/循环套利不成立）
--   referrals            推广台账：pending 未付费 / rewarded 已发奖 / invalid 已作废

ALTER TABLE users ADD COLUMN referral_code TEXT;
ALTER TABLE users ADD COLUMN referred_by TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);

CREATE TABLE IF NOT EXISTS referrals (
  id                    TEXT PRIMARY KEY,
  referrer_id           TEXT NOT NULL,
  invitee_id            TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
  created_at            TEXT DEFAULT (datetime('now')),
  rewarded_at           TEXT,
  reward_months_referrer INTEGER,
  reward_months_invitee  INTEGER,
  note                  TEXT
);

-- 一个人只能归属一个推荐人 → 杜绝重复计奖
CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_invitee ON referrals(invitee_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);

-- 存量用户回填邀请码：取 UUID 去横线后的前 8 位大写
UPDATE users
   SET referral_code = upper(substr(replace(id, '-', ''), 1, 8))
 WHERE referral_code IS NULL OR referral_code = '';
