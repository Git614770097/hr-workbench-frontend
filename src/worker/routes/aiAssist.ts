import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { deepseekJsonSafe, toStringArray } from "../ai";
import {
  checkQuota, loadLatestArtifact, loadRecentArtifact, maskPii, saveArtifact, truncate,
} from "../aiGuard";

// AI 提效接口：简历解读 / 沟通文案 / 面试问题 / 综合评估。
//
// 统一约定（四个接口都遵守，新增 AI 功能照抄这套即可）：
//   1) 一律走 deepseekJsonSafe——AI 超时/失败返回 null，各接口给降级响应，绝不 500 卡死业务流程
//   2) 一律先过 aiGuard：配额（10 次/日）+ 出域脱敏 + 输入截断
//   3) 结果写 ai_artifacts：同对象同场景 10 分钟内重复请求直接读缓存，不重复烧 token
//   4) 菜单权限在 index.ts 按 path 分流（talents / interviews），这里只做数据归属校验
//   5) AI 只出草稿：所有文案必须用户手动复制后才发出去，系统永不代发
const aiAssist = new Hono<{ Bindings: Env }>();

type BizType = "resume_insight" | "outreach" | "interview_questions" | "candidate_summary";

/** 沟通文案场景 */
const OUTREACH_SCENES = ["invite_call", "invite_wechat", "reject", "followup"] as const;
type OutreachScene = (typeof OUTREACH_SCENES)[number];

/** 婉拒信语气：默认温暖挽留型（保留关系、留后路），标准客气型供正式场合选用 */
const REJECT_TONES = ["warm", "polite"] as const;
type RejectTone = (typeof REJECT_TONES)[number];

/** 把人才字段拼成一段事实描述（脱敏后进 prompt） */
function talentBrief(t: Record<string, any>): string {
  const skills = Array.isArray(t.skills)
    ? t.skills.join("、")
    : typeof t.skills === "string"
      ? t.skills
      : "";
  const lines = [
    `姓名：${t.name || "未知"}`,
    `年龄/性别：${t.age != null ? `${t.age}岁` : "未知"} / ${t.gender || "未知"}`,
    `学历/院校：${t.education || "未知"} / ${t.school || "未知"}`,
    `当前公司/职位：${t.current_company || "未知"} / ${t.current_title || "未知"}`,
    `工作年限：${t.years_experience != null ? `${t.years_experience}年` : "未知"}`,
    `所在城市：${t.city || "未知"}`,
    `期望薪资：${t.expected_salary || "未填"}`,
    `技能：${skills || "未填"}`,
  ];
  return lines.join("\n");
}

/** 加载人才并校验归属；jobId 传了则一并校验岗位 */
async function loadContext(
  c: Context<{ Bindings: Env }>,
  session: { userId: string; role: string },
  talentId: string,
  jobId?: string | null
): Promise<{ talent: Record<string, any>; job: Record<string, any> | null } | Response> {
  const talent = await c.env.DB.prepare("SELECT * FROM talents WHERE id = ?").bind(talentId).first<any>();
  if (!talent) return c.json({ error: "人才不存在" }, 404);
  if (session.role !== "admin" && talent.owner_id !== session.userId) {
    return c.json({ error: "无权操作该人才" }, 403);
  }
  let job: Record<string, any> | null = null;
  if (jobId) {
    job = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<any>();
    if (!job) return c.json({ error: "岗位不存在" }, 404);
    if (session.role !== "admin" && job.owner_id !== session.userId) {
      return c.json({ error: "无权操作该岗位" }, 403);
    }
  }
  return { talent, job };
}

/**
 * 会话校验 + 缓存查询 + 配额校验。
 *
 * 顺序刻意安排：会话 → 缓存 → 配额。
 * 缓存命中**不经过配额**——读库不花 token，若因当日次数用尽就连已生成过的结果
 * 都看不了，用户会以为功能坏了。只有「真的要调 AI」才扣次数。
 */
async function sessionOnly(c: Context<{ Bindings: Env }>): Promise<{ userId: string; role: string } | Response> {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  return session;
}

/** 配额校验；通过返回 null，否则返回要直接 return 的 429 响应 */
async function quotaGuard(c: Context<{ Bindings: Env }>, userId: string): Promise<Response | null> {
  const quota = await checkQuota(c.env.DB, userId);
  if (!quota.ok) {
    return c.json(
      { error: `今日 AI 次数已用完（${quota.used}/${quota.limit}），明天自动重置`, code: "AI_QUOTA" },
      429
    );
  }
  return null;
}

