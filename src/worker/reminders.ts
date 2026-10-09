import type { Env } from "./index";
import { escapeHtml } from "../utils/escapeHtml";

// ---- 会员到期自动冻结（read-only）----
// 每日定时执行：把「正常 active、非 admin、且会员有效期已过」的账号置为 frozen。
// frozen 用户仍可登录查看，但后端写操作守卫会拦截任何修改，续费后由管理员开通恢复 active。
// 早期/存量用户在上线时会被回填为长期有效（paid_until 远未来），不会被误冻。
//
// 比较口径：统一用 datetime(paid_until) 归一化（日期-only 串会补成当天 00:00）。
// 同时把 paid_until IS NULL 的 active 账号也判为过期并冻结 —— 防止有人把会员「清空」后
// 白嫖永久全功能（清空逻辑会即时置 frozen，这里作为兜底，NULL 绝不等于「永久有效」）。
export async function freezeExpiredAccounts(env: Env): Promise<{ frozen: number }> {
  const r = await env.DB.prepare(
    "UPDATE users SET status = 'frozen' " +
    "WHERE status = 'active' AND role != 'admin' " +
    "AND (paid_until IS NULL OR datetime(paid_until) < datetime('now'))"
  ).run();
  return { frozen: r.meta?.changes ?? 0 };
}


// 以中国时区（UTC+8）取 ymd，避免 D1 的 date('now') 是 UTC 导致日期差 8 小时
function ymd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// 距今天数：0=今天，1=明天，负数=已逾期
function diffDays(ymdStr: string, today: string): number {
  const [y1, m1, d1] = today.split("-").map(Number);
  const [y2, m2, d2] = ymdStr.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

function dueLabel(ymdStr: string, today: string): string {
  const d = diffDays(ymdStr, today);
  if (d < 0) return `已逾期 ${-d} 天`;
  if (d === 0) return "今天到期";
  if (d === 1) return "明天到期";
  return `${d} 天后到期`;
}

// 面试时间展示：今天/明天带具体时刻，更远的直接给日期
function interviewWhen(scheduledAt: string, today: string): string {
  const date = scheduledAt.slice(0, 10);
  const time = scheduledAt.slice(11, 16);
  const d = diffDays(date, today);
  if (d === 0) return `今天 ${time}`;
  if (d === 1) return `明天 ${time}`;
  if (d < 0) return `已逾期（${date.slice(5)} ${time}）`;
  return `${date.slice(5)} ${time}`;
}

// 推单条消息到 PushPlus（个人微信），返回是否成功。
// 供定时任务逐人推送 + auth 里的「测试推送」接口复用。
export async function sendPushPlus(
  token: string,
  title: string,
  content: string
): Promise<{ ok: boolean; message: string }> {
  let res: Response;
  try {
    res = await fetch("https://www.pushplus.plus/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, title, content, template: "html" }),
    });
  } catch (err) {
    return { ok: false, message: `推送请求异常：${err instanceof Error ? err.message : String(err)}` };
  }
  const result = (await res.json()) as { code?: number; msg?: string };
  const ok = res.ok && result.code === 200;
  return {
    ok,
    message: ok
      ? `推送成功（code ${result.code}）`
      : `推送失败：HTTP ${res.status} ${result.msg || JSON.stringify(result)}`,
  };
}

// ================= 管理员事件推送 =================
// 场景：有人自助注册、提交密码重置申请这类「必须管理员介入」的事件，
//       以前只能等管理员自己登后台看「用户管理」页才知道，
//       现在注册/提交的那一刻就推送过去，把等待时间压到几分钟。

// 以中国时区（UTC+8）格式化当前时间，避免 D1/now 的 UTC 时间看起来差 8 小时
function nowCn(): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());
}

export interface AdminNotifyResult {
  /** 成功推送的人数 */
  pushedTo: number;
  /** 是否走的全局 token（说明没有任何管理员单独配置） */
  viaGlobal: boolean;
  note: string;
}

