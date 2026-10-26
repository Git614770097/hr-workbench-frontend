import { PALETTE } from "../../types";
import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { ownerScope } from "../scope";
import { cachedJson } from "../helpers";

const overview = new Hono<{ Bindings: Env }>();

// 终态：不再计入「进行中」候选人数
const TERMINAL = ["hired", "rejected", "withdrawn"] as const;

const DAY_MS = 86400000;
const CN_SHIFT = 8 * 3600 * 1000; // 中国时区（UTC+8）偏移

/** 中国时区（UTC+8）本周一 00:00，返回 ISO（UTC 字符串）供 D1 比较。
 *  D1 存的是 UTC，按「本周」统计必须显式对齐中国时区的周一开头，否则凌晨会跨天错位。 */
function chinaWeekStartUtc(): string {
  // 先把当前 UTC 时刻换算成中国本地日历来算「周几」
  const cn = new Date(Date.now() + CN_SHIFT);
  const dow = cn.getUTCDay(); // 0=周日 … 6=周六
  const daysFromMonday = (dow + 6) % 7; // 距本周一的天数
  cn.setUTCHours(0, 0, 0, 0);
  cn.setUTCDate(cn.getUTCDate() - daysFromMonday);
  // 此时 cn 是中国周一 00:00，换算回 UTC 时刻
  return new Date(cn.getTime() - CN_SHIFT).toISOString();
}

/** 中国时区当天日期 YYYY-MM-DD（用于待办逾期/今日判定）。 */
function todayCn(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/** 在 YYYY-MM-DD 上加减天数（按 UTC 日历，纯日期运算，无时区歧义）。 */
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** ms → D1 的 datetime 字符串（"YYYY-MM-DD HH:MM:SS"，UTC，与 datetime('now') 同格式，
 *  保证与库内字符串可直接做字典序比较；不能用 ISO 的 "T" 格式，否则同一天内排序错乱）。 */
function sqlFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** 解析 D1 时间串（"YYYY-MM-DD HH:MM:SS" 或 ISO）→ 毫秒 */
function parseSqlTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = new Date(s.includes("T") || s.includes("Z") ? s : s.replace(" ", "T") + "Z").getTime();
  return Number.isNaN(t) ? null : t;
}

