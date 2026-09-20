import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";

const risks = new Hono<{ Bindings: Env }>();

type RiskType = "contract_end" | "probation_end" | "birthday" | "resignation";
type RiskLevel = "red" | "yellow" | "green";

interface RiskItem {
  talent_id: string;
  name: string;
  type: RiskType;
  date: string;       // 事项日期（生日为下一次生日日期）
  days_left: number;  // 负数 = 已逾期
  level: RiskLevel;
}

const DAY_MS = 86400000;

// 以中国时区（UTC+8）为准取「今天」的零点，避免 Worker 运行在 UTC 时
// 本地 00:00–08:00 这段时间把「今天」算成昨天、倒计时整体差一天。
function todayUtc(): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date()); // en-CA 输出 YYYY-MM-DD
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function parseDate(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

// 生日的下一次发生日期（今年没过则今年，否则明年）
function nextBirthday(birth: string, today: Date): Date | null {
  const m = birth.match(/^\d{4}-(\d{2})-(\d{2})/);
  if (!m) return null;
  const month = +m[1] - 1;
  const day = +m[2];
  let b = new Date(Date.UTC(today.getUTCFullYear(), month, day));
  if (b.getTime() < today.getTime()) {
    b = new Date(Date.UTC(today.getUTCFullYear() + 1, month, day));
  }
  return b;
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// 分级规则：返回 null 表示不在预警窗口内
function levelFor(type: RiskType, days: number): RiskLevel | null {
  switch (type) {
    case "contract_end":    // 合同到期：逾期/≤7 红，≤30 黄，≤90 绿
      if (days <= 7) return "red";
      if (days <= 30) return "yellow";
      if (days <= 90) return "green";
      return null;
    case "probation_end":   // 试用期结束：逾期/≤7 红，≤15 黄，≤30 绿
      if (days <= 7) return "red";
      if (days <= 15) return "yellow";
      if (days <= 30) return "green";
      return null;
    case "birthday":        // 生日：当天 红，≤7 黄，≤30 绿
      if (days === 0) return "red";
      if (days <= 7) return "yellow";
      if (days <= 30) return "green";
      return null;
    case "resignation":     // 离职倒计时：逾期/≤7 红，≤15 黄，≤30 绿
      if (days <= 7) return "red";
      if (days <= 15) return "yellow";
      if (days <= 30) return "green";
      return null;
  }
}

// ---- 风险预警列表 ----
risks.get("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  let sql = `SELECT id, name, birth_date, contract_end, probation_end, resignation_date FROM talents
             WHERE (birth_date IS NOT NULL OR contract_end IS NOT NULL OR probation_end IS NOT NULL OR resignation_date IS NOT NULL)`;
  const params: string[] = [];
  if (session.role !== "admin") {
    sql += " AND owner_id = ?";
    params.push(session.userId);
  }
  const rows = await c.env.DB.prepare(sql).bind(...params).all<{
    id: string; name: string;
    birth_date: string | null; contract_end: string | null;
    probation_end: string | null; resignation_date: string | null;
  }>();

  const today = todayUtc();
  const items: RiskItem[] = [];

  for (const r of rows.results) {
    const push = (type: RiskType, date: Date | null) => {
      if (!date) return;
      const days = Math.round((date.getTime() - today.getTime()) / DAY_MS);
      const level = levelFor(type, days);
      if (level) {
        items.push({ talent_id: r.id, name: r.name, type, date: fmt(date), days_left: days, level });
      }
    };
    push("contract_end", r.contract_end ? parseDate(r.contract_end) : null);
    push("probation_end", r.probation_end ? parseDate(r.probation_end) : null);
    push("birthday", r.birth_date ? nextBirthday(r.birth_date, today) : null);
    push("resignation", r.resignation_date ? parseDate(r.resignation_date) : null);
  }

  // 红 → 黄 → 绿，同级按剩余天数升序（逾期排最前）
  const weight: Record<RiskLevel, number> = { red: 0, yellow: 1, green: 2 };
  items.sort((a, b) => weight[a.level] - weight[b.level] || a.days_left - b.days_left);

  const summary = {
    red: items.filter((i) => i.level === "red").length,
    yellow: items.filter((i) => i.level === "yellow").length,
    green: items.filter((i) => i.level === "green").length,
  };
  return c.json({ items, summary });
});

export { risks as riskRoutes };