// 推给所有「管用户」的人：status='active' 且配了 token 的管理员
// （role='admin'，或所在角色的 permissions 含 users 菜单权限）。
// 兜底：一个都没配 token 时退回全局 PUSHPLUS_TOKEN（兼容单人部署）。
export async function notifyAdmins(
  env: Env,
  title: string,
  content: string
): Promise<AdminNotifyResult> {
  const rows = await env.DB.prepare(
    `SELECT u.id, u.name, u.pushplus_token
       FROM users u LEFT JOIN roles r ON u.role_id = r.id
      WHERE u.status = 'active'
        AND u.pushplus_token IS NOT NULL AND u.pushplus_token != ''
        AND (u.role = 'admin' OR r.permissions LIKE '%users%')`
  ).all<{ id: string; name: string; pushplus_token: string }>();

  const admins = (rows.results || []).filter((u) => u.pushplus_token && u.pushplus_token.trim());

  if (admins.length === 0) {
    if (!env.PUSHPLUS_TOKEN) {
      return { pushedTo: 0, viaGlobal: false, note: "无可用推送通道（管理员均未配置 token，且无全局 PUSHPLUS_TOKEN）" };
    }
    const res = await sendPushPlus(env.PUSHPLUS_TOKEN, title, content);
    return { pushedTo: res.ok ? 1 : 0, viaGlobal: true, note: res.message };
  }

  let pushedTo = 0;
  const failures: string[] = [];
  for (const u of admins) {
    const res = await sendPushPlus(u.pushplus_token, title, content);
    if (res.ok) pushedTo++;
    else failures.push(`${u.name}：${res.message}`);
  }
  return {
    pushedTo,
    viaGlobal: false,
    note: pushedTo > 0
      ? `已推送给 ${pushedTo} 位管理员` + (failures.length > 0 ? `，${failures.length} 人失败` : "")
      : `推送失败：${failures.join("；")}`,
  };
}

// 事件①：有人提交注册申请 → 催管理员去审批
export async function notifyNewRegistration(
  env: Env,
  info: { name: string; phone: string; referrerName?: string; intendedRole?: string }
): Promise<AdminNotifyResult> {
  // 身份只作提示，帮助管理员判断该给什么角色；取值非法/缺失时不显示该行
  const INTENDED_LABELS: Record<string, string> = {
    hr: "HR 人事",
    headhunter: "猎头",
    team: "团队负责人",
    other: "其他",
  };
  const intended = info.intendedRole ? INTENDED_LABELS[info.intendedRole] : "";
  const lines = [
    "<b>有人提交了注册申请，正等待审批</b>",
    `姓名：${escapeHtml(info.name)}`,
    `手机号：${escapeHtml(info.phone)}`,
    ...(intended ? [`自报身份：${intended}（仅供参考，权限仍需你确认角色）`] : []),
    ...(info.referrerName
      ? [`推荐人：${escapeHtml(info.referrerName)}（该用户付费开通后，双方会员时长会自动顺延）`]
      : []),
    `提交时间：${nowCn()}`,
    "<br>",
    "处理入口：登录后台 → 用户管理 →「待审批注册申请」→ 通过（顺手把角色分配了）。",
    "在审批通过前，这个账号无法登录。",
  ];
  return notifyAdmins(env, "新用户注册待审批", lines.join("<br>"));
}

/**
 * 事件①b：审批通过后提醒管理员「去通知用户」。
 *
 * 为什么是提醒管理员而不是直接通知用户：注册表单只收手机号，
 * 平台没有短信资质、用户也没配 PushPlus token，所以不存在能直达用户的通道。
 * 唯一现实的做法是把「该联系用户了」这件事推给站长，并附上手机号，方便他
 * 从闲鱼/微信里找到人。这也是当前用户注册后不回来的最大断点。
 */
export async function notifyUserApproved(
  env: Env,
  info: { name: string; phone: string; roleName?: string | null }
): Promise<AdminNotifyResult> {
  const lines = [
    "<b>已给一位新用户开通，记得告诉他可以登录了</b>",
    `姓名：${escapeHtml(info.name)}`,
    `手机号：${escapeHtml(info.phone)}`,
    ...(info.roleName ? [`角色：${escapeHtml(info.roleName)}`] : []),
    `开通时间：${nowCn()}`,
    "<br>",
    "⚠️ 系统无法主动通知他（只有手机号，无短信通道），需要你从闲鱼/微信里跟他说一声。",
    "否则他不知道自己已经通过了，很可能就一直不回来。",
  ];
  return notifyAdmins(env, "新用户已开通，请通知他登录", lines.join("<br>"));
}

