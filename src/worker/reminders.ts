import type { Env } from "./index";

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

export interface ReminderResult {
  sent: boolean;
  taskCount: number;
  contractCount: number;
  probationCount: number;
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

  const tasks = taskRows.results || [];
  const contracts = contractRows.results || [];
  const probations = probationRows.results || [];

  if (tasks.length === 0 && contracts.length === 0 && probations.length === 0) {
    return {
      sent: false,
      taskCount: 0,
      contractCount: 0,
      probationCount: 0,
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

  // 兜底：如果没有任何用户配置 token，但存在全局 PUSHPLUS_TOKEN，则整体推给全局（兼容旧行为）
  if (recipientMap.size === 0 && env.PUSHPLUS_TOKEN) {
    const allLines: string[] = [];
    for (const [ownerId, grp] of tasksByOwner) {
      allLines.push(`<b>待办提醒（${grp.items.length} 条${grp.owner_name ? `，负责人 ${grp.owner_name}` : ""}）</b>`);
      for (const it of grp.items) allLines.push(`&nbsp;&nbsp;· ${it.title} — ${dueLabel(it.due_date, today)}`);
    }
    if (globalHtml) allLines.push(globalHtml);
    const res = await sendPushPlus(env.PUSHPLUS_TOKEN, "待办到期提醒", allLines.join("<br>"));
    return {
      sent: res.ok,
      taskCount: tasks.length,
      contractCount: contracts.length,
      probationCount: probations.length,
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