// 中国时区下的「天数序号」：把 UTC 毫秒整体 +8h 后按天取整。
// 1970-01-01（序号 0）在中国是周四 → 用于周一对齐：daysFromMonday = (di + 10) % 7
function cnDayIndex(ms: number): number {
  return Math.floor((ms + CN_SHIFT) / DAY_MS);
}
function weekStartDayIndex(di: number): number {
  return di - ((di + 10) % 7);
}
/** 天数序号 → "M/D" 标签（该序号对应的中国日历日期） */
function dayLabel(di: number): string {
  const d = new Date(di * DAY_MS);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

// GET /api/overview —— 工作台首屏聚合数据（全员可看，按 owner 隔离；admin 看全部）
// 只做只读聚合，不新增菜单权限 key，前端首页所有登录用户可见。
// Edge Cache：30s TTL，按 role+uid 隔离，降低 D1 冷启动对首屏的影响。
overview.get("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const isAdmin = session.role === "admin";
  const uid = session.userId;
  // 缓存 key 按数据范围隔离：admin 看全部；同队成员看同一份团队数据，共用缓存
  const scopeKey = isAdmin ? "admin" : session.teamId ? `team:${session.teamId}` : `user:${uid}`;
  const cacheKey = `https://edge-cache.internal/api/overview?scope=${scopeKey}`;

  return cachedJson(c.executionCtx, cacheKey, 30, async () => {
    const db = c.env.DB;
    // 注意：owner 条件统一以「 AND owner_id = ?」形式拼在已有 WHERE 之后。
    // 不能用 `FROM jobs${ownerWhere} AND ...` 的写法 —— admin 时 ownerWhere 为空，
    // 会拼出 `FROM jobs AND status='open'` 这种缺 WHERE 的非法 SQL 直接 500。
    const sc = ownerScope(session);
    const ownerAnd = sc.sql;
    const ownerBind: string[] = sc.params;
    // 带表别名的同范围条件（JOIN 到 jobs/interviews/tasks 时列名不同，范围语义一致）
    const scJ = ownerScope(session, "j.owner_id");
    const scIv = ownerScope(session, "iv.owner_id");
    const scTk = ownerScope(session, "tk.owner_id");

    const weekStart = chinaWeekStartUtc();
    const today = todayCn();
    const dueSoonTo = addDays(today, 3); // 近 3 天到期（含今日）
    // 上周周一 00:00（UTC），用于环比「上周新增」
    const prevWeekStart = new Date(new Date(weekStart).getTime() - 7 * DAY_MS).toISOString();
    // 上周同日（今天 -7 天），用于环比「今日面试」
    const prevWeekday = addDays(today, -7);

    // 带表别名的同范围条件：JOIN 到 talent_jobs / interviews / talent_tasks 时
    // 列名不同但范围语义一致；params 与 ownerBind 相同，故 bind 时可复用 ownerBind。
    const scTJ = ownerScope(session, "t.owner_id");
    const ivOwnerAnd = scIv.sql;
    const taskOwnerAnd = scTk.sql;

    // ⚠️ 性能（2026-10-22 修）：下面 12 条查询原本逐条 `await` 串行执行，每条一次 D1
    // 网络往返，实测累加 18~27 秒 —— 这就是「进系统一直转圈」的根因。
    // 它们之间没有任何依赖（bind 参数全部在提交前算好），故改用 db.batch 一次往返提交，
    // 耗时从「N × 往返」降为「1 × 往返」。序号与下方取值一一对应，改动时别错位。
    //
    // owner 条件统一以「 AND owner_id = ?」形式拼在已有 WHERE 之后。
    // 不能用 `FROM jobs${ownerWhere} AND ...` 的写法 —— admin 时 ownerWhere 为空，
    // 会拼出 `FROM jobs AND status='open'` 这种缺 WHERE 的非法 SQL 直接 500。
    // ⚠️ talent_jobs 没有 owner_id 列——范围必须经 JOIN talents 用 t.owner_id 判定（2 号）。
    const R = await db.batch<Record<string, unknown>>([
      // 0 在招职位数
      db.prepare(`SELECT COUNT(*) c FROM jobs WHERE status = 'open'${ownerAnd}`).bind(...ownerBind),
      // 1 人才库总数
      db.prepare(`SELECT COUNT(*) c FROM talents WHERE 1=1${ownerAnd}`).bind(...ownerBind),
      // 2 当前各阶段人数（talent_jobs 当前停留阶段）
      db.prepare(
        `SELECT j.stage AS stage, COUNT(*) c
         FROM talent_jobs j JOIN talents t ON t.id = j.talent_id
         WHERE 1=1${scTJ.sql} GROUP BY j.stage`
      ).bind(...scTJ.params),
      // 3 本周新增人才
      db.prepare(`SELECT COUNT(*) c FROM talents WHERE created_at >= ?${sc.sql}`).bind(weekStart, ...ownerBind),
      // 4 上周新增人才（环比用）
      db.prepare(`SELECT COUNT(*) c FROM talents WHERE created_at >= ? AND created_at < ?${sc.sql}`).bind(prevWeekStart, weekStart, ...ownerBind),
      // 5 本周各阶段「到达」人次（job_stage_logs 的 to_stage，按 owner 隔离）
      db.prepare(
        `SELECT l.to_stage AS stage, COUNT(*) c
         FROM job_stage_logs l
         JOIN talent_jobs j ON j.id = l.talent_job_id
         WHERE l.created_at >= ?${scJ.sql}
         GROUP BY l.to_stage`
      ).bind(weekStart, ...ownerBind),
      // 6 待办汇总：pending 总数 / 逾期 / 今日到期
      db.prepare(
        `SELECT COUNT(*) total,
                SUM(CASE WHEN due_date < ? THEN 1 ELSE 0 END) overdue,
                SUM(CASE WHEN due_date = ? THEN 1 ELSE 0 END) today
         FROM talent_tasks WHERE status = 'pending'${sc.sql}`
      ).bind(today, today, ...ownerBind),
      // 7 今日面试场次
      // ⚠️ 口径陷阱（2026-10-22 修）：曾用 status='scheduled' 统计，导致「上周同日」
      // 那批面试早已填完结果变成 done，prev 恒为 0 → 环比永远显示「新增」。
      // 今日与上周同日必须同口径：都统计「非取消」场次（含已完成），才可比。
      db.prepare(
        `SELECT COUNT(*) c FROM interviews iv
         WHERE iv.status <> 'cancelled' AND substr(iv.scheduled_at, 1, 10) = ?${ivOwnerAnd}`
      ).bind(today, ...ownerBind),
      // 8 上周同日面试场次（环比用，口径同 7）
      db.prepare(
        `SELECT COUNT(*) c FROM interviews iv
         WHERE iv.status <> 'cancelled' AND substr(iv.scheduled_at, 1, 10) = ?${ivOwnerAnd}`
      ).bind(prevWeekday, ...ownerBind),
      // 9 今日面试列表（与 7 同口径，否则会出现「KPI 3 场、列表 1 条」的对不上）
      db.prepare(
        `SELECT iv.id, iv.talent_id, iv.job_id, iv.scheduled_at, iv.round, iv.mode,
                iv.location, iv.meeting_url, iv.interviewer, iv.status,
                t.name AS talent_name, j.title AS job_title
         FROM interviews iv
         JOIN talents t ON iv.talent_id = t.id
         LEFT JOIN jobs j ON iv.job_id = j.id
         WHERE iv.status <> 'cancelled' AND substr(iv.scheduled_at, 1, 10) = ?${ivOwnerAnd}
         ORDER BY iv.scheduled_at ASC LIMIT 20`
      ).bind(today, ...ownerBind),
      // 10 近 3 天到期待办列表（含今日）
      db.prepare(
        `SELECT tk.id, tk.title, tk.due_date, tk.source, tk.talent_id, tk.job_id,
                t.name AS talent_name
         FROM talent_tasks tk
         LEFT JOIN talents t ON tk.talent_id = t.id
         WHERE tk.status = 'pending' AND tk.due_date IS NOT NULL
           AND tk.due_date >= ? AND tk.due_date <= ?${taskOwnerAnd}
         ORDER BY tk.due_date ASC LIMIT 20`
      ).bind(today, dueSoonTo, ...ownerBind),
      // 11 近 3 天到期待办「总数」：10 号有 LIMIT 20，前端若拿列表长度当 KPI，
      //    团队/管理员看全部数据时超过 20 条就会被截断成 20。故单独 COUNT 一次。
      db.prepare(
        `SELECT COUNT(*) c FROM talent_tasks tk
         WHERE tk.status = 'pending' AND tk.due_date IS NOT NULL
           AND tk.due_date >= ? AND tk.due_date <= ?${taskOwnerAnd}`
      ).bind(today, dueSoonTo, ...ownerBind),
    ]);

    /** 取第 i 条语句的首行（对应原来的 .first()） */
    const first = <T,>(i: number): T | null =>
      (R[i]?.results?.[0] as unknown as T | undefined) ?? null;
    /** 取第 i 条语句的全部行（对应原来的 .all().results） */
    const all = <T,>(i: number): T[] => (R[i]?.results ?? []) as unknown as T[];
    const cnt = (i: number) => Number(first<{ c: number }>(i)?.c ?? 0) || 0;

    type IvRow = {
      id: string; talent_id: string; job_id: string | null; scheduled_at: string | null;
      round: string; mode: string; location: string | null; meeting_url: string | null;
      interviewer: string | null; status: string; talent_name: string; job_title: string | null;
    };
    type DueRow = {
      id: string; title: string; due_date: string; source: string;
      talent_id: string | null; job_id: string | null; talent_name: string | null;
    };

    const openJobs = cnt(0);
    const totalTalents = cnt(1);

    const stageCounts: Record<string, number> = {};
    let activeCandidates = 0;
    for (const r of all<{ stage: string; c: number }>(2)) {
      stageCounts[r.stage] = r.c;
      if (!(TERMINAL as readonly string[]).includes(r.stage)) activeCandidates += r.c;
    }

    const weeklyNewTalents = cnt(3);
    const prevWeekNewTalents = cnt(4);

    const weeklyStageReached: Record<string, number> = {};
    for (const r of all<{ stage: string; c: number }>(5)) weeklyStageReached[r.stage] = r.c;

    const taskRow = first<{ total: number | null; overdue: number | null; today: number | null }>(6);
    const todayInterviewCount = cnt(7);
    const prevWeekdayInterviewCount = cnt(8);
    const ivRows = { results: all<IvRow>(9) };
    const dueRows = { results: all<DueRow>(10) };
    const dueSoonCount = cnt(11);

    return {
      openJobs,
      totalTalents,
      activeCandidates,
      stageCounts,
      weeklyNewTalents,
      /** 上周新增人才（环比基准） */
      prevWeekNewTalents,
      weeklyStageReached,
      tasks: {
        pending: taskRow?.total ?? 0,
        overdue: taskRow?.overdue ?? 0,
        today: taskRow?.today ?? 0,
      },
      /** 今日面试数（用于 KPI 快照） */
      todayInterviewCount,
      /** 上周同日面试数（环比基准） */
      prevWeekdayInterviewCount,
      /** 今日面试列表（最多 20 条） */
      todayInterviews: ivRows.results || [],
      /** 近 3 天到期待办（含今日，最多 20 条） */
      dueSoonTasks: dueRows.results || [],
      /** 近 3 天到期待办总数（不受上面 LIMIT 20 影响，KPI 用它展示） */
      dueSoonCount,
    };
  });
});