// 事件②：有人提交「忘记密码」申请 → 催管理员去核对身份
// 同一个账号 30 分钟内只推一次：避免被反复提交刷屏。
export async function notifyPasswordResetRequest(
  env: Env,
  info: { name: string; phone: string; userId: string }
): Promise<AdminNotifyResult> {
  const dedupeKey = `pwdreq:${info.userId}`;
  const recent = await env.SESSIONS.get(dedupeKey);
  if (recent) return { pushedTo: 0, viaGlobal: false, note: "30 分钟内已推送过，本次跳过" };
  await env.SESSIONS.put(dedupeKey, "1", { expirationTtl: 1800 });

  const lines = [
    "<b>有人提交了密码重置申请</b>",
    `姓名：${escapeHtml(info.name)}`,
    `手机号：${escapeHtml(info.phone)}`,
    `提交时间：${nowCn()}`,
    "<br>",
    "系统没有短信/邮件通道，无法自助重置。请先线下确认是本人，",
    "再到「用户管理」→「密码重置申请」给他设置一个临时密码（对方登录后会被要求修改）。",
  ];
  return notifyAdmins(env, "密码重置申请待处理", lines.join("<br>"));
}

// 事件③：用户扫码付款后申请开通会员 → 催管理员去确认收款并开通
// 同一个账号 30 分钟内只推一次：避免被反复点击刷屏。
// 该接口放行于冻结写守卫（路径 /api/auth/me/*），所以冻结用户也能发起申请。
export async function notifyMembershipRequest(
  env: Env,
  info: { name: string; phone: string }
): Promise<AdminNotifyResult> {
  const lines = [
    "<b>有用户付款后申请开通会员</b>",
    `姓名：${escapeHtml(info.name)}`,
    `手机号：${escapeHtml(info.phone)}`,
    `提交时间：${nowCn()}`,
    "<br>",
    "请确认是否收到款项，再到「用户管理」→ 该用户「开通 / 续期」即可恢复其全功能。",
  ];
  return notifyAdmins(env, "会员开通申请待处理", lines.join("<br>"));
}

export interface ReminderResult {
  sent: boolean;
  taskCount: number;
  contractCount: number;
  probationCount: number;
  /** 未来 3 天内的面试安排条数 */
  interviewCount: number;
  /** 成功推送给几个人 */
  pushedTo: number;
  /** 因负责人未配置 token 而没能推送的待办条数 */
  skippedNoToken: number;
  message: string;
}

