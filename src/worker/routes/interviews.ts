import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { genId } from "../helpers";
import { moveStageForward } from "../talentFlow";

const interviews = new Hono<{ Bindings: Env }>();

// 面试轮次 / 方式 / 状态 / 结论的中文映射（与前端 types.ts 保持一致）
const ROUND_LABEL: Record<string, string> = { interview1: "初试", interview2: "复试", final: "终面" };
const MODE_LABEL: Record<string, string> = { online: "线上", onsite: "线下", phone: "电话" };
const STATUS_LABEL: Record<string, string> = { scheduled: "待面试", done: "已完成", cancelled: "已取消", no_show: "未到" };
const RESULT_LABEL: Record<string, string> = { pass: "通过", fail: "不通过", pending: "待定" };

/** 以中国时区取今天 YYYY-MM-DD，用于「今日/过期」判定 */
function todayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/** 附加派生字段：轮次/方式/状态/结论中文名、相对今天的天数、是否已过期 */
function decorate(r: any) {
  const today = todayYmd();
  const date = r.scheduled_at ? String(r.scheduled_at).slice(0, 10) : null;
  let daysFromToday: number | null = null;
  if (date) {
    const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const target = Date.UTC(+m[1], +m[2] - 1, +m[3]);
      const t = today.split("-").map(Number);
      daysFromToday = Math.round((target - Date.UTC(t[0], t[1] - 1, t[2])) / 86400000);
    }
  }
  return {
    ...r,
    round_label: ROUND_LABEL[r.round] || r.round,
    mode_label: MODE_LABEL[r.mode] || r.mode,
    status_label: STATUS_LABEL[r.status] || r.status,
    result_label: r.result ? RESULT_LABEL[r.result] || r.result : "",
    days_from_today: daysFromToday,
    is_today: daysFromToday === 0,
    is_overdue: daysFromToday !== null && daysFromToday < 0 && r.status === "scheduled",
  };
}

const SELECT_SQL = `
  SELECT iv.*,
         t.name as talent_name, t.phone as talent_phone, t.current_title, t.current_company,
         j.title as job_title, j.department as job_department,
         u.name as owner_name
  FROM interviews iv
  JOIN talents t ON iv.talent_id = t.id
  LEFT JOIN jobs j ON iv.job_id = j.id
  LEFT JOIN users u ON iv.owner_id = u.id
`;

/** 面试列表：支持按 talent_job_id / talent_id / job_id 过滤、status 过滤、按时间排序 */
interviews.get("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  // owner_id 隔离：普通用户只看自己安排的面试，管理员可看全部或按创建人过滤
  if (session.role !== "admin") {
    conditions.push("iv.owner_id = ?");
    params.push(session.userId);
  } else {
    const ownerId = c.req.query("owner_id");
    if (ownerId) { conditions.push("iv.owner_id = ?"); params.push(ownerId); }
  }

  const talentJobId = c.req.query("talent_job_id");
  if (talentJobId) { conditions.push("iv.talent_job_id = ?"); params.push(talentJobId); }

  const talentId = c.req.query("talent_id");
  if (talentId) { conditions.push("iv.talent_id = ?"); params.push(talentId); }

  const jobId = c.req.query("job_id");
  if (jobId) { conditions.push("iv.job_id = ?"); params.push(jobId); }

  const status = c.req.query("status");
  if (status) { conditions.push("iv.status = ?"); params.push(status); }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
  const rows = await c.env.DB.prepare(
    `${SELECT_SQL} ${where} ORDER BY (iv.scheduled_at IS NULL), iv.scheduled_at ASC, iv.created_at DESC`
  ).bind(...params).all();

  return c.json({ items: (rows.results || []).map(decorate) });
});

/** 单条面试详情 */
interviews.get("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const row = await c.env.DB.prepare(`${SELECT_SQL} WHERE iv.id = ?`).bind(c.req.param("id")).first();
  if (!row) return c.json({ error: "面试记录不存在" }, 404);
  if (session.role !== "admin" && (row as any).owner_id !== session.userId) {
    return c.json({ error: "无权限查看该面试记录" }, 403);
  }
  return c.json(decorate(row));
});

/** 面试结论填「通过」时自动推进到的阶段：初试通过→复试；复试/终面通过→Offer */
const PASS_TARGET: Record<string, "interview2" | "offer"> = {
  interview1: "interview2",
  interview2: "offer",
  final: "offer",
};

/**
 * 面试「通过」→ 自动推进看板阶段。
 * 之前面试结论只存在 interviews 表里，看板阶段纹丝不动，HR 还得手动去拖一遍卡片，
 * 面试与流程是两套并行的记录。这里把它接上（只前进，不后退，也不会把已淘汰的人拉回来）。
 */
async function advanceOnInterviewPass(
  env: Env,
  opts: { talentJobId: string | null; round: string; userId: string; talentName: string }
): Promise<string | null> {
  if (!opts.talentJobId) return null;
  const target = PASS_TARGET[opts.round];
  if (!target) return null;
  try {
    const mv = await moveStageForward(env.DB, {
      linkId: opts.talentJobId,
      toStage: target,
      userId: opts.userId,
      remark: "面试通过，系统自动推进",
    });
    return mv.moved ? target : null;
  } catch {
    return null;
  }
}

interface Body {  talent_id?: string;
  job_id?: string | null;
  talent_job_id?: string | null;
  round?: string;
  mode?: string;
  scheduled_at?: string | null;
  duration?: number;
  location?: string | null;
  meeting_url?: string | null;
  interviewer?: string | null;
  status?: string;
  result?: string | null;
  score?: number | null;
  evaluation?: string | null;
}

