// 老带新推广端到端验证（不碰管理员真实数据）
// 流程：造推荐人 A → 用 A 的邀请码注册 B → 审批 B → 给 B 开通 1 个月 → 校验双方各加月份 → 清理测试数据
import { execFileSync } from "node:child_process";

const BASE = "https://hr-work.club";
const ADMIN_TOKEN = process.argv[2];
const A_PHONE = "13800138001";
const B_PHONE = "13800138002";

const d1 = (sql) => {
  const out = execFileSync(
    `npx wrangler d1 execute hr-workbench --remote --json --command "${sql.replace(/"/g, "'")}"`,
    { encoding: "utf8", cwd: "D:\\My\\hr-talent-pool", shell: true, stdio: ["ignore", "pipe", "pipe"] }
  );
  const j = JSON.parse(out);
  return j[0]?.results || [];
};

const api = async (path, options = {}) => {
  const res = await fetch(BASE + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
      ...(ADMIN_TOKEN ? { Authorization: `Bearer ${ADMIN_TOKEN}` } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};

const getCaptcha = async () => {
  const { json } = await api("/api/auth/captcha");
  const chars = [...json.svg.matchAll(/>([^<])<\/text>/g)].map((m) => m[1]);
  return { id: json.captcha_id, code: chars.join("") };
};

const main = async () => {
  // 0. 清理可能残留的测试数据
  d1(`DELETE FROM referrals WHERE invitee_id IN (SELECT id FROM users WHERE phone IN ('${A_PHONE}','${B_PHONE}'))`);
  d1(`DELETE FROM referrals WHERE referrer_id IN (SELECT id FROM users WHERE phone IN ('${A_PHONE}','${B_PHONE}'))`);
  d1(`DELETE FROM users WHERE phone IN ('${A_PHONE}','${B_PHONE}')`);

  // 1. 管理员创建推荐人 A（active + 1 个月会员）
  let r = await api("/api/auth/users", {
    method: "POST",
    body: JSON.stringify({ phone: A_PHONE, name: "推广测试A", password: "test123456" }),
  });
  console.log("1. 创建推荐人 A:", r.status, JSON.stringify(r.json).slice(0, 120));

  let rows = d1(`SELECT id, name, status, paid_until, referral_code FROM users WHERE phone='${A_PHONE}'`);
  const A = rows[0];
  console.log("   A =", JSON.stringify(A));

  // 2. B 带 A 的邀请码自助注册
  const cap = await getCaptcha();
  console.log("2. 验证码:", cap.code);
  r = await api("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      phone: B_PHONE, name: "推广测试B", password: "test123456",
      captcha_id: cap.id, captcha: cap.code, ref: A.referral_code,
    }),
  });
  console.log("   注册结果:", r.status, JSON.stringify(r.json).slice(0, 160));

  rows = d1(`SELECT id, name, status, paid_until, referred_by, referral_code FROM users WHERE phone='${B_PHONE}'`);
  const B = rows[0];
  console.log("   B =", JSON.stringify(B));
  console.log("   归属正确:", B.referred_by === A.id ? "✅" : `❌ (${B.referred_by})`);
  console.log("   B 也有自己的邀请码:", B.referral_code ? `✅ ${B.referral_code}` : "❌");

  const refs = d1(`SELECT id, referrer_id, invitee_id, status FROM referrals WHERE invitee_id='${B.id}'`);
  console.log("   referrals 记录:", JSON.stringify(refs));

  // 3. 审批通过 B
  r = await api(`/api/auth/users/${B.id}/approve`, { method: "PUT", body: JSON.stringify({ role_id: null }) });
  console.log("3. 审批 B:", r.status, JSON.stringify(r.json).slice(0, 120));

  // 4. 管理员给 B 开通 1 个月 → 应触发发奖
  r = await api(`/api/auth/users/${B.id}/membership`, { method: "PUT", body: JSON.stringify({ months: 1 }) });
  console.log("4. 开通 B 会员:", r.status, JSON.stringify(r.json).slice(0, 120));

  const after = d1(`SELECT id, name, status, paid_until FROM users WHERE phone IN ('${A_PHONE}','${B_PHONE}')`);
  const A2 = after.find((u) => u.name === "推广测试A");
  const B2 = after.find((u) => u.name === "推广测试B");
  console.log("5. 发奖后 A:", JSON.stringify(A2));
  console.log("   发奖后 B:", JSON.stringify(B2));

  const ref2 = d1(`SELECT status, rewarded_at, reward_months_referrer, reward_months_invitee, note FROM referrals WHERE invitee_id='${B2.id}'`);
  console.log("   referrals 状态:", JSON.stringify(ref2));

  // 5. 再开通一次（重复付费）→ 不应重复发奖
  r = await api(`/api/auth/users/${B.id}/membership`, { method: "PUT", body: JSON.stringify({ months: 1 }) });
  const ref3 = d1(`SELECT status, reward_months_referrer FROM referrals WHERE invitee_id='${B2.id}'`);
  const A3 = d1(`SELECT paid_until FROM users WHERE id='${A.id}'`)[0];
  console.log("6. 二次开通后 referrals（应保持 rewarded 且不重复加）:", JSON.stringify(ref3));
  console.log("   A 有效期是否重复增加:", A2.paid_until === A3.paid_until ? "✅ 未重复" : `❌ ${A2.paid_until} → ${A3.paid_until}`);

  // 6. 清理
  d1(`DELETE FROM referrals WHERE invitee_id IN (SELECT id FROM users WHERE phone IN ('${A_PHONE}','${B_PHONE}'))`);
  d1(`DELETE FROM referrals WHERE referrer_id IN (SELECT id FROM users WHERE phone IN ('${A_PHONE}','${B_PHONE}'))`);
  d1(`DELETE FROM users WHERE phone IN ('${A_PHONE}','${B_PHONE}')`);
  const left = d1(`SELECT COUNT(*) AS n FROM users WHERE phone IN ('${A_PHONE}','${B_PHONE}')`);
  console.log("7. 清理后残留:", JSON.stringify(left));
};

main().catch((e) => { console.error("ERR", e); process.exit(1); });