// 汇总未来 N 天内到期的「待办 + 合同 + 试用期」，按人定向推送到各自的 PushPlus。
// 归属规则：
//   - 待办（talent_tasks.owner_id）→ 推给负责人自己
//   - 合同/试用期到期（公司级）→ 推给所有 status='active' 且配了 token 的用户
// 每个用户一条消息：自己的待办（若有）+ 全员合同/试用期（若有）。
export async function runReminders(env: Env): Promise<ReminderResult> {
  const today = ymd(new Date());
  const soon = ymd(new Date(Date.now() + 3 * 86400000));

  // 待办（含负责人姓名与 token）
  const taskRows = await env.DB.prepare(
    `SELECT t.title, t.due_date, t.owner_id, u.name AS owner_name, u.pushplus_token
     FROM talent_tasks t
     LEFT JOIN users u ON t.owner_id = u.id
     WHERE t.status = 'pending' AND t.due_date IS NOT NULL
       AND t.due_date >= ? AND t.due_date <= ?
     ORDER BY t.due_date ASC`
  )
    .bind(today, soon)
    .all<{ title: string; due_date: string; owner_id: string; owner_name: string | null; pushplus_token: string | null }>();

  const contractRows = await env.DB.prepare(
    `SELECT name, contract_end
     FROM talents
     WHERE contract_end IS NOT NULL
       AND contract_end >= ? AND contract_end <= ?
     ORDER BY contract_end ASC`
  )
    .bind(today, soon)
    .all<{ name: string; contract_end: string }>();

  const probationRows = await env.DB.prepare(
    `SELECT name, probation_end
     FROM talents
     WHERE probation_end IS NOT NULL
       AND probation_end >= ? AND probation_end <= ?
     ORDER BY probation_end ASC`
  )
    .bind(today, soon)
    .all<{ name: string; probation_end: string }>();

  // 面试安排：未来 3 天内的「待面试」，按负责人定向推送（scheduled_at 是 'YYYY-MM-DD HH:mm' 本地时区串）
  const interviewRows = await env.DB.prepare(
    `SELECT iv.scheduled_at, iv.round, iv.mode, iv.location, iv.meeting_url,
            t.name AS talent_name, j.title AS job_title,
            iv.owner_id, u.name AS owner_name, u.pushplus_token
     FROM interviews iv
     JOIN talents t ON iv.talent_id = t.id
     LEFT JOIN jobs j ON iv.job_id = j.id
     LEFT JOIN users u ON iv.owner_id = u.id
     WHERE iv.status = 'scheduled' AND iv.scheduled_at IS NOT NULL
       AND substr(iv.scheduled_at, 1, 10) >= ? AND substr(iv.scheduled_at, 1, 10) <= ?
     ORDER BY iv.scheduled_at ASC`
  )
    .bind(today, soon)
    .all<{
      scheduled_at: string; round: string; mode: string;
      location: string | null; meeting_url: string | null;
      talent_name: string; job_title: string | null;
      owner_id: string; owner_name: string | null; pushplus_token: string | null;
    }>();

  const tasks = taskRows.results || [];
  const contracts = contractRows.results || [];
  const probations = probationRows.results || [];
  const interviews = interviewRows.results || [];

  if (tasks.length === 0 && contracts.length === 0 && probations.length === 0 && interviews.length === 0) {
    return {
      sent: false,
      taskCount: 0,
      contractCount: 0,
      probationCount: 0,
      interviewCount: 0,
      pushedTo: 0,
      skippedNoToken: 0,
      message: "无未来 3 天内到期的提醒",
    };
  }

  // 合同/试用期是「公司级」内容，所有配了 token 的用户都收这一段
  const globalLines: string[] = [];
  if (contracts.length > 0) {
    globalLines.push(`<b>合同到期（${contracts.length} 人）</b>`);
    for (const c of contracts) globalLines.push(`&nbsp;&nbsp;· ${c.name} — ${dueLabel(c.contract_end, today)}`);
  }
  if (probations.length > 0) {
    globalLines.push(`<b>试用期到期（${probations.length} 人）</b>`);
    for (const p of probations) globalLines.push(`&nbsp;&nbsp;· ${p.name} — ${dueLabel(p.probation_end, today)}`);
  }
  const globalHtml = globalLines.join("<br>");

  // 待办按负责人分组
  const tasksByOwner = new Map<string, { owner_name: string | null; items: { title: string; due_date: string }[] }>();
  for (const t of tasks) {
    if (!tasksByOwner.has(t.owner_id)) tasksByOwner.set(t.owner_id, { owner_name: t.owner_name, items: [] });
    tasksByOwner.get(t.owner_id)!.items.push({ title: t.title, due_date: t.due_date });
  }

  // 面试按负责人分组（面试是「负责人自己的事」，不进公司级全局段）
  const ROUND_CN: Record<string, string> = { interview1: "初试", interview2: "复试", final: "终面" };
  const interviewsByOwner = new Map<string, string[]>();
  for (const iv of interviews) {
    const place = iv.mode === "online"
      ? (iv.meeting_url ? escapeHtml(iv.meeting_url) : "线上")
      : iv.mode === "onsite"
        ? (iv.location ? escapeHtml(iv.location) : "线下")
        : "电话";
    const line = `${escapeHtml(iv.talent_name)}${iv.job_title ? `（${escapeHtml(iv.job_title)}）` : ""}` +
      ` · ${ROUND_CN[iv.round] || iv.round} · ${interviewWhen(iv.scheduled_at, today)} · ${place}`;
    if (!interviewsByOwner.has(iv.owner_id)) interviewsByOwner.set(iv.owner_id, []);
    interviewsByOwner.get(iv.owner_id)!.push(line);
  }

  // 所有 active 且配了 token 的用户（这些是「可接收」的人）
  const activeUsers = await env.DB.prepare(
    `SELECT id, name, pushplus_token FROM users
     WHERE status = 'active' AND pushplus_token IS NOT NULL AND pushplus_token != ''`
  ).all<{ id: string; name: string; pushplus_token: string }>();
  const users = activeUsers.results || [];

  // 以 userId 为 key 聚合每个人的消息
  const recipientMap = new Map<string, { name: string; token: string; lines: string[] }>();
  const ensure = (id: string, name: string, token: string) => {
    if (!recipientMap.has(id)) recipientMap.set(id, { name, token, lines: [] });
    return recipientMap.get(id)!;
  };

  // ① 全员收「合同/试用期」全局内容
  for (const u of users) {
    const r = ensure(u.id, u.name, u.pushplus_token);
    if (globalHtml) r.lines.push(globalHtml);
  }

  // ② 负责人收自己的「待办」
  let skippedNoToken = 0;
  for (const [ownerId, grp] of tasksByOwner) {
    const u = users.find((x) => x.id === ownerId);
    if (!u) {
      // 负责人没配 token → 这条待办无人接收，计入跳过
      skippedNoToken += grp.items.length;
      continue;
    }
    const r = ensure(ownerId, u.name, u.pushplus_token);
    const taskLines = [`<b>待办提醒（${grp.items.length} 条）</b>`];
    for (const it of grp.items) taskLines.push(`&nbsp;&nbsp;· ${it.title} — ${dueLabel(it.due_date, today)}`);
    r.lines = [...taskLines, ...r.lines];
  }

  // ③ 负责人收自己的「面试安排」（最紧急的放最前面，今天/明天的面试最容易被漏掉）
  for (const [ownerId, items] of interviewsByOwner) {
    const u = users.find((x) => x.id === ownerId);
    if (!u) continue; // 负责人没配 token：面试是个人事项，静默跳过
    const r = ensure(ownerId, u.name, u.pushplus_token);
    const ivLines = [`<b>面试安排（${items.length} 场）</b>`];
    for (const it of items) ivLines.push(`&nbsp;&nbsp;· ${it}`);
    r.lines = [...ivLines, ...r.lines];
  }

  // 兜底：如果没有任何用户配置 token，但存在全局 PUSHPLUS_TOKEN，则整体推给全局（兼容旧行为）
  if (recipientMap.size === 0 && env.PUSHPLUS_TOKEN) {
    const allLines: string[] = [];
    for (const [ownerId, grp] of tasksByOwner) {
      allLines.push(`<b>待办提醒（${grp.items.length} 条${grp.owner_name ? `，负责人 ${grp.owner_name}` : ""}）</b>`);
      for (const it of grp.items) allLines.push(`&nbsp;&nbsp;· ${it.title} — ${dueLabel(it.due_date, today)}`);
    }
    for (const [, items] of interviewsByOwner) {
      allLines.push(`<b>面试安排（${items.length} 场）</b>`);
      for (const it of items) allLines.push(`&nbsp;&nbsp;· ${it}`);
    }
    if (globalHtml) allLines.push(globalHtml);
    const res = await sendPushPlus(env.PUSHPLUS_TOKEN, "待办到期提醒", allLines.join("<br>"));
    return {
      sent: res.ok,
      taskCount: tasks.length,
      contractCount: contracts.length,
      probationCount: probations.length,
      interviewCount: interviews.length,
      pushedTo: res.ok ? 1 : 0,
      skippedNoToken: 0,
      message: res.ok ? "已通过全局 token 推送（当前无用户单独配置 token）" : res.message,
    };
  }

  // 逐人推送
  let pushedTo = 0;
  const failures: string[] = [];
  for (const [, r] of recipientMap) {
    if (r.lines.length === 0) continue;
    const res = await sendPushPlus(r.token, "待办到期提醒", r.lines.join("<br>"));
    if (res.ok) pushedTo++;
    else failures.push(`${r.name}：${res.message}`);
  }

  return {
    sent: pushedTo > 0,
    taskCount: tasks.length,
    contractCount: contracts.length,
    probationCount: probations.length,
    interviewCount: interviews.length,
    pushedTo,
    skippedNoToken,
    message: pushedTo > 0
      ? `已推送给 ${pushedTo} 人` +
        (skippedNoToken > 0 ? `，${skippedNoToken} 条待办因负责人未配置 token 未推送` : "") +
        (failures.length > 0 ? `；${failures.length} 人推送失败` : "")
      : failures.length > 0
        ? `推送失败：${failures.join("；")}`
        : "无已配置推送 token 的用户",
  };
}