/** 新建面试安排 */
interviews.post("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  let b: Body;
  try { b = await c.req.json(); } catch { return c.json({ error: "请求参数格式不正确" }, 400); }

  if (!b.talent_id) return c.json({ error: "请选择候选人" }, 400);

  // 校验候选人存在且属于当前用户（admin 也只能挂自己的候选人，避免跨账号串数据）
  const talent = await c.env.DB.prepare("SELECT id, owner_id FROM talents WHERE id = ?")
    .bind(b.talent_id).first<{ id: string; owner_id: string }>();
  if (!talent) return c.json({ error: "候选人不存在" }, 404);
  if (talent.owner_id !== session.userId) return c.json({ error: "无权操作该候选人" }, 403);

  // 线上必须有会议链接，线下必须有地点，否则提醒出去也无法执行
  const mode = b.mode || "online";
  const meetingUrl = (b.meeting_url || "").trim();
  const location = (b.location || "").trim();
  if (mode === "online" && !meetingUrl) return c.json({ error: "线上面试请填写会议链接" }, 400);
  if (mode === "onsite" && !location) return c.json({ error: "线下面试请填写面试地点" }, 400);

  const id = genId();
  // 直接填了面试结论（说明面试已发生）→ 状态自动落「已完成」，不再是「待面试」
  const initStatus = b.result && (b.status || "scheduled") === "scheduled" ? "done" : (b.status || "scheduled");
  await c.env.DB.prepare(`
    INSERT INTO interviews (id, owner_id, talent_id, job_id, talent_job_id, round, mode, scheduled_at,
                            duration, location, meeting_url, interviewer, status, result, score, evaluation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    session.userId,
    b.talent_id,
    b.job_id || null,
    b.talent_job_id || null,
    b.round || "interview1",
    mode,
    (b.scheduled_at || "").trim() || null,
    b.duration ?? 60,
    location || null,
    meetingUrl || null,
    (b.interviewer || "").trim() || null,
    initStatus,
    b.result || null,
    b.score ?? null,
    (b.evaluation || "").trim() || null
  ).run();

  const row = await c.env.DB.prepare(`${SELECT_SQL} WHERE iv.id = ?`).bind(id).first();
  const advancedTo = b.result === "pass"
    ? await advanceOnInterviewPass(c.env, {
        talentJobId: b.talent_job_id || null,
        round: b.round || "interview1",
        userId: session.userId,
        talentName: (row as any)?.talent_name || "",
      })
    : null;
  return c.json({ ok: true, item: decorate(row), advanced_to: advancedTo });
});

/** 更新面试（含填写评价：结果/评分/评语） */
interviews.put("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  const exist = await c.env.DB.prepare("SELECT * FROM interviews WHERE id = ?").bind(id).first<any>();
  if (!exist) return c.json({ error: "面试记录不存在" }, 404);
  if (exist.owner_id !== session.userId) return c.json({ error: "无权操作该面试记录" }, 403);

  let b: Body;
  try { b = await c.req.json(); } catch { return c.json({ error: "请求参数格式不正确" }, 400); }

  // 线上/线下必填项在编辑时同样校验（以本次提交的值为准，未提交则沿用原值）
  const mode = b.mode ?? exist.mode;
  const meetingUrl = (b.meeting_url ?? exist.meeting_url ?? "").trim();
  const location = (b.location ?? exist.location ?? "").trim();
  if (mode === "online" && !meetingUrl) return c.json({ error: "线上面试请填写会议链接" }, 400);
  if (mode === "onsite" && !location) return c.json({ error: "线下面试请填写面试地点" }, 400);

  // 填了面试结论即视为面试已发生 → 待面试自动落为「已完成」，避免看板一直挂着过期面试
  const submittedStatus = b.status ?? exist.status;
  const finalStatus = b.result && submittedStatus === "scheduled" ? "done" : submittedStatus;

  await c.env.DB.prepare(`
    UPDATE interviews SET
      round = ?, mode = ?, scheduled_at = ?, duration = ?, location = ?, meeting_url = ?,
      interviewer = ?, status = ?, result = ?, score = ?, evaluation = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    b.round ?? exist.round,
    mode,
    (b.scheduled_at ?? exist.scheduled_at ?? "").trim() || null,
    b.duration ?? exist.duration ?? 60,
    location || null,
    meetingUrl || null,
    (b.interviewer ?? exist.interviewer ?? "").trim() || null,
    finalStatus,
    (b.result ?? exist.result) || null,
    b.score ?? exist.score ?? null,
    (b.evaluation ?? exist.evaluation ?? "").trim() || null,
    id
  ).run();

  const row = await c.env.DB.prepare(`${SELECT_SQL} WHERE iv.id = ?`).bind(id).first();

  // 结论为「通过」→ 自动推进看板阶段（初试→复试 / 复试·终面→Offer）
  const advancedTo = (b.result ?? exist.result) === "pass"
    ? await advanceOnInterviewPass(c.env, {
        talentJobId: (row as any)?.talent_job_id ?? exist.talent_job_id ?? null,
        round: (b.round ?? exist.round) as string,
        userId: session.userId,
        talentName: (row as any)?.talent_name || "",
      })
    : null;

  return c.json({ ok: true, item: decorate(row), advanced_to: advancedTo });
});

/** 删除面试记录 */
interviews.delete("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  const exist = await c.env.DB.prepare("SELECT owner_id FROM interviews WHERE id = ?").bind(id).first<{ owner_id: string }>();
  if (!exist) return c.json({ error: "面试记录不存在" }, 404);
  if (exist.owner_id !== session.userId) return c.json({ error: "无权操作该面试记录" }, 403);
  await c.env.DB.prepare("DELETE FROM interviews WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

export { interviews as interviewRoutes };
