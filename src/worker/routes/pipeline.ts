import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { genId } from "../helpers";

const pipeline = new Hono<{ Bindings: Env }>();

// 阶段定义与前端 types.ts 的 PIPELINE_STAGES 保持一致
const STAGES = ["screening", "interview1", "interview2", "offer", "hired", "rejected", "withdrawn"] as const;
type Stage = (typeof STAGES)[number];

// 终态：不再计入「进行中」
const TERMINAL: Stage[] = ["hired", "rejected", "withdrawn"];

// 进行中阶段的推进顺序（用于派生人才全局阶段时取「最靠前」的一档）
const PROGRESS_ORDER: Stage[] = ["screening", "interview1", "interview2", "offer"];

/**
 * 同步人才全局阶段 talents.stage —— 该字段是冗余缓存，唯一真源是 talent_jobs.stage
 * （一个人在不同岗位可以处于不同阶段，全局阶段表示「整体推进到哪一步」）。
 * 规则：任一投递已入职 → hired 且 status='placed'；否则取所有进行中投递里最靠前的阶段；
 *      全部为终态（淘汰/放弃）→ archived。任何阶段变更后调用，避免出现「A 岗位已入职、
 *      全局却还是初试」这类双轨不一致。
 */
async function syncTalentStage(db: D1Database, talentId: string): Promise<void> {
  const rows = await db.prepare("SELECT stage FROM talent_jobs WHERE talent_id = ?")
    .bind(talentId).all<{ stage: string }>();
  const stages = ((rows.results || []) as { stage: string }[]).map((r) => r.stage);
  if (stages.length === 0) return;

  if (stages.includes("hired")) {
    await db.prepare("UPDATE talents SET stage = 'hired', status = 'placed', updated_at = datetime('now') WHERE id = ?")
      .bind(talentId).run();
    return;
  }

  const active = stages.filter((s) => (PROGRESS_ORDER as string[]).includes(s));
  if (active.length === 0) {
    // 全部终态（淘汰 / 放弃）：回到人才库待激活状态
    await db.prepare("UPDATE talents SET stage = 'archived', updated_at = datetime('now') WHERE id = ?")
      .bind(talentId).run();
    return;
  }

  const furthest = active.reduce((a, b) =>
    PROGRESS_ORDER.indexOf(b as Stage) > PROGRESS_ORDER.indexOf(a as Stage) ? b : a);
  await db.prepare("UPDATE talents SET stage = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(furthest, talentId).run();
}

// 阶段展示元信息（与前端 types.ts 的 PIPELINE_STAGES 保持一致）
const STAGE_LABELS: Record<Stage, { label: string; color: string }> = {
  screening:  { label: "简历筛选", color: "#0ea5e9" },
  interview1: { label: "初试",     color: "#6366f1" },
  interview2: { label: "复试",     color: "#8b5cf6" },
  offer:      { label: "Offer",    color: "#f59e0b" },
  hired:      { label: "已入职",   color: "#10b981" },
  rejected:   { label: "已淘汰",   color: "#ef4444" },
  withdrawn:  { label: "已放弃",   color: "#94a3b8" },
};

// ---- 看板：按阶段返回候选人 ----
// 查询参数：job_id（可选，不传=全部岗位）、owner_id（可选，管理员用）、q（姓名搜索）
pipeline.get("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const jobId = c.req.query("job_id");
  const ownerId = c.req.query("owner_id");
  const q = (c.req.query("q") || "").trim();

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  // 普通用户只看自己创建的人才；管理员可看全部或按创建人过滤
  if (session.role !== "admin") {
    conditions.push("t.owner_id = ?");
    params.push(session.userId);
  } else if (ownerId) {
    conditions.push("t.owner_id = ?");
    params.push(ownerId);
  }

  if (jobId) { conditions.push("tj.job_id = ?"); params.push(jobId); }
  if (q) {
    conditions.push("(t.name LIKE ? OR t.current_title LIKE ? OR t.current_company LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  const rows = await c.env.DB.prepare(`
    SELECT tj.id as link_id, tj.stage, tj.rating, tj.notes as stage_notes, tj.updated_at as stage_updated_at,
           t.id as talent_id, t.name, t.phone, t.current_title, t.current_company,
           t.years_experience, t.education, t.city, t.resume_url, t.source,
           (SELECT MIN(tt.due_date) FROM talent_tasks tt
              WHERE tt.talent_id = t.id AND tt.status = 'pending' AND tt.due_date IS NOT NULL) as next_follow,
           j.id as job_id, j.title as job_title, j.department as job_department, j.city as job_city,
           u.name as owner_name
    FROM talent_jobs tj
    JOIN talents t ON tj.talent_id = t.id
    LEFT JOIN jobs j ON tj.job_id = j.id
    JOIN users u ON t.owner_id = u.id
    ${where}
    ORDER BY tj.updated_at DESC
  `).bind(...params).all();

  // 按阶段归组，同时给出每阶段计数与「停留天数」
  const today = Date.now();
  const columns: Record<string, any[]> = {};
  for (const s of STAGES) columns[s] = [];

  for (const r of rows.results as any[]) {
    if (!columns[r.stage]) columns[r.stage] = [];
    const updated = r.stage_updated_at ? new Date(r.stage_updated_at + "Z").getTime() : today;
    columns[r.stage].push({
      ...r,
      days_in_stage: Math.max(0, Math.floor((today - updated) / 86400000)),
    });
  }

  const stats = {
    total: rows.results.length,
    active: (rows.results as any[]).filter((r) => !TERMINAL.includes(r.stage)).length,
    hired: (rows.results as any[]).filter((r) => r.stage === "hired").length,
    rejected: (rows.results as any[]).filter((r) => r.stage === "rejected").length,
  };

  return c.json({ columns, stats });
});

// ---- 统计：面试中停留过久的候选人（>7 天）----
// 放在 /:linkId 之前，避免 "stale" 被当作 linkId 匹配。
pipeline.get("/stale", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const conditions: string[] = ["tj.stage NOT IN ('hired','rejected','withdrawn')"];
  const params: (string | number)[] = [];
  if (session.role !== "admin") {
    conditions.push("t.owner_id = ?");
    params.push(session.userId);
  }

  const rows = await c.env.DB.prepare(`
    SELECT tj.id as link_id, tj.stage, tj.updated_at as stage_updated_at,
           t.id as talent_id, t.name, j.title as job_title
    FROM talent_jobs tj
    JOIN talents t ON tj.talent_id = t.id
    LEFT JOIN jobs j ON tj.job_id = j.id
    WHERE ${conditions.join(" AND ")}
  `).bind(...params).all();

  const today = Date.now();
  const items = (rows.results as any[])
    .map((r) => ({
      ...r,
      days_stale: Math.floor((today - new Date(r.stage_updated_at + "Z").getTime()) / 86400000),
    }))
    .filter((r) => r.days_stale >= 7)
    .sort((a, b) => b.days_stale - a.days_stale);

  return c.json({ items, total: items.length });
});

// ---- 阶段停滞 → 待办提醒（幂等同步）----
// 规则：候选人在非终态阶段停留 ≥ STALE_DAYS 天 → 生成「阶段停滞：X」待办（normal / system）；
// 停留天数变化 → 更新待办内容；已被推进（不再停滞）→ 取消残留提醒。
// 与合同/社保待办同一套幂等同步套路，可重复调用（前端每次进看板自动跑一次）。
const STALE_DAYS = 7;

pipeline.post("/sync-stale-tasks", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const conditions: string[] = ["tj.stage NOT IN ('hired','rejected','withdrawn')"];
  const params: (string | number)[] = [];
  if (session.role !== "admin") {
    conditions.push("t.owner_id = ?");
    params.push(session.userId);
  }

  const rows = await c.env.DB.prepare(`
    SELECT tj.stage, tj.updated_at as stage_updated_at,
           t.id as talent_id, t.name, t.owner_id, j.title as job_title
    FROM talent_jobs tj
    JOIN talents t ON tj.talent_id = t.id
    LEFT JOIN jobs j ON tj.job_id = j.id
    WHERE ${conditions.join(" AND ")}
  `).bind(...params).all();

  // 同一人才可能挂在多个岗位：取停留最久的一条作为代表，一人只提醒一次
  const today = Date.now();
  const staleMap = new Map<string, {
    talent_id: string; name: string; owner_id: string; days: number; stage: string; job_title: string | null;
  }>();
  for (const r of rows.results as any[]) {
    const days = Math.floor((today - new Date(r.stage_updated_at + "Z").getTime()) / 86400000);
    if (days < STALE_DAYS) continue;
    const prev = staleMap.get(r.talent_id);
    if (!prev || days > prev.days) {
      staleMap.set(r.talent_id, {
        talent_id: r.talent_id, name: r.name, owner_id: r.owner_id,
        days, stage: r.stage, job_title: r.job_title,
      });
    }
  }

  // 现存「阶段停滞」待办：普通用户只看自己的，避免误取消他人提醒
  let tSql = "SELECT id, talent_id, content FROM talent_tasks WHERE title LIKE '阶段停滞%' AND status = 'pending'";
  const tParams: string[] = [];
  if (session.role !== "admin") { tSql += " AND owner_id = ?"; tParams.push(session.userId); }
  const existing = new Map<string, any>();
  for (const t of (await c.env.DB.prepare(tSql).bind(...tParams).all<any>()).results) {
    existing.set(t.talent_id, t);
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const stmts: any[] = [];
  let created = 0, updated = 0, cancelled = 0;

  for (const [talentId, v] of staleMap) {
    const title = `阶段停滞：${v.name}`;
    const content = `${v.name}${v.job_title ? `（${v.job_title}）` : ""} 在「${STAGE_LABELS[v.stage as Stage]?.label || v.stage}」已停留 ${v.days} 天，请尽快推进、约面或释放。`;
    const dup = existing.get(talentId);
    if (!dup) {
      stmts.push(c.env.DB.prepare(
        "INSERT INTO talent_tasks (id, owner_id, talent_id, title, content, due_date, priority, status, source) VALUES (?, ?, ?, ?, ?, ?, 'normal', 'pending', 'system')"
      ).bind(genId(), v.owner_id, talentId, title, content, todayStr));
      created++;
    } else if (dup.content !== content) {
      stmts.push(c.env.DB.prepare("UPDATE talent_tasks SET content = ?, due_date = ? WHERE id = ?")
        .bind(content, todayStr, dup.id));
      updated++;
    }
  }

  // 已不再停滞（被推进/淘汰/入职）→ 取消残留提醒
  for (const [talentId, t] of existing) {
    if (!staleMap.has(talentId)) {
      stmts.push(c.env.DB.prepare("UPDATE talent_tasks SET status = 'cancelled' WHERE id = ?").bind(t.id));
      cancelled++;
    }
  }

  if (stmts.length > 0) await c.env.DB.batch(stmts);
  return c.json({ created, updated, cancelled, total: staleMap.size });
});

// ============================================================
// 招聘漏斗（funnel）
// 口径说明：阶段人数采用「曾到达」口径 —— 只要 job_stage_logs 里出现过
// to_stage = 该阶段的记录，就计入该阶段人数。这样即便候选人后续被淘汰/
// 放弃，也仍然计入漏斗上层，漏斗才单调递减。
// 注意：本路由必须注册在任何 /:linkId 之前。
// ============================================================

// 漏斗主线（不含终态分支）
const FUNNEL_ORDER: Stage[] = ["screening", "interview1", "interview2", "offer", "hired"];

// 把毫秒差转成「天」（保留 1 位小数）
function toDays(ms: number): number {
  return Math.max(0, Math.round((ms / 86400000) * 10) / 10);
}

// 解析 D1 的 datetime('now') 字符串（UTC，无时区后缀）→ 毫秒
function parseSqlTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = new Date(s.includes("T") || s.includes("Z") ? s : s.replace(" ", "T") + "Z").getTime();
  return Number.isNaN(t) ? null : t;
}

pipeline.get("/funnel", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const jobId = c.req.query("job_id");
  const ownerId = c.req.query("owner_id");
  const days = Number(c.req.query("days") || 0); // 0 = 全部时间

  // 权限：非 admin 只看自己的人才
  const conds: string[] = [];
  const params: (string | number)[] = [];
  if (session.role !== "admin") {
    conds.push("t.owner_id = ?");
    params.push(session.userId);
  } else if (ownerId) {
    conds.push("t.owner_id = ?");
    params.push(ownerId);
  }
  if (jobId) { conds.push("tj.job_id = ?"); params.push(jobId); }
  if (days > 0) {
    conds.push("tj.created_at >= datetime('now', ?)");
    params.push(`-${days} days`);
  }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";

  // 一次查出所有候选人的全部流转日志（含 join 出来的岗位/人才信息）
  const rows = await c.env.DB.prepare(`
    SELECT tj.id AS link_id, tj.stage AS current_stage, tj.created_at AS entered_at,
           t.id AS talent_id, t.name, t.created_at AS talent_created_at, t.source,
           j.id AS job_id, j.title AS job_title,
           l.from_stage, l.to_stage, l.remark, l.created_at AS log_at
    FROM talent_jobs tj
    JOIN talents t ON tj.talent_id = t.id
    LEFT JOIN jobs j ON tj.job_id = j.id
    LEFT JOIN job_stage_logs l ON l.talent_job_id = tj.id
    ${where}
    ORDER BY tj.id, l.created_at ASC
  `).bind(...params).all();

  // ---- 按候选人聚合 ----
  interface Cand {
    link_id: string;
    current_stage: string;
    entered_at: string | null;
    talent_id: string;
    name: string;
    talent_created_at: string | null;
    source: string | null;
    job_id: string | null;
    job_title: string | null;
    reached: Set<Stage>;
    firstEnter: Record<string, number>; // 首次到达某阶段的时间
    lastLogAt: number;
  }
  const map = new Map<string, Cand>();
  // 淘汰原因：流转到 rejected 的日志备注按【原因】前缀归类（看板淘汰弹窗写入）
  const rejectRemarks: string[] = [];
  for (const r of rows.results as any[]) {
    if (r.to_stage === "rejected" && r.remark) rejectRemarks.push(r.remark);
    let cd = map.get(r.link_id);
    if (!cd) {
      cd = {
        link_id: r.link_id,
        current_stage: r.current_stage,
        entered_at: r.entered_at,
        talent_id: r.talent_id,
        name: r.name,
        talent_created_at: r.talent_created_at,
        source: r.source,
        job_id: r.job_id,
        job_title: r.job_title,
        reached: new Set<Stage>(),
        firstEnter: {},
        lastLogAt: 0,
      };
      map.set(r.link_id, cd);
    }
    if (r.to_stage) {
      const st = r.to_stage as Stage;
      cd.reached.add(st);
      const ts = parseSqlTime(r.log_at);
      if (ts != null) {
        if (cd.firstEnter[st] == null || ts < cd.firstEnter[st]) cd.firstEnter[st] = ts;
        if (ts > cd.lastLogAt) cd.lastLogAt = ts;
      }
    }
  }
  const cands = [...map.values()];

  // ---- 各阶段人数与转化率 ----
  const counts: Record<string, number> = {};
  for (const s of FUNNEL_ORDER) {
    counts[s] = cands.filter((cd) => cd.reached.has(s)).length;
  }

  const stages = FUNNEL_ORDER.map((s, i) => {
    const meta = STAGE_LABELS[s];
    const count = counts[s];
    const prev = i === 0 ? count : counts[FUNNEL_ORDER[i - 1]];
    const rate = i === 0 ? (count > 0 ? 1 : 0) : (prev > 0 ? count / prev : 0);
    const drop = i === 0 ? 0 : Math.max(0, prev - count);
    return {
      key: s,
      label: meta.label,
      color: meta.color,
      count,
      prev_count: prev,
      rate: Math.round(rate * 1000) / 1000, // 相对上一级转化率
      overall_rate: counts[FUNNEL_ORDER[0]] > 0
        ? Math.round((count / counts[FUNNEL_ORDER[0]]) * 1000) / 1000
        : 0,
      drop,
    };
  });

  // ---- 平均停留天数（当前阶段）：用最后一条日志时间近似 ----
  const now = Date.now();
  const stageStay: Record<string, number[]> = {};
  for (const s of FUNNEL_ORDER) stageStay[s] = [];
  for (const cd of cands) {
    if (!FUNNEL_ORDER.includes(cd.current_stage as Stage)) continue;
    // 优先用「首次到达当前阶段」的时间，缺失则回退到最后一条日志
    const since = cd.firstEnter[cd.current_stage] ?? cd.lastLogAt ?? parseSqlTime(cd.entered_at) ?? now;
    stageStay[cd.current_stage].push(toDays(now - since));
  }

  // ---- 周期指标 ----
  // tti/toOffer/toHire/total：各自独立取「到过首尾两端」的样本（尽量大的样本量）
  // segments：只取三段齐全的入职者，保证 s1+s2+s3 === total，用于耗时构成条
  const tti: number[] = [];      // 简历入库 → 首次进入面试（interview1）
  const toOffer: number[] = [];  // 首次面试 → Offer
  const toHire: number[] = [];   // Offer → 入职
  const total: number[] = [];    // 入库 → 入职
  const seg1: number[] = [];     // 入库 → 首面（仅完整链路入职者）
  const seg2: number[] = [];     // 首面 → Offer（同上）
  const seg3: number[] = [];     // Offer → 入职（同上）

  for (const cd of cands) {
    const start = parseSqlTime(cd.talent_created_at) ?? parseSqlTime(cd.entered_at);
    const iv = cd.firstEnter["interview1"];
    const of = cd.firstEnter["offer"];
    const hi = cd.firstEnter["hired"];

    if (start != null && iv != null && iv >= start) tti.push(toDays(iv - start));
    if (iv != null && of != null && of >= iv) toOffer.push(toDays(of - iv));
    if (of != null && hi != null && hi >= of) toHire.push(toDays(hi - of));
    if (start != null && hi != null && hi >= start) total.push(toDays(hi - start));

    // 完整链路：入库 → 首面 → Offer → 入职，四段时间点齐全且时序递增
    if (start != null && iv != null && of != null && hi != null &&
        start <= iv && iv <= of && of <= hi) {
      seg1.push(toDays(iv - start));
      seg2.push(toDays(of - iv));
      seg3.push(toDays(hi - of));
    }
  }

  const r1 = (v: number) => Math.round(v * 10) / 10;
  const avg = (arr: number[]) =>
    arr.length ? r1(arr.reduce((a, b) => a + b, 0) / arr.length) : null;

  // 线性插值分位数（已排序数组）
  const quantile = (sorted: number[], q: number): number | null => {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return lo === hi ? r1(sorted[lo]) : r1(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
  };

  // 一段周期的统计分布：平均值易被长尾拉偏，故一并给出中位数 / P90 / 极值
  const stat = (arr: number[]) => {
    if (!arr.length) return { avg: null, p50: null, p90: null, max: null, min: null, n: 0 };
    const sorted = [...arr].sort((a, b) => a - b);
    return {
      avg: avg(arr),
      p50: quantile(sorted, 0.5),
      p90: quantile(sorted, 0.9),
      max: r1(sorted[sorted.length - 1]),
      min: r1(sorted[0]),
      n: arr.length,
    };
  };

  // ---- 汇总卡片 ----
  const first = counts["screening"] || cands.length;
  const hired = counts["hired"];
  const rejected = cands.filter((cd) => cd.reached.has("rejected")).length;
  const withdrawn = cands.filter((cd) => cd.reached.has("withdrawn")).length;
  const inProgress = cands.filter((cd) => !TERMINAL.includes(cd.current_stage as Stage)).length;

  // ---- 渠道效果：按人才来源分组（口径与人·岗位一致，同人才多岗分别计）----
  // 除「进入→入职」外，补充进行中/淘汰/放弃分布与平均招聘周期，
  // 回答「哪个渠道量最大、哪个转化高、哪个招得快」三个问题
  const srcMap: Record<string, {
    entered: number; hired: number; inProgress: number; rejected: number; withdrawn: number; cycles: number[];
  }> = {};
  for (const cd of cands) {
    const key = (cd.source || "").trim() || "未记录";
    const v = (srcMap[key] ||= { entered: 0, hired: 0, inProgress: 0, rejected: 0, withdrawn: 0, cycles: [] });
    v.entered++;
    if (cd.reached.has("hired")) v.hired++;
    if (!TERMINAL.includes(cd.current_stage as Stage)) v.inProgress++;
    if (cd.reached.has("rejected")) v.rejected++;
    if (cd.reached.has("withdrawn")) v.withdrawn++;
    // 平均招聘周期：入库（或首次进入流程）→ 入职的天数，仅入职者计入样本
    const start = parseSqlTime(cd.talent_created_at) ?? parseSqlTime(cd.entered_at);
    const hi = cd.firstEnter["hired"];
    if (start != null && hi != null && hi >= start) v.cycles.push(toDays(hi - start));
  }
  const sources = Object.entries(srcMap)
    .map(([source, v]) => ({
      source,
      entered: v.entered,
      hired: v.hired,
      rate: v.entered > 0 ? Math.round((v.hired / v.entered) * 1000) / 1000 : 0,
      in_progress: v.inProgress,
      rejected: v.rejected,
      withdrawn: v.withdrawn,
      avg_cycle_days: avg(v.cycles),
    }))
    .sort((a, b) => b.entered - a.entered);

  // ---- 淘汰原因分布 ----
  const reasonMap: Record<string, number> = {};
  for (const rm of rejectRemarks) {
    const m = rm.match(/^【(.+?)】/);
    const key = m ? m[1] : "未分类";
    reasonMap[key] = (reasonMap[key] || 0) + 1;
  }
  const reject_reasons = Object.entries(reasonMap)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return c.json({
    stages,
    stage_stay: FUNNEL_ORDER.map((s) => ({
      key: s,
      label: STAGE_LABELS[s].label,
      avg_days: avg(stageStay[s]),
      count: stageStay[s].length,
    })),
    cycles: {
      tti: stat(tti),
      to_offer: stat(toOffer),
      to_hire: stat(toHire),
      total: stat(total),
      // 耗时构成：同一批完整链路入职者的三段耗时，三者之和 = 该批人的全流程周期
      segments: {
        s1: avg(seg1),
        s2: avg(seg2),
        s3: avg(seg3),
        n: seg1.length,
      },
    },
    summary: {
      total: cands.length,
      entered: first,
      in_progress: inProgress,
      hired,
      rejected,
      withdrawn,
      overall_rate: first > 0 ? Math.round((hired / first) * 1000) / 1000 : 0,
    },
    sources,
    reject_reasons,
  });
});

// ---- 把人才加入岗位（创建候选人关联）----
pipeline.post("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const body = await c.req.json<{ talent_id?: string; job_id?: string; stage?: Stage; notes?: string }>();
  if (!body.talent_id || !body.job_id) return c.json({ error: "人才和岗位均为必填" }, 400);

  // 权限校验：普通用户只能操作自己的人才；岗位也须可见
  let tSql = "SELECT id, name FROM talents WHERE id = ?";
  const tParams: string[] = [body.talent_id];
  if (session.role !== "admin") { tSql += " AND owner_id = ?"; tParams.push(session.userId); }
  const talent = await c.env.DB.prepare(tSql).bind(...tParams).first<{ id: string; name: string }>();
  if (!talent) return c.json({ error: "人才不存在或无权限" }, 404);

  let jSql = "SELECT id, title FROM jobs WHERE id = ?";
  const jParams: string[] = [body.job_id];
  if (session.role !== "admin") { jSql += " AND owner_id = ?"; jParams.push(session.userId); }
  const job = await c.env.DB.prepare(jSql).bind(...jParams).first<{ id: string; title: string }>();
  if (!job) return c.json({ error: "岗位不存在或无权限" }, 404);

  const dup = await c.env.DB.prepare("SELECT id FROM talent_jobs WHERE talent_id = ? AND job_id = ?")
    .bind(body.talent_id, body.job_id).first();
  if (dup) return c.json({ error: "该人才已在此岗位的招聘看板中" }, 409);

  const id = genId();
  const stage: Stage = STAGES.includes(body.stage as Stage) ? (body.stage as Stage) : "screening";
  await c.env.DB.prepare("INSERT INTO talent_jobs (id, talent_id, job_id, stage, notes) VALUES (?, ?, ?, ?, ?)")
    .bind(id, body.talent_id, body.job_id, stage, body.notes || null).run();

  await c.env.DB.prepare("INSERT INTO job_stage_logs (id, talent_job_id, from_stage, to_stage, user_id, remark) VALUES (?, ?, NULL, ?, ?, ?)")
    .bind(genId(), id, stage, session.userId, "加入招聘看板").run();

  // 同步人才全局阶段（冗余字段，派生自 talent_jobs）
  await syncTalentStage(c.env.DB, body.talent_id);

  return c.json({ id, talent_name: talent.name, job_title: job.title, stage });
});

// ---- 批量把人才加入岗位（人才库多选 → 一次挂到同一岗位）----
pipeline.post("/batch", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const body = await c.req.json<{ talent_ids?: string[]; job_id?: string; stage?: Stage; notes?: string }>();
  const ids = [...new Set((body.talent_ids || []).filter(Boolean))];
  if (ids.length === 0 || !body.job_id) return c.json({ error: "人才与岗位均为必填" }, 400);
  if (ids.length > 50) return c.json({ error: "一次最多批量加入 50 人" }, 400);

  // 岗位权限：普通用户只能操作自己的岗位
  let jSql = "SELECT id, title FROM jobs WHERE id = ?";
  const jParams: string[] = [body.job_id];
  if (session.role !== "admin") { jSql += " AND owner_id = ?"; jParams.push(session.userId); }
  const job = await c.env.DB.prepare(jSql).bind(...jParams).first<{ id: string; title: string }>();
  if (!job) return c.json({ error: "岗位不存在或无权限" }, 404);

  const stage: Stage = STAGES.includes(body.stage as Stage) ? (body.stage as Stage) : "screening";

  // 人才权限 + 查重：已在该岗位流程里的人自动跳过
  const ph = ids.map(() => "?").join(",");
  let tSql = `SELECT id, name FROM talents WHERE id IN (${ph})`;
  const tParams: string[] = [...ids];
  if (session.role !== "admin") { tSql += " AND owner_id = ?"; tParams.push(session.userId); }
  const talents = (await c.env.DB.prepare(tSql).bind(...tParams).all<{ id: string; name: string }>()).results;
  if (talents.length === 0) return c.json({ error: "所选人才不存在或无权限" }, 404);

  const dupRows = (await c.env.DB.prepare(
    `SELECT talent_id FROM talent_jobs WHERE job_id = ? AND talent_id IN (${talents.map(() => "?").join(",")})`
  ).bind(body.job_id, ...talents.map((t) => t.id)).all<{ talent_id: string }>()).results;
  const dupSet = new Set(dupRows.map((r) => r.talent_id));

  const added = talents.filter((t) => !dupSet.has(t.id));
  if (added.length === 0) {
    return c.json({
      added: 0, skipped: talents.length, job_title: job.title,
      added_names: [], skipped_names: talents.map((t) => t.name),
    });
  }

  // 一个事务写入：talent_jobs + 首条流转日志 + 人才全局阶段同步
  const stmts = added.flatMap((t) => {
    const id = genId();
    return [
      c.env.DB.prepare("INSERT INTO talent_jobs (id, talent_id, job_id, stage, notes) VALUES (?, ?, ?, ?, ?)")
        .bind(id, t.id, body.job_id, stage, body.notes || null),
      c.env.DB.prepare("INSERT INTO job_stage_logs (id, talent_job_id, from_stage, to_stage, user_id, remark) VALUES (?, ?, NULL, ?, ?, ?)")
        .bind(genId(), id, stage, session.userId, "加入招聘看板"),
    ];
  });
  await c.env.DB.batch(stmts);

  // 同步各人才的全局阶段（冗余字段，派生自 talent_jobs）
  for (const t of added) await syncTalentStage(c.env.DB, t.id);

  return c.json({
    added: added.length,
    skipped: talents.length - added.length,
    job_title: job.title,
    added_names: added.map((t) => t.name),
    skipped_names: talents.filter((t) => dupSet.has(t.id)).map((t) => t.name),
  });
});

// ---- 批量切换阶段（看板多选 → 一次推进或淘汰）----
// 初筛环节最痛：一次刷掉 20 人原本要拖 20 次 + 填 20 次原因，这里一次性完成。
// 权限、阶段日志、淘汰原因结构化、入职联动都与单卡流转保持一致。
pipeline.post("/batch-stage", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const body = await c.req.json<{ link_ids?: string[]; stage?: string; reject_reason?: string; remark?: string }>();
  const ids = [...new Set((body.link_ids || []).filter(Boolean))];
  const stage = body.stage as Stage;
  if (ids.length === 0 || !STAGES.includes(stage)) return c.json({ error: "参数不合法" }, 400);
  if (ids.length > 100) return c.json({ error: "一次最多批量流转 100 人" }, 400);

  const ph = ids.map(() => "?").join(",");
  const rows = await c.env.DB.prepare(`
    SELECT tj.id, tj.stage as old_stage, tj.talent_id, tj.job_id, t.name as talent_name, t.owner_id
    FROM talent_jobs tj JOIN talents t ON tj.talent_id = t.id WHERE tj.id IN (${ph})
  `).bind(...ids).all<any>();

  // 无权限的跳过；已处于目标阶段的跳过（不重复写日志）
  const targets = (rows.results as any[]).filter((r) => {
    if (session.role !== "admin" && r.owner_id !== session.userId) return false;
    return r.old_stage !== stage;
  });
  const skipped = rows.results.length - targets.length;
  if (targets.length === 0) return c.json({ updated: 0, skipped, names: [] });

  // 淘汰原因结构化：标准原因以【原因】前缀拼进备注，漏斗页据此统计分布
  let remark = body.remark || "";
  if (stage === "rejected" && body.reject_reason) remark = `【${body.reject_reason}】${remark}`;

  const stmts: any[] = [];
  for (const r of targets) {
    stmts.push(c.env.DB.prepare("UPDATE talent_jobs SET stage = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(stage, r.id));
    stmts.push(c.env.DB.prepare(
      "INSERT INTO job_stage_logs (id, talent_job_id, from_stage, to_stage, user_id, remark) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(genId(), r.id, r.old_stage, stage, session.userId, remark || null));
  }
  await c.env.DB.batch(stmts);

  // 批量入职联动：人才状态置 placed，并生成「试用期跟进」待办（防重）
  let hiredLinked = 0;
  if (stage === "hired") {
    const talentIds = [...new Set(targets.map((r) => r.talent_id))];
    const dupRows = await c.env.DB.prepare(
      `SELECT talent_id FROM talent_tasks WHERE status = 'pending' AND title LIKE '试用期跟进%' AND talent_id IN (${talentIds.map(() => "?").join(",")})`
    ).bind(...talentIds).all<any>();
    const dupSet = new Set((dupRows.results as any[]).map((r) => r.talent_id));

    const due = new Date(Date.now() + 90 * 86400000);
    const p = (n: number) => String(n).padStart(2, "0");
    const dueStr = `${due.getFullYear()}-${p(due.getMonth() + 1)}-${p(due.getDate())}`;

    const hiredStmts: any[] = [];
    for (const r of targets) {
      hiredStmts.push(c.env.DB.prepare(
        "UPDATE talents SET status = 'placed', stage = 'hired', updated_at = datetime('now') WHERE id = ?"
      ).bind(r.talent_id));
      if (!dupSet.has(r.talent_id)) {
        hiredStmts.push(c.env.DB.prepare(
          "INSERT INTO talent_tasks (id, owner_id, talent_id, job_id, title, content, due_date, priority, status, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'normal', 'pending', 'system')"
        ).bind(genId(), r.owner_id, r.talent_id, r.job_id,
          `试用期跟进：${r.talent_name}`,
          "候选人已入职，关注试用期表现与融入情况，到期前完成转正评估。", dueStr));
        dupSet.add(r.talent_id);
        hiredLinked++;
      }
    }
    await c.env.DB.batch(hiredStmts);
  }

  // 同步各人才的全局阶段（冗余字段，派生自 talent_jobs）
  for (const r of targets) await syncTalentStage(c.env.DB, r.talent_id);

  return c.json({
    updated: targets.length,
    skipped,
    hired_linked: hiredLinked,
    names: targets.map((r) => r.talent_name),
  });
});

// ---- 切换候选人阶段（看板拖拽 / 下拉）----
pipeline.put("/:linkId/stage", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const linkId = c.req.param("linkId");
  const body = await c.req.json<{ stage?: string; remark?: string; rating?: number; reject_reason?: string }>();
  if (!body.stage || !STAGES.includes(body.stage as Stage)) return c.json({ error: "阶段值不合法" }, 400);

  // 权限校验
  const link = await c.env.DB.prepare(`
    SELECT tj.id, tj.stage as old_stage, tj.talent_id, tj.job_id, t.name as talent_name, t.owner_id
    FROM talent_jobs tj JOIN talents t ON tj.talent_id = t.id WHERE tj.id = ?
  `).bind(linkId).first<any>();
  if (!link) return c.json({ error: "候选人记录不存在" }, 404);
  if (session.role !== "admin" && link.owner_id !== session.userId) {
    return c.json({ error: "无权限" }, 403);
  }
  if (link.old_stage === body.stage) return c.json({ ok: true, stage: body.stage });

  // 淘汰原因结构化：标准原因以【原因】前缀拼进备注，漏斗页据此统计分布
  let remark = body.remark || "";
  if (body.stage === "rejected" && body.reject_reason) {
    remark = `【${body.reject_reason}】${remark}`;
  }

  await c.env.DB.prepare("UPDATE talent_jobs SET stage = ?, rating = COALESCE(?, rating), updated_at = datetime('now') WHERE id = ?")
    .bind(body.stage, body.rating ?? null, linkId).run();

  await c.env.DB.prepare("INSERT INTO job_stage_logs (id, talent_job_id, from_stage, to_stage, user_id, remark) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(genId(), linkId, link.old_stage, body.stage, session.userId, remark || null).run();

  // 阶段推进到「已入职」时：联动人才全局状态为 placed（已入职），
  // 并生成一条「试用期跟进」待办（防重：同人才已有未完成的同前缀待办则跳过）
  let taskCreated = false;
  if (body.stage === "hired") {
    const dupTask = await c.env.DB.prepare(
      "SELECT id FROM talent_tasks WHERE talent_id = ? AND status = 'pending' AND title LIKE '试用期跟进%'"
    ).bind(link.talent_id).first();
    if (!dupTask) {
      const due = new Date(Date.now() + 90 * 86400000);
      const p = (n: number) => String(n).padStart(2, "0");
      await c.env.DB.prepare(
        "INSERT INTO talent_tasks (id, owner_id, talent_id, job_id, title, content, due_date, priority, status, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'normal', 'pending', 'system')"
      ).bind(
        genId(), link.owner_id, link.talent_id, link.job_id,
        `试用期跟进：${link.talent_name}`,
        "候选人已入职，关注试用期表现与融入情况，到期前完成转正评估。",
        `${due.getFullYear()}-${p(due.getMonth() + 1)}-${p(due.getDate())}`
      ).run();
      taskCreated = true;
    }
  }

  // 同步人才全局阶段（冗余字段，派生自 talent_jobs）
  await syncTalentStage(c.env.DB, link.talent_id);

  return c.json({ ok: true, stage: body.stage, task_created: taskCreated });
});

// ---- 阶段流转历史 ----
pipeline.get("/:linkId/logs", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const linkId = c.req.param("linkId");
  const link = await c.env.DB.prepare(`
    SELECT tj.id, t.owner_id FROM talent_jobs tj JOIN talents t ON tj.talent_id = t.id WHERE tj.id = ?
  `).bind(linkId).first<any>();
  if (!link) return c.json({ error: "候选人记录不存在" }, 404);
  if (session.role !== "admin" && link.owner_id !== session.userId) return c.json({ error: "无权限" }, 403);

  const rows = await c.env.DB.prepare(`
    SELECT l.*, u.name as user_name FROM job_stage_logs l
    LEFT JOIN users u ON l.user_id = u.id
    WHERE l.talent_job_id = ? ORDER BY l.created_at DESC
  `).bind(linkId).all();

  return c.json(rows.results);
});

// ---- 从岗位移除候选人（同时清理待办关联）----
pipeline.delete("/:linkId", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const linkId = c.req.param("linkId");
  const link = await c.env.DB.prepare(`
    SELECT tj.id, t.owner_id FROM talent_jobs tj JOIN talents t ON tj.talent_id = t.id WHERE tj.id = ?
  `).bind(linkId).first<any>();
  if (!link) return c.json({ error: "候选人记录不存在" }, 404);
  if (session.role !== "admin" && link.owner_id !== session.userId) return c.json({ error: "无权限" }, 403);

  await c.env.DB.prepare("DELETE FROM job_stage_logs WHERE talent_job_id = ?").bind(linkId).run();
  await c.env.DB.prepare("DELETE FROM talent_jobs WHERE id = ?").bind(linkId).run();
  return c.json({ ok: true });
});

export { pipeline as pipelineRoutes };