// GET /api/overview/trend?range=4w|12w|24w
// 工作台「趋势折线」：新增人才 / 进入面试 / 入职 的时间序列。
// ⚠️ 口径与漏斗不同，别看成一回事（2026-10-22 注明）：
//   本接口统计的是「日志条数」= 人次 —— 同一人才投两个岗位、或同一个岗位被拖回再推进，
//   都会重复计数；而漏斗统计的是「去重人数」（同一人·岗位只算一次）。
//   所以趋势某几周之和 ≥ 漏斗同期人数，这不是 bug，但前端文案必须写清「人次」。
// 分桶在中国时区（周一对齐）；最后一个桶是「本周至今」，天然比整周矮，看图时别当断崖。
// 统一用周粒度，三档窗口长度对称（4周看节奏 / 12周看季度 / 24周看半年）。
overview.get("/trend", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const isAdmin = session.role === "admin";
  const uid = session.userId;
  const range = c.req.query("range") || "12w";
  const COUNT_MAP: Record<string, number> = { "4w": 4, "12w": 12, "24w": 24 };
  const count = COUNT_MAP[range] ?? 12;

  const scopeKey = isAdmin ? "admin" : session.teamId ? `team:${session.teamId}` : `user:${uid}`;
  const cacheKey = `https://edge-cache.internal/api/overview/trend?range=${range}&scope=${scopeKey}`;

  return cachedJson(c.executionCtx, cacheKey, 60, async () => {
    const db = c.env.DB;
    const sc = ownerScope(session);
    const scJ = ownerScope(session, "j.owner_id");
    const ownerBind: string[] = sc.params;

    const step = 7; // 统一周粒度
    const todayDi = cnDayIndex(Date.now());
    const lastStart = weekStartDayIndex(todayDi);
    const startDi = lastStart - (count - 1) * step;

    const labels = Array.from({ length: count }, (_, i) => dayLabel(startDi + i * step));
    const from = sqlFromMs(startDi * DAY_MS - CN_SHIFT);

    const bucketOf = (ms: number): number => {
      const di = cnDayIndex(ms);
      return (weekStartDayIndex(di) - startDi) / 7;
    };

    const newTalents = new Array(count).fill(0);
    const interviews = new Array(count).fill(0);
    const hired = new Array(count).fill(0);

    const newRows = await db
      .prepare(`SELECT created_at AS t FROM talents WHERE created_at >= ?${sc.sql}`)
      .bind(from, ...ownerBind)
      .all<{ t: string }>();
    for (const r of newRows.results || []) {
      const ms = parseSqlTime(r.t);
      if (ms == null) continue;
      const i = bucketOf(ms);
      if (i >= 0 && i < count) newTalents[i]++;
    }

    const logRows = await db
      .prepare(
        `SELECT l.to_stage AS st, l.created_at AS t
         FROM job_stage_logs l
         JOIN talent_jobs j ON j.id = l.talent_job_id
         WHERE l.to_stage IN ('interview1', 'hired') AND l.created_at >= ?${scJ.sql}`
      )
      .bind(from, ...ownerBind)
      .all<{ st: string; t: string }>();
    for (const r of logRows.results || []) {
      const ms = parseSqlTime(r.t);
      if (ms == null) continue;
      const i = bucketOf(ms);
      if (i < 0 || i >= count) continue;
      if (r.st === "interview1") interviews[i]++;
      else if (r.st === "hired") hired[i]++;
    }

    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

    return {
      granularity: "week" as const,
      range,
      labels,
      series: [
        { key: "new_talents", label: "新增人才", color: PALETTE.blue, data: newTalents },
        { key: "interview", label: "进入面试", color: "#8b5cf6", data: interviews },
        { key: "hired", label: "入职", color: "#10b981", data: hired },
      ],
      total: {
        new_talents: sum(newTalents),
        interview: sum(interviews),
        hired: sum(hired),
      },
      /** 窗口起点（中国时区日期，含） */
      from_date: new Date(startDi * DAY_MS).toISOString().slice(0, 10),
    };
  });
});


export { overview };