function isResponse(v: unknown): v is Response {
  return typeof Response !== "undefined" && v instanceof Response;
}

// ---------------------------------------------------------------- 简历深度解读
// 两个入口：① 人才详情页（talent_id，可附简历原文 text）② 导入核对弹窗（未入库，只有 fields）
aiAssist.post("/resume-insight", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req
    .json<{
      talent_id?: string;
      job_id?: string | null;
      text?: string | null;
      pre_key?: string | null;
      fields?: Record<string, any> | null;
    }>()
    .catch(() => null);
  if (!body) return c.json({ error: "参数错误" }, 400);

  let talent: Record<string, any>;
  let job: Record<string, any> | null = null;
  let bizId: string;

  if (body.talent_id) {
    const ctx = await loadContext(c, session, body.talent_id, body.job_id);
    if (isResponse(ctx)) return ctx;
    talent = ctx.talent;
    job = ctx.job;
    bizId = ctx.talent.id;
  } else if (body.fields) {
    // 导入核对中的未入库记录：内容就在用户自己屏幕上，无需归属校验，仅受配额限制
    talent = body.fields;
    bizId = `pre:${body.pre_key || "unknown"}`;
  } else {
    return c.json({ error: "缺少人才信息" }, 400);
  }

  const scene = "";
  const cached = await loadRecentArtifact(c.env.DB, session.userId, "resume_insight", bizId, scene);
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId);
  if (denied) return denied;

  const apiKey = c.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法生成解读，请手动查看简历", code: "AI_NO_KEY" }, 500);
  }

  const system = `你是一名资深招聘顾问，擅长快速判断一份简历的价值与风险。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- highlights: 2-4 条亮点，每条不超过 30 字，必须基于给定事实
- risks: 0-3 条风险或需要在面试中验证的疑点（没有则空数组），每条不超过 30 字
- jd_fit: 传了目标岗位才给，否则给 null；格式 { "score": 0-100 的整数, "reasons": 2-3 条匹配/不匹配的理由 }
- suggestion: 一句话行动建议，不超过 40 字

要求：
1. 只基于给定信息判断，不要臆造经历或数字。
2. 信息不足就少给，jd_fit 的 score 不要给得虚高。
3. 语气务实，不吹捧、不贬低。`;

  const jdText = job
    ? `【目标岗位】\n岗位：${job.title}（${job.department || "部门未填"}）\n任职要求：${truncate(maskPii(job.requirements || job.description || ""), 1500) || "未填写"}`
    : "【目标岗位】\n（未指定岗位，做通用解读，jd_fit 给 null）";

  const resumeText = body.text ? truncate(maskPii(body.text)) : "";
  const userPrompt = `【人才信息】\n${talentBrief(talent)}\n\n${resumeText ? `【简历原文】\n${resumeText}` : "【简历原文】\n（未提供原文，仅依据上方字段判断，结论需保守）"}\n\n${jdText}\n\n请生成简历解读。`;

  const raw = await deepseekJsonSafe(apiKey, system, userPrompt, { temperature: 0.3 });
  if (!raw) {
    return c.json({ error: "AI 暂时不可用，请稍后重试或手动查看简历", code: "AI_UNAVAILABLE" }, 502);
  }

  const jdFitRaw = raw.jd_fit && typeof raw.jd_fit === "object" ? (raw.jd_fit as Record<string, any>) : null;
  const result = {
    highlights: toStringArray(raw.highlights, 4),
    risks: toStringArray(raw.risks, 3),
    jd_fit: jdFitRaw
      ? {
          score: Math.max(0, Math.min(100, Number(jdFitRaw.score) || 0)),
          reasons: toStringArray(jdFitRaw.reasons, 3),
        }
      : null,
    suggestion: typeof raw.suggestion === "string" ? raw.suggestion.slice(0, 60) : "",
  };

  await saveArtifact(c.env.DB, session.userId, "resume_insight", bizId, scene, result);
  return c.json(result);
});

