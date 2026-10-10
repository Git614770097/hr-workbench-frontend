import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { cachedJson } from "../helpers";

const overview = new Hono<{ Bindings: Env }>();

// 终态：不再计入「进行中」候选人数
const TERMINAL = ["hired", "rejected", "withdrawn"] as const;

/** 中国时区（UTC+8）本周一 00:00，返回 ISO（UTC 字符串）供 D1 比较。
 *  D1 存的是 UTC，按「本周」统计必须显式对齐中国时区的周一开头，否则凌晨会跨天错位。 */
function chinaWeekStartUtc(): string {
  // 先把当前 UTC 时刻换算成中国本地日历来算「周几」
  const cn = new Date(Date.now() + 8 * 3600 * 1000);
  const dow = cn.getUTCDay(); // 0=周日 … 6=周六
  const daysFromMonday = (dow + 6) % 7; // 距本周一的天数
  cn.setUTCHours(0, 0, 0, 0);
  cn.setUTCDate(cn.getUTCDate() - daysFromMonday);
  // 此时 cn 是中国周一 00:00，换算回 UTC 时刻
  return new Date(cn.getTime() - 8 * 3600 * 1000).toISOString();
}

/** 中国时区当天日期 YYYY-MM-DD（用于待办逾期/今日判定）。 */
function todayCn(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

// GET /api/overview —— 招聘概览首页聚合数据（全员可看，按 owner 隔离；admin 看全部）
// 只做只读聚合，不新增菜单权限 key，前端首页所有登录用户可见。
// Edge Cache：30s TTL，按 role+uid 隔离，降低 D1 冷启动对首屏的影响。
overview.get("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const isAdmin = session.role === "admin";
  const uid = session.userId;
  // 缓存 key 按用户隔离：admin 看全部、普通用户只看自己的，不能共用缓存
  const cacheKey = `https://edge-cache.internal/api/overview?role=${isAdmin ? "admin" : "user"}&uid=${uid}`;

  return cachedJson(c.executionCtx, cacheKey, 30, async () => {
    const db = c.env.DB;
    // 注意：owner 条件统一以「 AND owner_id = ?」形式拼在已有 WHERE 之后。
    // 不能用 `FROM jobs${ownerWhere} AND ...` 的写法 —— admin 时 ownerWhere 为空，
    // 会拼出 `FROM jobs AND status='open'` 这种缺 WHERE 的非法 SQL 直接 500。
    const ownerAnd = isAdmin ? "" : " AND owner_id = ?";
    const ownerBind: string[] = isAdmin ? [] : [uid];

    const weekStart = chinaWeekStartUtc();
    const today = todayCn();

    // 在招职位数
    const openJobsRow = await db
      .prepare(`SELECT COUNT(*) c FROM jobs WHERE status = 'open'${ownerAnd}`)
      .bind(...ownerBind)
      .first<{ c: number }>();
    const openJobs = openJobsRow?.c ?? 0;

    // 人才库总数
    const totalTalentsRow = await db
      .prepare(`SELECT COUNT(*) c FROM talents WHERE 1=1${ownerAnd}`)
      .bind(...ownerBind)
      .first<{ c: number }>();
    const totalTalents = totalTalentsRow?.c ?? 0;

    // 当前各阶段人数（talent_jobs 当前停留阶段）
    const stageRows = await db
      .prepare(`SELECT stage, COUNT(*) c FROM talent_jobs WHERE 1=1${ownerAnd} GROUP BY stage`)
      .bind(...ownerBind)
      .all<{ stage: string; c: number }>();
    const stageCounts: Record<string, number> = {};
    let activeCandidates = 0;
    for (const r of stageRows.results || []) {
      stageCounts[r.stage] = r.c;
      if (!(TERMINAL as readonly string[]).includes(r.stage)) activeCandidates += r.c;
    }

    // 本周新增人才
    const weekNewRow = await db
      .prepare(`SELECT COUNT(*) c FROM talents WHERE created_at >= ?${isAdmin ? "" : " AND owner_id = ?"}`)
      .bind(weekStart, ...ownerBind)
      .first<{ c: number }>();
    const weeklyNewTalents = weekNewRow?.c ?? 0;

    // 本周各阶段「到达」人次（job_stage_logs 的 to_stage，按 owner 隔离）
    const weekStageRows = await db
      .prepare(
        `SELECT l.to_stage AS stage, COUNT(*) c
         FROM job_stage_logs l
         JOIN talent_jobs j ON j.id = l.talent_job_id
         WHERE l.created_at >= ?${isAdmin ? "" : " AND j.owner_id = ?"}
         GROUP BY l.to_stage`
      )
      .bind(weekStart, ...ownerBind)
      .all<{ stage: string; c: number }>();
    const weeklyStageReached: Record<string, number> = {};
    for (const r of weekStageRows.results || []) weeklyStageReached[r.stage] = r.c;

    // 待办汇总：pending 总数 / 逾期 / 今日到期
    const taskRow = await db
      .prepare(
        `SELECT COUNT(*) total,
                SUM(CASE WHEN due_date < ? THEN 1 ELSE 0 END) overdue,
                SUM(CASE WHEN due_date = ? THEN 1 ELSE 0 END) today
         FROM talent_tasks WHERE status = 'pending'${isAdmin ? "" : " AND owner_id = ?"}`
      )
      .bind(today, today, ...ownerBind)
      .first<{ total: number | null; overdue: number | null; today: number | null }>();

    return {
      openJobs,
      totalTalents,
      activeCandidates,
      stageCounts,
      weeklyNewTalents,
      weeklyStageReached,
      tasks: {
        pending: taskRow?.total ?? 0,
        overdue: taskRow?.overdue ?? 0,
        today: taskRow?.today ?? 0,
      },
    };
  });
});

export { overview };
