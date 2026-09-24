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
           l.from_stage, l.to_stage, l.created_at AS log_at
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
  for (const r of rows.results as any[]) {
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
  if (dup) return c.json({ error: "该人才已在此岗位的招聘流程中" }, 409);

  const id = genId();
  const stage: Stage = STAGES.includes(body.stage as Stage) ? (body.stage as Stage) : "screening";
  await c.env.DB.prepare("INSERT INTO talent_jobs (id, talent_id, job_id, stage, notes) VALUES (?, ?, ?, ?, ?)")
    .bind(id, body.talent_id, body.job_id, stage, body.notes || null).run();

  await c.env.DB.prepare("INSERT INTO job_stage_logs (id, talent_job_id, from_stage, to_stage, user_id, remark) VALUES (?, ?, NULL, ?, ?, ?)")
    .bind(genId(), id, stage, session.userId, "加入招聘流程").run();

  // 同步人才全局阶段（若是新录入状态）
  await c.env.DB.prepare("UPDATE talents SET stage = CASE WHEN stage IN ('new','archived') OR stage IS NULL THEN ? ELSE stage END, updated_at = datetime('now') WHERE id = ?")
    .bind(stage === "screening" ? "screening" : stage, body.talent_id).run();

  return c.json({ id, talent_name: talent.name, job_title: job.title, stage });
});

// ---- 切换候选人阶段（看板拖拽 / 下拉）----
pipeline.put("/:linkId/stage", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const linkId = c.req.param("linkId");
  const body = await c.req.json<{ stage?: string; remark?: string; rating?: number }>();
  if (!body.stage || !STAGES.includes(body.stage as Stage)) return c.json({ error: "阶段值不合法" }, 400);

  // 权限校验
  const link = await c.env.DB.prepare(`
    SELECT tj.id, tj.stage as old_stage, tj.talent_id, tj.job_id, t.owner_id
    FROM talent_jobs tj JOIN talents t ON tj.talent_id = t.id WHERE tj.id = ?
  `).bind(linkId).first<any>();
  if (!link) return c.json({ error: "候选人记录不存在" }, 404);
  if (session.role !== "admin" && link.owner_id !== session.userId) {
    return c.json({ error: "无权限" }, 403);
  }
  if (link.old_stage === body.stage) return c.json({ ok: true, stage: body.stage });

  await c.env.DB.prepare("UPDATE talent_jobs SET stage = ?, rating = COALESCE(?, rating), updated_at = datetime('now') WHERE id = ?")
    .bind(body.stage, body.rating ?? null, linkId).run();

  await c.env.DB.prepare("INSERT INTO job_stage_logs (id, talent_job_id, from_stage, to_stage, user_id, remark) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(genId(), linkId, link.old_stage, body.stage, session.userId, body.remark || null).run();

  // 阶段推进到「已入职」时，同步人才全局状态为 placed（已入职）
  if (body.stage === "hired") {
    await c.env.DB.prepare("UPDATE talents SET status = 'placed', stage = 'hired', updated_at = datetime('now') WHERE id = ?")
      .bind(link.talent_id).run();
  }

  return c.json({ ok: true, stage: body.stage });
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