// ---------------------------------------------------------------- 沟通文案
aiAssist.post("/outreach", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req
    .json<{
      talent_id: string;
      job_id?: string | null;
      scene: OutreachScene;
      tone?: RejectTone;
    }>()
    .catch(() => null);
  if (!body?.talent_id) return c.json({ error: "缺少人才信息" }, 400);
  if (!OUTREACH_SCENES.includes(body.scene)) return c.json({ error: "未知的文案场景" }, 400);

  const ctx = await loadContext(c, session, body.talent_id, body.job_id);
  if (isResponse(ctx)) return ctx;
  const { talent, job } = ctx;

  const scene = body.scene === "reject" ? `reject:${body.tone || "warm"}` : body.scene;
  const cached = await loadRecentArtifact(c.env.DB, session.userId, "outreach", talent.id, scene);
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId);
  if (denied) return denied;

  const apiKey = c.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法生成文案", code: "AI_NO_KEY" }, 500);
  }

  const sceneInstruction: Record<OutreachScene, string> = {
    invite_call:
      "生成一通电话邀约的口语脚本，结构：开场白 → 一句话介绍岗位与吸引点 → 确认候选人意向 → 约具体面试时间 → 收尾。要自然、像真人说话，不要书面腔。",
    invite_wechat:
      "生成一条微信邀约文案。150 字以内，礼貌不官腔，说清岗位、为什么找他、下一步约时间；结尾留一个容易回复的问题。",
    reject:
      body.tone === "polite"
        ? "生成一封标准客气型婉拒信：感谢投递、简要说明本轮竞争情况、保留联系方式、祝顺利。不贬低候选人，不做虚假承诺。"
        : "生成一封温暖挽留型婉拒信：先具体认可候选人某段经历或能力（要引用给定事实，不要空泛夸）→ 简要说明本轮情况（不透露他人信息、不贬低）→ 明确保留联系并说明后续有合适机会会再联系 → 祝福。语气真诚、有温度，像资深 HR 亲笔写，不像模板。严禁虚假承诺（如「肯定还会找你」「一定优先考虑」）。",
    followup:
      "生成一条跟进未回复候选人的话术：轻打扰、不施压，补一个新信息点（如面试安排进展/岗位新动态），给出明确且低成本的下一步（如「方便的话回个 Y/N」）。",
  };

  const system = `你是一名资深 HR，擅长写让候选人愿意回复的沟通文案。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- title: 文案标题（10 字以内，如「电话邀约脚本」）
- content: 文案正文
- tips: 1-3 条使用建议（如发送时机、注意事项），每条不超过 25 字

通用要求：
1. 基于给定的人才与岗位事实来写，不要编造薪资、福利、编制等信息。
2. 涉及未确认的条件（薪资、地点、时间）用「待沟通」或留空让 HR 填，不要替公司承诺。
3. 语气专业、平等，不居高临下。`;

  const jobText = job
    ? `目标岗位：${job.title}（${job.department || "部门未填"}），工作地 ${job.city || "待定"}，薪资范围 ${job.salary_range || "待沟通"}，要求：${truncate(maskPii(job.requirements || ""), 1200) || "未填写"}`
    : "目标岗位：暂未指定（按通用沟通话术写，HR 可自行补充岗位信息）";

  const userPrompt = `【候选人】\n${talentBrief(talent)}\n\n【${jobText}】\n\n【任务】\n${sceneInstruction[body.scene]}\n\n请生成文案。`;

  const raw = await deepseekJsonSafe(apiKey, system, userPrompt, { temperature: 0.5 });
  if (!raw) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }

  const result = {
    scene: body.scene,
    tone: body.scene === "reject" ? body.tone || "warm" : null,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 20) : "沟通文案",
    content: typeof raw.content === "string" ? raw.content.trim() : "",
    tips: toStringArray(raw.tips, 3),
  };
  if (!result.content) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }

  await saveArtifact(c.env.DB, session.userId, "outreach", talent.id, scene, result);
  return c.json(result);
});

