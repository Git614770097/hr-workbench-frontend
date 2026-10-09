// 老带新推广（邀请奖励）—— 配置读取、邀请码生成、发奖
//
// 规则（2026-10-04 拍板）：
//   · 老用户 +2 个月，新用户 +1 个月，全程不涉及现金
//   · 奖励在「新用户真实付费、管理员点开通」那一刻才发放（注册不发、审批不发）
//   · 归属只在注册时写入一次，不提供事后补填 —— 因此互推 / 循环套利在数学上不成立
//
// 注意 D1 是 SQLite：双引号是标识符，字符串一律用单引号。

import type { Env } from "./index";
import { sendPushPlus } from "./reminders";
import { escapeHtml } from "../utils/escapeHtml";
import { genId } from "./helpers";

export interface ReferralConfig {
  enabled: boolean;
  /** 推荐人奖励月数 */
  referrerMonths: number;
  /** 被推荐人奖励月数 */
  inviteeMonths: number;
  /** 推荐人自己必须是有效会员才发奖（防冻结账号靠拉人复活） */
  referrerMustBeActive: boolean;
  /** 单个推荐人每年累计奖励上限（月） */
  capMonthsPerYear: number;
}

const DEFAULT_CONFIG: ReferralConfig = {
  enabled: true,
  referrerMonths: 2,
  inviteeMonths: 1,
  referrerMustBeActive: true,
  capMonthsPerYear: 12,
};

// 配置存 site_settings（key = referral_config，值为 JSON）。
// 未配置时回落到上面的默认值，所以不做后台配置 UI 也能跑。
export async function getReferralConfig(db: D1Database): Promise<ReferralConfig> {
  const row = await db
    .prepare("SELECT value FROM site_settings WHERE key = 'referral_config'")
    .first<{ value: string }>();
  if (!row?.value) return DEFAULT_CONFIG;
  try {
    const parsed = JSON.parse(row.value) as Partial<ReferralConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** 生成 8 位大写邀请码；极小的冲突概率下重试几次即可 */
export async function newReferralCode(db: D1Database): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const code = genId().replace(/-/g, "").slice(0, 8).toUpperCase();
    const hit = await db.prepare("SELECT id FROM users WHERE referral_code = ?").bind(code).first();
    if (!hit) return code;
  }
  return genId().replace(/-/g, "").slice(0, 10).toUpperCase();
}

/** 给指定用户在其现有有效期基础上顺延 N 个月（已过期/未开通则从今天起算），并解封 */
async function extendMembership(db: D1Database, userId: string, months: number): Promise<void> {
  await db
    .prepare(
      "UPDATE users SET status = 'active', paid_until = datetime(" +
        "CASE WHEN paid_until IS NULL OR datetime(paid_until) < datetime('now') " +
        "THEN datetime('now') ELSE datetime(paid_until) END, '+' || ? || ' months') WHERE id = ?"
    )
    .bind(String(months), userId)
    .run();
}

interface ReferralRow {
  id: string;
  referrer_id: string;
  invitee_id: string;
  status: string;
  note: string | null;
}

export interface RewardResult {
  rewarded: boolean;
  /** 未发奖的原因（rewarded=false 时有值），仅用于日志/管理员排查 */
  reason?: string;
  referrerMonths?: number;
  inviteeMonths?: number;
}

/**
 * 被推荐人「首次/每次付费开通」后调用：给双方加会员时长。
 *
 * 设计要点：
 *   - 只处理 status='pending' 的归属记录；已经发过奖的不会重复发（唯一索引 + 状态判断）
 *   - 推荐人非有效会员 / 撞上年度封顶 → 本次不发，但**保留 pending**，
 *     等条件满足后（推荐人续费、跨年）下一次付费时还能补发
 */