// ---------------------------------------------------------------- 面试问题清单
aiAssist.post("/interview-questions", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req
    .json<{ talent_id: string; job_id?: string | null }>()
    .catch(() => null);
  if (!body?.talent_id) return c.json({ error: "缺少人才信息" }, 400);

  const ctx = await loadContext(c, session, body.talent_id, body.job_id);
  if (isResponse(ctx)) return ctx;
  const { talent, job } = ctx;

  const cached = await loadRecentArtifact(c.env.DB, session.userId, "interview_questions", talent.id, "");
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId);
  if (denied) return denied;

  const apiKey = c.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法生成面试题", code: "AI_NO_KEY" }, 500);
  }

  // 已有评价作为补充上下文：避免重复问已经问过/已验证过的点
  const past = await c.env.DB
    .prepare(
      `SELECT round, evaluation, dept_evaluation FROM interviews
       WHERE talent_id = ? AND (IFNULL(evaluation,'') <> '' OR IFNULL(dept_evaluation,'') <> '')
       ORDER BY created_at DESC LIMIT 3`
    )
    .bind(talent.id)
    .all<{ round: string; evaluation: string | null; dept_evaluation: string | null }>();
  const pastText = (past.results || [])
    .map((r) => `${r.round}：${truncate(maskPii(r.evaluation || r.dept_evaluation || ""), 400)}`)
    .filter((s) => !s.endsWith("："))
    .join("\n");

  const system = `你是一名资深面试官，擅长针对具体候选人与岗位设计面试问题。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- questions: 5-8 条面试问题，每条格式 { "q": "问题", "focus": "这道题在考察什么、怎样算答得好" }

要求：
1. 问题必须针对该候选人的经历与目标岗位的要求，不要问通用套话。
2. 至少 2 条是行为面试题（"请讲一次你…"），至少 1 条针对简历中存疑或需验证的点。
3. focus 不超过 40 字，写清楚考察点与判断标准。
4. 已经问过/已验证过的点不要重复（给出了历史评价时）。`;

  const jobText = job
    ? `目标岗位：${job.title}（${job.department || "部门未填"}）\n任职要求：${truncate(maskPii(job.requirements || job.description || ""), 1500) || "未填写"}`
    : "目标岗位：暂未指定（按候选人背景设计通用专业问题）";

  const userPrompt = `【候选人】\n${talentBrief(talent)}\n\n【${jobText}】\n\n${pastText ? `【历史面试评价（不要重复这些点）】\n${pastText}\n\n` : ""}请生成面试问题清单。`;

  const raw = await deepseekJsonSafe(apiKey, system, userPrompt, { temperature: 0.4 });
  if (!raw) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }

  const questions = Array.isArray(raw.questions)
    ? raw.questions
        .map((q: any) => ({
          q: typeof q?.q === "string" ? q.q.trim() : "",
          focus: typeof q?.focus === "string" ? q.focus.trim().slice(0, 60) : "",
        }))
        .filter((q: { q: string }) => q.q)
        .slice(0, 8)
    : [];
  if (!questions.length) {
    return c.json({ error: "AI 未生成有效问题，请重试", code: "AI_EMPTY" }, 502);
  }

  const result = { questions };
  await saveArtifact(c.env.DB, session.userId, "interview_questions", talent.id, "", result);
  return c.json(result);
});

// ---------------------------------------------------------------- 候选人综合评估
// 与 interviews 的 ai-summary 的区别：那个总结「一轮面试」，这个汇总「多轮 + 部门意见」，
// 输出结构保持一致，前端可复用同一套渲染。
aiAssist.post("/candidate-summary", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req
    .json<{ talent_id: string; job_id?: string | null }>()
    .catch(() => null);
  if (!body?.talent_id) return c.json({ error: "缺少人才信息" }, 400);

  const ctx = await loadContext(c, session, body.talent_id, body.job_id);
  if (isResponse(ctx)) return ctx;
  const { talent, job } = ctx;

  const cached = await loadRecentArtifact(c.env.DB, session.userId, "candidate_summary", talent.id, "");
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId);
  if (denied) return denied;

  const rows = await c.env.DB
    .prepare(
      `SELECT round, interviewer, result, score, evaluation, dept_result, dept_score, dept_evaluation
       FROM interviews WHERE talent_id = ? ORDER BY created_at ASC`
    )
    .bind(talent.id)
    .all<any>();

  const withEval = (rows.results || []).filter(
    (r: any) => (r.evaluation || "").trim() || (r.dept_evaluation || "").trim()
  );
  if (!withEval.length) {
    return c.json({ error: "该候选人还没有面试评价，请先在面试管理中填写", code: "AI_NO_INPUT" }, 400);
  }

  const apiKey = c.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法生成综合评估", code: "AI_NO_KEY" }, 500);
  }

  const ROUND_LABEL: Record<string, string> = {
    interview1: "初试", interview2: "复试", final: "终面",
  };
  const RESULT_LABEL: Record<string, string> = { pass: "通过", fail: "不通过", pending: "待定" };

  const system = `你是一名资深招聘负责人，擅长综合多轮面试意见给出录用建议。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- summary: 一句话综合结论，不超过 50 字
- strengths: 2-4 条候选人优势，每条不超过 30 字，必须引用评价中的事实
- risks: 1-3 条风险或不足，每条不超过 30 字
- recommendation: 推荐级别，四选一："强烈推荐" / "推荐" / "可考虑" / "不建议"
- suggested_result: 建议结论，三选一："pass" / "fail" / "pending"

要求：
1. 只基于给定评价归纳，不要臆造。
2. 各轮意见有分歧时，recommendation 取偏保守的一侧，并在 summary 里点出分歧。
3. 评价内容太少时少给，不要编造。`;

  const evalText = withEval
    .map((r: any) => {
      const parts = [
        `【${ROUND_LABEL[r.round] || r.round}】面试官：${r.interviewer || "未填"}`,
        `评分：${r.score ?? "未填"}　结论：${RESULT_LABEL[r.result] || "未填"}`,
        `评语：${truncate(maskPii(r.evaluation || ""), 600) || "未填"}`,
      ];
      if ((r.dept_evaluation || "").trim() || r.dept_result) {
        parts.push(
          `部门评分：${r.dept_score ?? "未填"}　部门结论：${RESULT_LABEL[r.dept_result] || "未填"}`,
          `部门评语：${truncate(maskPii(r.dept_evaluation || ""), 600) || "未填"}`
        );
      }
      return parts.join("\n");
    })
    .join("\n\n");

  const userPrompt = `【候选人】\n${talentBrief(talent)}\n\n${job ? `【目标岗位】${job.title}（${job.department || ""}）\n\n` : ""}【各轮面试评价】\n${evalText}\n\n请生成综合评估。`;

  const raw = await deepseekJsonSafe(apiKey, system, userPrompt, { temperature: 0.3 });
  if (!raw) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }

  const rec = ["强烈推荐", "推荐", "可考虑", "不建议"].includes(String(raw.recommendation))
    ? String(raw.recommendation)
    : "";
  const sug = ["pass", "fail", "pending"].includes(String(raw.suggested_result))
    ? String(raw.suggested_result)
    : "";

  const result = {
    summary: typeof raw.summary === "string" ? raw.summary.slice(0, 80) : "",
    strengths: toStringArray(raw.strengths, 4),
    risks: toStringArray(raw.risks, 3),
    recommendation: rec,
    suggested_result: sug,
    rounds: withEval.length,
  };

  await saveArtifact(c.env.DB, session.userId, "candidate_summary", talent.id, "", result);
  return c.json(result);
});