export async function grantReferralReward(
  env: Env,
  inviteeId: string
): Promise<RewardResult> {
  const cfg = await getReferralConfig(env.DB);
  if (!cfg.enabled) return { rewarded: false, reason: "推广功能未启用" };

  const ref = await env.DB
    .prepare("SELECT id, referrer_id, invitee_id, status, note FROM referrals WHERE invitee_id = ? AND status = 'pending'")
    .bind(inviteeId)
    .first<ReferralRow>();
  if (!ref) return { rewarded: false, reason: "无待发奖的推荐归属记录" };

  const referrer = await env.DB
    .prepare("SELECT id, name, status, paid_until, pushplus_token FROM users WHERE id = ?")
    .bind(ref.referrer_id)
    .first<{ id: string; name: string; status: string | null; paid_until: string | null; pushplus_token: string | null }>();
  if (!referrer) return { rewarded: false, reason: "推荐人账号已不存在" };

  // 闸①：推荐人必须是有效会员（冻结账号不能靠拉人复活）
  if (cfg.referrerMustBeActive) {
    const valid = referrer.status === "active" && referrer.paid_until !== null;
    if (!valid) {
      await env.DB
        .prepare("UPDATE referrals SET note = ? WHERE id = ?")
        .bind(`未发奖：推荐人当前非有效会员（${referrer.status}）`, ref.id)
        .run();
      return { rewarded: false, reason: "推荐人非有效会员" };
    }
  }

  // 闸②：单个推荐人每年累计奖励上限（月）
  const used = await env.DB
    .prepare(
      "SELECT COALESCE(SUM(reward_months_referrer), 0) AS m FROM referrals " +
        "WHERE referrer_id = ? AND status = 'rewarded' AND rewarded_at >= datetime('now', '-1 year')"
    )
    .bind(ref.referrer_id)
    .first<{ m: number }>();
  const usedMonths = Number(used?.m || 0);
  if (usedMonths + cfg.referrerMonths > cfg.capMonthsPerYear) {
    await env.DB
      .prepare("UPDATE referrals SET note = ? WHERE id = ?")
      .bind(`未发奖：推荐人本年度已累计 ${usedMonths} 个月，超上限 ${cfg.capMonthsPerYear}`, ref.id)
      .run();
    return { rewarded: false, reason: "推荐人本年度奖励已达上限" };
  }

  const invitee = await env.DB
    .prepare("SELECT id, name, pushplus_token FROM users WHERE id = ?")
    .bind(inviteeId)
    .first<{ id: string; name: string; pushplus_token: string | null }>();

  // 发奖：双方各顺延（注意顺序 —— 调用方已完成本次开通，这里是追加奖励）
  // 备注：管理员作为推荐人时也会照常写入有效期，但 UI 上恒显示「长期有效」
  //（Users.tsx 里 role==='admin' 单独分支），且冻结 cron 排除 admin，无副作用。
  await extendMembership(env.DB, ref.referrer_id, cfg.referrerMonths);
  await extendMembership(env.DB, inviteeId, cfg.inviteeMonths);

  await env.DB
    .prepare(
      "UPDATE referrals SET status = 'rewarded', rewarded_at = datetime('now'), " +
        "reward_months_referrer = ?, reward_months_invitee = ?, note = ? WHERE id = ?"
    )
    .bind(String(cfg.referrerMonths), String(cfg.inviteeMonths), "开通后自动发放", ref.id)
    .run();

  return {
    rewarded: true,
    referrerMonths: cfg.referrerMonths,
    inviteeMonths: cfg.inviteeMonths,
  };
}

/** 发奖后通知双方（失败不影响主流程，调用方应放在 waitUntil 里） */
export async function notifyReferralReward(
  env: Env,
  info: { referrerId: string; inviteeId: string; referrerMonths: number; inviteeMonths: number }
): Promise<void> {
  const rows = await env.DB
    .prepare("SELECT id, name, pushplus_token FROM users WHERE id IN (?, ?)")
    .bind(info.referrerId, info.inviteeId)
    .all<{ id: string; name: string; pushplus_token: string | null }>();
  const map = new Map((rows.results || []).map((u) => [u.id, u]));

  const referrer = map.get(info.referrerId);
  const invitee = map.get(info.inviteeId);

  const push = async (
    u: { name: string; pushplus_token: string | null } | undefined,
    title: string,
    content: string
  ) => {
    if (!u?.pushplus_token) return;
    await sendPushPlus(u.pushplus_token, title, content);
  };

  await push(
    referrer,
    "邀请奖励已到账",
    [
      `<b>${escapeHtml(invitee?.name || "你邀请的好友")} 已开通会员，邀请奖励已到账</b>`,
      `你的会员时长 <b>+${info.referrerMonths} 个月</b>，已自动顺延。`,
      "<br>",
      "继续邀请同行，每成功一位双方都有奖励。邀请码在「顶栏头像 → 我的推广」里。",
    ].join("<br>")
  );

  await push(
    invitee,
    "新用户奖励已到账",
    [
      "<b>你的账号已开通，新用户奖励已到账</b>",
      `会员时长 <b>+${info.inviteeMonths} 个月</b>，已自动顺延。`,
      "<br>",
      "你也有自己的邀请码了：顶栏头像 → 我的推广。邀请同行来用，双方都能再加时长。",
    ].join("<br>")
  );
}