// ---------------------------------------------------------------- 读取已生成结果（GET）
// 下次进入页面时直接展示历史产出，不重算、不扣配额。
// 返回 { data: <上次结果或 null> }；data 带 _persisted 标记，前端据此标「已保存」。
async function requireTalent(
  c: Context<{ Bindings: Env }>,
  session: { userId: string; role: string },
  talentId?: string | null
): Promise<{ owner_id: string } | Response | null> {
  if (!talentId) return c.json({ error: "缺少 talent_id" }, 400);
  const row = await c.env.DB
    .prepare("SELECT id, owner_id FROM talents WHERE id = ?")
    .bind(talentId)
    .first<{ id: string; owner_id: string }>();
  if (!row) return c.json({ error: "人才不存在" }, 404);
  if (session.role !== "admin" && row.owner_id !== session.userId) {
    return c.json({ error: "无权操作该人才" }, 403);
  }
  return row;
}

function withPersisted(obj: Record<string, unknown> | null): { data: Record<string, unknown> | null } {
  if (!obj) return { data: null };
  return { data: { ...obj, _persisted: true } };
}

aiAssist.get("/resume-insight", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;
  const talentId = c.req.query("talent_id");
  const denied = await requireTalent(c, session, talentId);
  if (isResponse(denied)) return denied;
  const content = await loadLatestArtifact(c.env.DB, session.userId, "resume_insight", talentId!, "");
  return c.json(withPersisted(content));
});

aiAssist.get("/outreach", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;
  const talentId = c.req.query("talent_id");
  const denied = await requireTalent(c, session, talentId);
  if (isResponse(denied)) return denied;
  // scene 传了（如 reject:warm）按场景取；不传则取该人才最近一条任意场景
  const scene = c.req.query("scene");
  const content = await loadLatestArtifact(c.env.DB, session.userId, "outreach", talentId!, scene);
  return c.json(withPersisted(content));
});

aiAssist.get("/interview-questions", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;
  const talentId = c.req.query("talent_id");
  const denied = await requireTalent(c, session, talentId);
  if (isResponse(denied)) return denied;
  const content = await loadLatestArtifact(c.env.DB, session.userId, "interview_questions", talentId!, "");
  return c.json(withPersisted(content));
});

aiAssist.get("/candidate-summary", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;
  const talentId = c.req.query("talent_id");
  const denied = await requireTalent(c, session, talentId);
  if (isResponse(denied)) return denied;
  const content = await loadLatestArtifact(c.env.DB, session.userId, "candidate_summary", talentId!, "");
  return c.json(withPersisted(content));
});

export default aiAssist;
