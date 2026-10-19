import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { ownerScope, scopeConds, scopeParams, canTouch } from "../scope";
import { deepseekJsonWithUsage, toStringArray } from "../ai";
import { encryptAiKey, loadOwnKeyInfo, looksLikeDeepSeekKey, maskAiKey, resolveAiKey, verifyDeepSeekKey } from "../aiKey";
import {
  AI_QUOTA_SETTING_KEY, checkQuota, loadDailyLimit, loadLatestArtifact, loadRecentArtifact,
  maskPii, saveArtifact, truncate,
} from "../aiGuard";

// AI 提效接口：简历解读 / 沟通文案 / 面试问题 / 综合评估。
//
// 统一约定（四个接口都遵守，新增 AI 功能照抄这套即可）：
//   1) 一律走 deepseekJsonWithUsage——AI 超时/失败返回 null，各接口给降级响应，绝不 500 卡死业务流程；
//      同时带回 token 用量（_usage），前端展示「本次燃烧多少 token」，让用户对成本有感知
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
  if (!(await canTouch(c.env, session, talent.owner_id))) {
    return c.json({ error: "无权操作该人才" }, 403);
  }
  let job: Record<string, any> | null = null;
  if (jobId) {
    job = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<any>();
    if (!job) return c.json({ error: "岗位不存在" }, 404);
    if (!(await canTouch(c.env, session, job.owner_id))) {
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

/**
 * 配额校验；通过返回 null，否则返回要直接 return 的 429 响应。
 * 管理员不限额（checkQuota 直接放行）；普通用户上限取系统设置里的配置。
 */
async function quotaGuard(
  c: Context<{ Bindings: Env }>,
  userId: string,
  role?: string
): Promise<Response | null> {
  // 自带 Key 的用户花自己的钱，不占系统配额，直接放行（配额只保护系统 Key 的账单）
  const { own } = await resolveAiKey(c.env, userId);
  if (own) return null;
  const quota = await checkQuota(c.env.DB, userId, role);
  if (!quota.ok) {
    return c.json(
      {
        error: `今日 AI 次数已用完（${quota.used}/${quota.limit}）——配置自己的 DeepSeek Key 立即可继续使用，不占系统配额`,
        code: "AI_QUOTA",
      },
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
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = (await resolveAiKey(c.env, session.userId)).key;
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

  const gen = await deepseekJsonWithUsage(apiKey, system, userPrompt, { temperature: 0.3 });
  if (!gen) {
    return c.json({ error: "AI 暂时不可用，请稍后重试或手动查看简历", code: "AI_UNAVAILABLE" }, 502);
  }
  const raw = gen.data;

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

  await saveArtifact(c.env.DB, session.userId, "resume_insight", bizId, scene, { ...result, _usage: gen.usage ?? null });
  return c.json({ ...result, _usage: gen.usage ?? null });
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
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = (await resolveAiKey(c.env, session.userId)).key;
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

  const gen = await deepseekJsonWithUsage(apiKey, system, userPrompt, { temperature: 0.5 });
  if (!gen) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }
  const raw = gen.data;

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

  await saveArtifact(c.env.DB, session.userId, "outreach", talent.id, scene, { ...result, _usage: gen.usage ?? null });
  return c.json({ ...result, _usage: gen.usage ?? null });
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
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = (await resolveAiKey(c.env, session.userId)).key;
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

  const gen = await deepseekJsonWithUsage(apiKey, system, userPrompt, { temperature: 0.4 });
  if (!gen) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }
  const raw = gen.data;

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
  await saveArtifact(c.env.DB, session.userId, "interview_questions", talent.id, "", { ...result, _usage: gen.usage ?? null });
  return c.json({ ...result, _usage: gen.usage ?? null });
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
  const denied = await quotaGuard(c, session.userId, session.role);
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

  const apiKey = (await resolveAiKey(c.env, session.userId)).key;
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

  const gen = await deepseekJsonWithUsage(apiKey, system, userPrompt, { temperature: 0.3 });
  if (!gen) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }
  const raw = gen.data;

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

  await saveArtifact(c.env.DB, session.userId, "candidate_summary", talent.id, "", { ...result, _usage: gen.usage ?? null });
  return c.json({ ...result, _usage: gen.usage ?? null });
});

// ---------------------------------------------------------------- 岗位信息 AI 起草
// 新增岗位表单「AI 一键起草」：基于岗位名称（+部门/城市）生成职责、要求、薪资建议、学历、经验。
// 复用统一护栏（配额 / 缓存 / 脱敏 / 截断）与 deepseekJsonWithUsage；岗位尚未创建，仅需会话即可。
aiAssist.post("/job-draft", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req
    .json<{ title?: string; department?: string | null; city?: string | null; mode?: string; description?: string; requirements?: string }>()
    .catch(() => null);
  const title = (body?.title || "").trim();
  if (!title) return c.json({ error: "请先填写岗位名称，再点 AI 一键起草" }, 400);
  // optimize：编辑已有 JD 时的「AI 优化文案」——只改写表达保留事实，缓存键与起草分开
  const optimize = body?.mode === "optimize";

  const bizId = `${optimize ? "opt" : "job"}:${title}`;
  const scene = "";
  const cached = await loadRecentArtifact(c.env.DB, session.userId, "job_draft", bizId, scene);
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = (await resolveAiKey(c.env, session.userId)).key;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法起草岗位，请手动填写", code: "AI_NO_KEY" }, 500);
  }

  const ctx = [
    `岗位名称：${title}`,
    body?.department ? `用人部门：${truncate(maskPii(body.department), 60)}` : "",
    body?.city ? `工作城市：${body.city}` : "",
  ].filter(Boolean).join("\n");

  const system = optimize
    ? `你是一名资深招聘顾问，负责优化已有的岗位 JD 文案。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- description: 优化后的岗位职责——在原稿基础上改写：动词开头、结构清晰、突出重点，6-10 条每条一行，每条不超过 40 字
- requirements: 优化后的任职要求——合并冗余表述、补齐明显缺失项，5-8 条每条一行，每条不超过 40 字

要求：
1. 保留原稿中的确定事实（技术栈、薪资、经验门槛），不要编造新的要求或福利。
2. 优化的是表达与结构，不是改岗位本身；不要输出 salary/education/experience 建议。
3. description / requirements 输出纯文本，每条一行。`
    : `你是一名资深招聘顾问，擅长撰写岗位 JD 并给出合理的任职门槛建议。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- description: 岗位职责，6-10 条，每条一行，聚焦该岗位实际工作内容，具体可执行，不超过 40 字
- requirements: 任职要求，5-8 条，每条一行，涵盖学历、经验、技能与软素质，不超过 40 字
- salary_range: 薪资范围建议，格式如 "25-40K·14薪" 或 "面议"；行业信息不足时给大致区间并标注「建议」
- education: 学历要求，四选一："大专" / "本科" / "硕士" / "博士"（复合要求取最低门槛，本科以上给"本科"即可）
- experience: 经验要求，如 "3-5年" / "1-3年" / "5年以上"，简要即可

要求：
1. 只基于岗位名称与所给上下文推断，常见行业惯例可引用；薪资、福利等不确定项不要编造具体数字，用区间或"面议"。
2. 职责与要求要贴合该岗位真实日常，避免放之四海皆准的套话。
3. 不要回写岗位名称、部门、城市等用户已填的信息。`;

  const userPrompt = optimize
    ? `【岗位上下文】\n${ctx}\n\n【原稿·岗位职责】\n${truncate(maskPii((body?.description || "").trim()), 800) || "（空）"}\n\n【原稿·任职要求】\n${truncate(maskPii((body?.requirements || "").trim()), 800) || "（空）"}\n\n请优化这两段文案。`
    : `【岗位上下文】\n${ctx}\n\n请生成该岗位的岗位职责、任职要求，并给出学历 / 经验 / 薪资门槛建议。`;

  const gen = await deepseekJsonWithUsage(apiKey, system, userPrompt, { temperature: 0.4 });
  if (!gen) {
    return c.json({ error: "AI 暂时不可用，请稍后重试或手动填写", code: "AI_UNAVAILABLE" }, 502);
  }
  const raw = gen.data;

  const toLines = (v: unknown): string =>
    Array.isArray(v)
      ? v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean).join("\n")
      : typeof v === "string"
        ? v.trim()
        : "";

  const EDU = ["大专", "本科", "硕士", "博士"];
  const eduRaw = typeof raw.education === "string" ? raw.education.trim() : "";
  const education = EDU.find((e) => eduRaw.includes(e)) || "";

  const result = optimize
    ? {
        description: toLines(raw.description),
        requirements: toLines(raw.requirements),
        salary_range: "",
        education: "",
        experience: "",
      }
    : {
        description: toLines(raw.description),
        requirements: toLines(raw.requirements),
        salary_range: typeof raw.salary_range === "string" ? raw.salary_range.trim().slice(0, 40) : "",
        education,
        experience: typeof raw.experience === "string" ? raw.experience.trim().slice(0, 20) : "",
      };
  await saveArtifact(c.env.DB, session.userId, "job_draft", bizId, scene, { ...result, _usage: gen.usage ?? null });
  return c.json({ ...result, _usage: gen.usage ?? null });
});

// ---------------------------------------------------------------- AI 入职清单生成
// 按候选人入职上下文（岗位/部门/城市/年限）生成材料清单初稿，前端预览勾选后批量入库。
// AI 只起草，入库动作由人在前端确认；scope = talent_id，10 分钟缓存。
aiAssist.post("/onboard-checklist", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req.json<{ talent_id?: string }>().catch(() => null);
  const talentId = (body?.talent_id || "").trim();
  if (!talentId) return c.json({ error: "请先选择候选人" }, 400);

  const t = await c.env.DB.prepare("SELECT id, owner_id, name, years_experience FROM talents WHERE id = ?")
    .bind(talentId).first<any>();
  if (!t) return c.json({ error: "候选人不存在" }, 404);
  if (!(await canTouch(c.env, session, t.owner_id))) {
    return c.json({ error: "无权为该候选人生成清单" }, 403);
  }

  // 入职上下文：优先取已入职（hired）的投递关联岗位，无则取最近一条关联岗位
  const tj = await c.env.DB.prepare(`
    SELECT j.title AS job_title, j.department AS job_dept, j.city AS job_city
    FROM talent_jobs tj JOIN jobs j ON j.id = tj.job_id
    WHERE tj.talent_id = ?
    ORDER BY (tj.stage = 'hired') DESC, tj.updated_at DESC
    LIMIT 1
  `).bind(talentId).first<any>();

  const scope = talentId.slice(0, 120);
  const cached = await loadRecentArtifact(c.env.DB, session.userId, "onboard_checklist", scope, "");
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = (await resolveAiKey(c.env, session.userId)).key;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法生成清单", code: "AI_NO_KEY" }, 500);
  }

  const report = {
    候选人: { 姓名: maskPii(t.name || ""), 工作年限: t.years_experience != null ? `${t.years_experience}年` : "未知" },
    入职岗位: tj ? { 名称: tj.job_title || "", 部门: tj.job_dept || "", 城市: tj.job_city || "" } : null,
  };

  const system = `你是一名资深 HR，为新员工生成入职材料清单初稿。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- items: 材料清单，8-15 项，每项：
  - name: 材料名称，不超过 20 字，如「劳动合同（一式两份）」「学历学位证明」
  - category: 分组，四选一："证件材料" / "协议合同" / "公司事项" / "其他"
  - required: 是否必交（true/false）；身份证、合同类必交，体检报告、照片等可选

生成依据：
1. 通用必备：身份证明、学历证明、银行卡、照片、体检报告；
2. 协议合同：正式员工给劳动合同；工作年限为 0 或在校场景考虑实习协议；
3. 离职证明：有工作经验的必列；
4. 结合岗位特征补充（如异地入职考虑居住证明/社保转移，销售岗考虑客户资源交接说明）；
5. 不确定的按常规给，宁多勿漏——前端会让人勾选裁剪。`;

  const userPrompt = `【入职上下文】\n${truncate(JSON.stringify(report), 800)}\n\n请生成入职材料清单初稿。`;

  const gen = await deepseekJsonWithUsage(apiKey, system, userPrompt, { temperature: 0.3 });
  if (!gen) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }
  const raw = gen.data;

  // 清洗：白名单分组兜底、名称去空去重、上限 15 条
  const CATS = ["证件材料", "协议合同", "公司事项", "其他"];
  const seen = new Set<string>();
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map((x: any) => ({
      name: String(x?.name || "").trim().slice(0, 40),
      category: CATS.includes(String(x?.category || "")) ? String(x.category) : "其他",
      required: !!x?.required,
    }))
    .filter((x: any) => x.name && !seen.has(x.name) && seen.add(x.name))
    .slice(0, 15);
  if (!items.length) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }

  const result = { items };
  await saveArtifact(c.env.DB, session.userId, "onboard_checklist", scope, "", { ...result, _usage: gen.usage ?? null });
  return c.json({ ...result, _usage: gen.usage ?? null });
});

// ---------------------------------------------------------------- AI 人才储备盘点
// 「库视角」盘点：按当前筛选口径聚合人才结构（状态/来源/城市/年限/技能标签），AI 讲结论。
// 与招聘复盘分工：复盘管流程、盘点管储备。后端自查聚合，scope = 筛选指纹，10 分钟缓存。
aiAssist.post("/talent-inventory", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const str = (k: string) => String(body?.[k] ?? "").trim().slice(0, 80);
  const q = str("q"), group = str("group"), status = str("status"),
    city = str("city"), tags = str("tags"), title = str("title"), education = str("education");

  // 筛选条件与 talents 列表接口同构（owner 隔离 + 同名字段同写法），保证盘点口径与列表所见一致
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  conditions.push(...scopeConds(session, "t.owner_id"));
  params.push(...scopeParams(session));
  if (q) {
    conditions.push("(t.name LIKE ? OR t.current_company LIKE ? OR t.current_title LIKE ? OR t.skills LIKE ? OR t.industry LIKE ? OR t.notes LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }
  if (title) { conditions.push("t.current_title LIKE ?"); params.push(`%${title}%`); }
  if (education) { conditions.push("t.education LIKE ?"); params.push(`%${education}%`); }
  if (status && !group) { conditions.push("t.status = ?"); params.push(status); }
  if (city) { conditions.push("t.city LIKE ?"); params.push(`%${city}%`); }
  if (tags) { conditions.push("t.tags LIKE ?"); params.push(`%${tags}%`); }
  if (group) {
    // 快捷分组语义与 talents 列表一致（group 与单值 status 互斥）
    if (group === "active_pipeline") {
      conditions.push("EXISTS (SELECT 1 FROM talent_jobs tj WHERE tj.talent_id = t.id AND tj.stage IN ('screening','interview1','interview2','offer'))");
    } else if (group === "interviewed") {
      conditions.push("EXISTS (SELECT 1 FROM interviews iv JOIN talent_jobs tj ON iv.talent_job_id = tj.id WHERE tj.talent_id = t.id) OR EXISTS (SELECT 1 FROM talent_jobs tj WHERE tj.talent_id = t.id AND tj.stage IN ('interview1','interview2'))");
    } else if (group === "placed") {
      conditions.push("(t.status = 'placed' OR t.stage = 'hired')");
    } else if (group === "left") {
      conditions.push("(t.resignation_date IS NOT NULL AND t.resignation_date <> '')");
    } else if (group === "ended") {
      conditions.push("t.stage IN ('rejected','withdrawn')");
    } else if (group === "inactive") {
      conditions.push("((t.stage = 'archived' OR NOT EXISTS (SELECT 1 FROM talent_jobs tj WHERE tj.talent_id = t.id)) AND t.status <> 'placed' AND (t.resignation_date IS NULL OR t.resignation_date = ''))");
    }
  }
  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  const db = c.env.DB;
  const [countRow, statusRows, sourceRows, cityRows, bucketRow, sampleRows, jobRows] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS n FROM talents t ${where}`).bind(...params).first<{ n: number }>(),
    db.prepare(`SELECT t.status AS k, COUNT(*) AS n FROM talents t ${where} GROUP BY t.status`).bind(...params).all(),
    db.prepare(`SELECT t.source AS k, COUNT(*) AS n FROM talents t ${where} GROUP BY t.source`).bind(...params).all(),
    db.prepare(`SELECT t.city AS k, COUNT(*) AS n FROM talents t ${where} GROUP BY t.city`).bind(...params).all(),
    db.prepare(`
      SELECT
        SUM(CASE WHEN t.years_experience IS NULL THEN 1 ELSE 0 END) AS unk,
        SUM(CASE WHEN t.years_experience < 1 THEN 1 ELSE 0 END) AS y0,
        SUM(CASE WHEN t.years_experience >= 1 AND t.years_experience < 3 THEN 1 ELSE 0 END) AS y1,
        SUM(CASE WHEN t.years_experience >= 3 AND t.years_experience < 5 THEN 1 ELSE 0 END) AS y3,
        SUM(CASE WHEN t.years_experience >= 5 AND t.years_experience < 10 THEN 1 ELSE 0 END) AS y5,
        SUM(CASE WHEN t.years_experience >= 10 THEN 1 ELSE 0 END) AS y10
      FROM talents t ${where}
    `).bind(...params).first<any>(),
    // 技能/标签词频：取前 300 条样本在 JS 侧统计（skills/tags 为 JSON 数组字符串，SQL 不便聚合）
    db.prepare(`SELECT t.skills, t.tags FROM talents t ${where} ORDER BY t.updated_at DESC LIMIT 300`).bind(...params).all<{ skills: string | null; tags: string | null }>(),
    // 在招岗位（与 jobs 列表同规则数据范围隔离），用于缺口对比
    // sc.sql 以「 AND ...」开头，直接接在 status = 'open' 之后即合法；
    // 之前用 slice(4) 把「 AND」去掉又没补回来，非管理员会拼出非法 SQL（必 500）
    ...(() => { const sc = ownerScope(session); return [db.prepare(`SELECT title, city, priority FROM jobs WHERE status = 'open' ${sc.sql} ORDER BY created_at DESC LIMIT 20`).bind(...sc.params).all()]; })(),
  ]);

  const total = countRow?.n || 0;
  if (total === 0) {
    return c.json({ error: "当前筛选条件下没有人才，先调整筛选再盘点", code: "AI_EMPTY_INPUT" }, 400);
  }

  // 技能/标签词频 Top10（从样本 JSON 解析，脏 JSON 忽略）
  const skillFreq = new Map<string, number>();
  for (const row of sampleRows.results || []) {
    for (const raw of [row.skills, row.tags]) {
      if (!raw) continue;
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          for (const s of arr) {
            const v = String(s || "").trim();
            if (v) skillFreq.set(v, (skillFreq.get(v) || 0) + 1);
          }
        }
      } catch { /* 脏 JSON 忽略 */ }
    }
  }
  const topSkills = [...skillFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([k, n]) => `${k}(${n})`);

  const topN = (rows: { results?: any[] }) =>
    (rows.results || [])
      .filter((r) => r.k)
      .sort((a, b) => b.n - a.n)
      .slice(0, 6)
      .map((r) => `${r.k}(${r.n})`)
      .join("、") || "（无）";

  const yr = bucketRow || {};
  const yearsText = `未知(${yr.unk || 0})、1年以下(${yr.y0 || 0})、1-3年(${yr.y1 || 0})、3-5年(${yr.y3 || 0})、5-10年(${yr.y5 || 0})、10年以上(${yr.y10 || 0})`;

  const report = {
    筛选口径: { 关键词: q || "（全部）", 分组: group || "", 状态: status || "", 城市: city || "", 标签: tags || "", 职位: title || "", 学历: education || "" },
    命中总量: total,
    状态分布: topN(statusRows),
    来源分布: topN(sourceRows),
    城市分布: topN(cityRows),
    年限分布: yearsText,
    技能标签Top10_基于前300条样本: topSkills.join("、") || "（样本中无技能/标签）",
    在招岗位: (jobRows.results || []).map((j: any) => `${j.title}${j.city ? `·${j.city}` : ""}`),
  };

  const scope = truncate(JSON.stringify(report), 120);
  const cached = await loadRecentArtifact(c.env.DB, session.userId, "talent_inventory", scope, "");
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId);
  if (denied) return denied;

  const apiKey = (await resolveAiKey(c.env, session.userId)).key;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法生成盘点", code: "AI_NO_KEY" }, 500);
  }

  const system = `你是一名资深 HRBP，为 HR 主管生成「人才储备盘点」简报。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- profile: 一段储备画像，不超过 110 字——总量、结构特征（状态/来源/年限/城市/技能）、值得注意的点，用具体数字
- gaps: 0-3 条储备缺口，每条不超过 40 字，必须引用数据对比（如「在招 X 岗位，库内相关人才仅 N 人」）；没有明显缺口就给空数组，不要硬凑
- actions: 2-3 条可执行的储备运营建议（激活沉睡人才/定向补充渠道/调整筛选策略），每条不超过 40 字，禁止「加强」「优化」式空话

要求：
1. 只基于给定数据，样本有限的（技能标签基于前 300 条样本）要如实说明局限。
2. 状态分布里的英文状态含义：new=新入库、screening=初筛中、placed=已入职、left=已离职、blocked=暂不合适、archived=已归档。`;

  const userPrompt = `【人才库统计】\n${truncate(JSON.stringify(report), 2800)}\n\n请生成人才储备盘点。`;

  const gen = await deepseekJsonWithUsage(apiKey, system, userPrompt, { temperature: 0.3 });
  if (!gen) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }
  const raw = gen.data;

  const result = {
    profile: typeof raw.profile === "string" ? raw.profile.trim().slice(0, 160) : "",
    gaps: toStringArray(raw.gaps, 3),
    actions: toStringArray(raw.actions, 3),
  };
  if (!result.profile) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }

  await saveArtifact(c.env.DB, session.userId, "talent_inventory", scope, "", { ...result, _usage: gen.usage ?? null });
  return c.json({ ...result, _usage: gen.usage ?? null });
});

// ---------------------------------------------------------------- AI 岗位诊断
// 单岗位「为什么招人慢」：结合漏斗人数、各阶段停留、画像概况、备注样本给判断与建议。
// 与复盘同模式：前端传聚合数据（岗位详情为 owner 隔离数据）；scope = job_id，10 分钟缓存。
aiAssist.post("/job-diagnosis", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req
    .json<{ scope?: string; report?: Record<string, unknown> }>()
    .catch(() => null);
  if (!body?.report || typeof body.report !== "object") return c.json({ error: "缺少岗位数据" }, 400);

  const scope = (body.scope || "all").slice(0, 120);
  const cached = await loadRecentArtifact(c.env.DB, session.userId, "job_diagnosis", scope, "");
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = (await resolveAiKey(c.env, session.userId)).key;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法生成诊断", code: "AI_NO_KEY" }, 500);
  }

  const system = `你是一名资深招聘负责人，诊断单个岗位「为什么招人慢/难」。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- verdict: 一句话判断瓶颈在哪，不超过 50 字
- reasons: 2-3 条依据，每条必须引用给定数据中的具体数字，不超过 40 字
- actions: 3 条下一步可执行建议，每条不超过 40 字，动作要具体（补充 JD / 调整渠道 / 放宽门槛 / 加快推进等）

判断维度（按漏斗顺序定位）：
1. 进入量是否足够——总量少是曝光/渠道问题，不是筛选问题；
2. 各阶段转化——某一级流失明显偏高，看 JD 期望与候选人质量的错位；
3. 停留时长——有人的阶段停留久，是处理效率问题；
4. 已入职 vs 已淘汰分布——判断门槛与吸引力的平衡。

要求：
1. 只基于给定数据；候选人总数 < 5 时明确说样本不足，给保守建议，不下重结论。
2. 建议要贴合岗位状态：在招给推进建议，已关闭给复盘式建议。`;

  const userPrompt = `【岗位招聘数据】\n${truncate(JSON.stringify(body.report), 3500)}\n\n请诊断这个岗位的招聘瓶颈。`;

  const gen = await deepseekJsonWithUsage(apiKey, system, userPrompt, { temperature: 0.4 });
  if (!gen) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }
  const raw = gen.data;

  const result = {
    verdict: typeof raw.verdict === "string" ? raw.verdict.trim().slice(0, 60) : "",
    reasons: toStringArray(raw.reasons, 3),
    actions: toStringArray(raw.actions, 3),
  };
  if (!result.verdict && !result.reasons.length && !result.actions.length) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }

  await saveArtifact(c.env.DB, session.userId, "job_diagnosis", scope, "", { ...result, _usage: gen.usage ?? null });
  return c.json({ ...result, _usage: gen.usage ?? null });
});

// ---------------------------------------------------------------- 招聘复盘报告
// 把概览分析层的聚合数据（漏斗/周期/渠道/淘汰/停留 + 规则诊断）交给 AI 生成叙述性复盘。
// 只有聚合数字、无个人 PII，不做归属校验；scope（筛选组合）作缓存键，10 分钟内复用不烧 token。
aiAssist.post("/recap-report", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req
    .json<{ scope?: string; report?: Record<string, unknown> }>()
    .catch(() => null);
  if (!body?.report || typeof body.report !== "object") return c.json({ error: "缺少分析数据" }, 400);

  const scope = (body.scope || "all").slice(0, 120);
  const cached = await loadRecentArtifact(c.env.DB, session.userId, "recap_report", scope, "");
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = (await resolveAiKey(c.env, session.userId)).key;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法生成复盘", code: "AI_NO_KEY" }, 500);
  }

  const system = `你是一名资深招聘负责人，擅长把招聘数据讲成结论。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- summary: 整体判断一段话，80-150 字，先说总量与整体转化，再点出最突出的问题
- bottlenecks: 2-3 条瓶颈定位，每条必须引用给定数据中的具体数字，不超过 40 字
- suggestions: 3 条下一步可执行建议，每条不超过 40 字，动作要具体（不要「加强」「优化」这类空话）

要求：
1. 只基于给定数据推断，不要编造；某块数据为空或样本太小（n<3）就明确说数据不足。
2. 转化率结论要结合样本量，样本小不下重判断。
3. 语言务实，像写给业务负责人的一段汇报，不要标题党、不要排比煽情。`;

  const userPrompt = `【招聘分析数据（当前筛选口径下的聚合统计）】\n${truncate(JSON.stringify(body.report), 3500)}\n\n请生成招聘复盘。`;

  const gen = await deepseekJsonWithUsage(apiKey, system, userPrompt, { temperature: 0.4 });
  if (!gen) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }
  const raw = gen.data;

  const result = {
    summary: typeof raw.summary === "string" ? raw.summary.trim().slice(0, 300) : "",
    bottlenecks: toStringArray(raw.bottlenecks, 3),
    suggestions: toStringArray(raw.suggestions, 3),
  };
  if (!result.summary && !result.bottlenecks.length && !result.suggestions.length) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }

  await saveArtifact(c.env.DB, session.userId, "recap_report", scope, "", { ...result, _usage: gen.usage ?? null });
  return c.json({ ...result, _usage: gen.usage ?? null });
});

// ---------------------------------------------------------------- 招聘周报自动生成
// 「AI 助手功能太浅」的 MVP 验证项：证明产能可以从「几条要点」升级成「一份能直接发出去的完整文档」。
// 与 recap-report 的分工：复盘是「讲高层结论」（几句话 + 3 条建议，看趋势用）；
// 周报是「讲清这一周发生了什么」——完整结构、数据交代、卡点、下周计划，可直接发给招聘负责人。
//
// 为什么数据在后端自查而不是前端传：周报要的是全口径真实数字，前端传聚合值既可能失真，
// 也要把聚合口径重写一遍。后端自查还能天然保证 owner 隔离（只统计自己/团队的数据）。
// 时区口径与 overview.ts 同源（中国时区周一算一周开头），保证与工作台数字对得上。
const DAY_MS = 86_400_000;
const CN_SHIFT = 8 * 3600 * 1000; // 中国时区（UTC+8）偏移

/** 中国时区所在周的周一 00:00 对应的 UTC 毫秒（与 overview.chinaWeekStartUtc 同口径） */
function cnWeekStartMs(base: number = Date.now()): number {
  const cn = new Date(base + CN_SHIFT);
  const dow = cn.getUTCDay(); // 0=周日 … 6=周六
  cn.setUTCHours(0, 0, 0, 0);
  cn.setUTCDate(cn.getUTCDate() - ((dow + 6) % 7)); // 回退到本周一
  return cn.getTime() - CN_SHIFT;
}

/** ms → D1 datetime 字符串（"YYYY-MM-DD HH:MM:SS"，UTC，与 datetime('now') 同格式，可直接做字典序比较） */
function sqlTimeOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

/** ms → "M/D" 日期标签（按中国日历显示） */
function dayLabelOf(ms: number): string {
  const d = new Date(ms + CN_SHIFT);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** 中国时区当天日期 YYYY-MM-DD（待办逾期判定用） */
function todayCnOf(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

const STAGE_WR: Record<string, string> = {
  screening: "筛选", interview1: "初试", interview2: "复试",
  offer: "Offer", hired: "已入职", rejected: "已淘汰", withdrawn: "已放弃",
};
const IV_STATUS_WR: Record<string, string> = {
  scheduled: "待面试", done: "已完成", cancelled: "已取消", no_show: "未到场",
};
const IV_RESULT_WR: Record<string, string> = { pass: "通过", fail: "不通过", pending: "待定" };

aiAssist.post("/weekly-report", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req
    .json<{ range?: string; tone?: string; focus?: string }>()
    .catch(() => null);
  const range = body?.range === "last_week" ? "last_week" : "this_week";
  const tone = body?.tone === "brief" ? "brief" : "report";
  const focus = body?.focus === "progress" || body?.focus === "risk" ? body.focus : "all";

  // 缓存键带上三个旋钮：换周期/语气/焦点必须立刻生效，不能吃到上一次的产出
  const scene = `${range}:${tone}:${focus}`;
  const cached = await loadRecentArtifact(c.env.DB, session.userId, "weekly_report", "weekly", scene);
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = (await resolveAiKey(c.env, session.userId)).key;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法生成周报", code: "AI_NO_KEY" }, 500);
  }

  const db = c.env.DB;
  // owner 隔离条件：宿主表名不同则前缀不同，必须逐个别名构造（admin 时为空串，普通用户为 AND ...）
  const scT = ownerScope(session);                 // talents
  const scTj = ownerScope(session, "tj.owner_id"); // talent_jobs（JOIN 场景）
  const scIv = ownerScope(session, "iv.owner_id"); // interviews
  const scTk = ownerScope(session, "tk.owner_id"); // talent_tasks
  const scJ = ownerScope(session, "j.owner_id");   // jobs
  const bT = scT.params, bTj = scTj.params, bIv = scIv.params, bTk = scTk.params, bJ = scJ.params;

  const thisWeekStart = cnWeekStartMs();
  const from = range === "last_week" ? thisWeekStart - 7 * DAY_MS : thisWeekStart;
  const to = range === "last_week" ? thisWeekStart : Date.now();
  const prevFrom = from - 7 * DAY_MS;
  const fromS = sqlTimeOf(from), toS = sqlTimeOf(to), prevFromS = sqlTimeOf(prevFrom);

  // 1. 人才入库：本期新增 + 上期环比 + 来源分布
  const newRow = await db
    .prepare(`SELECT COUNT(*) c FROM talents WHERE created_at >= ? AND created_at < ?${scT.sql}`)
    .bind(fromS, toS, ...bT)
    .first<{ c: number }>();
  const prevNewRow = await db
    .prepare(`SELECT COUNT(*) c FROM talents WHERE created_at >= ? AND created_at < ?${scT.sql}`)
    .bind(prevFromS, fromS, ...bT)
    .first<{ c: number }>();
  const srcRows = await db
    .prepare(`SELECT source k, COUNT(*) n FROM talents WHERE created_at >= ? AND created_at < ?${scT.sql} GROUP BY source`)
    .bind(fromS, toS, ...bT)
    .all<{ k: string | null; n: number }>();

  // 2. 招聘流转：本期到达各阶段人次（job_stage_logs 的 to_stage，"曾到达"口径）
  const stageRows = await db
    .prepare(
      `SELECT l.to_stage k, COUNT(*) n FROM job_stage_logs l
       JOIN talent_jobs tj ON tj.id = l.talent_job_id
       WHERE l.created_at >= ? AND l.created_at < ?${scTj.sql} GROUP BY l.to_stage`
    )
    .bind(fromS, toS, ...bTj)
    .all<{ k: string; n: number }>();

  // 3. 当前存量：投递停留在各阶段的人数（与上式互补——一个看流动，一个看堆积）
  const currentRows = await db
    .prepare(`SELECT tj.stage k, COUNT(*) n FROM talent_jobs tj WHERE 1=1${scTj.sql} GROUP BY tj.stage`)
    .bind(...bTj)
    .all<{ k: string; n: number }>();

  // 4. 面试：本期安排总量、状态分布、已完成面试的结果与评分
  const ivStatusRows = await db
    .prepare(
      `SELECT iv.status k, COUNT(*) n FROM interviews iv
       WHERE iv.scheduled_at >= ? AND iv.scheduled_at < ?${scIv.sql} GROUP BY iv.status`
    )
    .bind(fromS, toS, ...bIv)
    .all<{ k: string; n: number }>();
  const ivResultRows = await db
    .prepare(
      `SELECT iv.result k, COUNT(*) n, AVG(iv.score) a FROM interviews iv
       WHERE iv.status = 'done' AND iv.scheduled_at >= ? AND iv.scheduled_at < ?${scIv.sql} GROUP BY iv.result`
    )
    .bind(fromS, toS, ...bIv)
    .all<{ k: string | null; n: number; a: number | null }>();

  // 5. 岗位：在招总数、本期有进展的 Top、本期零进展的（后者是周报里最该被点名的对象）
  const openJobRow = await db
    .prepare(`SELECT COUNT(*) c FROM jobs j WHERE j.status = 'open'${scJ.sql}`)
    .bind(...bJ)
    .first<{ c: number }>();
  const jobProgressRows = await db
    .prepare(
      `SELECT j.title t, COUNT(*) n FROM job_stage_logs l
       JOIN talent_jobs tj ON tj.id = l.talent_job_id
       JOIN jobs j ON j.id = tj.job_id
       WHERE l.created_at >= ? AND l.created_at < ?${scTj.sql}
       GROUP BY j.id ORDER BY n DESC LIMIT 6`
    )
    .bind(fromS, toS, ...bTj)
    .all<{ t: string; n: number }>();
  // 参数顺序：owner 条件在 SQL 文本中先出现，子查询的两个时间参数随后
  const idleJobRows = await db
    .prepare(
      `SELECT j.title t FROM jobs j
       WHERE j.status = 'open'${scJ.sql}
         AND NOT EXISTS (
           SELECT 1 FROM talent_jobs tj JOIN job_stage_logs l ON l.talent_job_id = tj.id
           WHERE tj.job_id = j.id AND l.created_at >= ? AND l.created_at < ?
         ) LIMIT 6`
    )
    .bind(...bJ, fromS, toS)
    .all<{ t: string }>();

  // 6. 淘汰原因：备注以【原因】前缀写入，这里归类统计（与漏斗页同口径）
  const rejectRows = await db
    .prepare(
      `SELECT l.remark r FROM job_stage_logs l
       JOIN talent_jobs tj ON tj.id = l.talent_job_id
       WHERE l.to_stage = 'rejected' AND l.created_at >= ? AND l.created_at < ?${scTj.sql}`
    )
    .bind(fromS, toS, ...bTj)
    .all<{ r: string | null }>();
  const reasonFreq = new Map<string, number>();
  for (const row of rejectRows.results || []) {
     const m = /【(.+?)】/.exec(row.r || "");
     const key = m ? m[1] : "未注明";
     reasonFreq.set(key, (reasonFreq.get(key) || 0) + 1);
  }

  // 7. 待办：未完成总量与已逾期（这两项决定下周要补的窟窿）
  const taskRow = await db
    .prepare(
      `SELECT COUNT(*) total, SUM(CASE WHEN tk.due_date < ? THEN 1 ELSE 0 END) overdue
       FROM talent_tasks tk WHERE tk.status = 'pending'${scTk.sql}`
    )
    .bind(todayCnOf(), ...bTk)
    .first<{ total: number | null; overdue: number | null }>();

  const totalFlow = (stageRows.results || []).reduce((s, r) => s + r.n, 0);
  const totalInterview = (ivStatusRows.results || []).reduce((s, r) => s + r.n, 0);
  if ((newRow?.c || 0) + totalFlow + totalInterview === 0) {
    return c.json(
      { error: "所选周期内还没有招聘动态（无新增人才、无阶段流转、无面试），先有数据再看周报", code: "AI_EMPTY_INPUT" },
      400
    );
  }

  const topN = (
    rows: { results?: { k: string | null; n: number }[] },
    label?: (k: string) => string
  ): string =>
    (rows.results || [])
      .filter((r) => r.k)
      .sort((a, b) => b.n - a.n)
      .slice(0, 6)
      .map((r) => `${label ? label(r.k as string) : r.k}(${r.n})`)
      .join("、") || "（无）";

  const pickStage = (stage: string): number =>
    (stageRows.results || []).find((r) => r.k === stage)?.n || 0;

  const ivResultText =
    (ivResultRows.results || [])
      .filter((r) => r.k)
      .map((r) => `${IV_RESULT_WR[r.k as string] || r.k} ${r.n} 人${r.a ? `（均分 ${r.a.toFixed(1)}）` : ""}`)
      .join("、") || "（本期无已完成面试）";

  const report = {
    统计区间: `${dayLabelOf(from)} ~ ${dayLabelOf(to - 1)}${range === "last_week" ? "（上周）" : "（本周至今）"}`,
    人才入库: {
      本期新增: newRow?.c || 0,
      上期新增: prevNewRow?.c || 0,
      来源分布: topN(srcRows),
    },
    招聘流转: {
      本期到达各阶段人次: topN(stageRows, (k) => STAGE_WR[k] || k),
      当前停留在各环节人数: topN(currentRows, (k) => STAGE_WR[k] || k),
    },
    面试: {
      本期安排场次: totalInterview,
      场次状态分布: topN(ivStatusRows, (k) => IV_STATUS_WR[k] || k),
      已完成面试结果: ivResultText,
    },
    结果产出: {
      到达Offer人次: pickStage("offer"),
      入职人次: pickStage("hired"),
      淘汰人次: pickStage("rejected"),
      放弃人次: pickStage("withdrawn"),
      淘汰原因分布:
        [...reasonFreq.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}(${n})`).join("、") || "（本期无淘汰）",
    },
    岗位: {
      在招岗位数: openJobRow?.c || 0,
      本期有进展岗位: (jobProgressRows.results || []).map((r) => `${r.t}(${r.n})`).join("、") || "（无）",
      本期零进展在招岗位: (idleJobRows.results || []).map((r) => r.t).join("、") || "（无）",
    },
    待办: {
      未完成总数: taskRow?.total || 0,
      已逾期: taskRow?.overdue || 0,
    },
  };

  const toneInstruction =
    tone === "brief"
      ? "产出给自己看的极简清单：能删就删，每条一行，不要铺垫、不要客套、不要写叙述正文。"
      : "产出可直接发给招聘负责人/业务老板看的正式周报：要有完整叙述正文，交代清楚数据口径与判断依据，语气职业稳重。";
  const focusInstruction =
    focus === "progress"
      ? "只聚焦「本周有哪些进展」，把成果讲足；concerns 最多 1 条或给空数组，next_actions 也要服务于继续推进。"
      : focus === "risk"
        ? "只聚焦「本周有什么问题和卡点」，把风险与成因讲透；highlights 最多 1 条。"
        : "进展与问题并重，篇幅均衡。";

  const system = `你是一名资深 HRBP，为招聘团队撰写周期性周报。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- headline: 周报标题一句话，不超过 25 字，要体现本周最核心的一个判断（有观点，不要「本周招聘周报」这种无信息量标题）
- highlights: 3-5 条本周亮点与进展，每条不超过 45 字，必须引用给定数据中的具体数字
${tone === "report" ? '- narrative: 一段 180-300 字的叙述性周报正文——先讲总量与结构，再讲结果，最后点问题与态度。像人写给领导看的工作汇报，不要列点、不要用 markdown 语法' : ""}
- concerns: 0-3 条风险或卡点，每条不超过 45 字，须引用具体数字（如「3 个在招岗位本周零进展」）；没有明显问题就给空数组，不要硬凑
- next_actions: 3-5 条下周动作建议，每条不超过 40 字，要具体到动作对象（岗位名 / 来源渠道 / 候选人阶段），禁止「加强」「优化」这类空话

要求：
1. 只基于给定数据；某项为 0 或数据不足时如实说明，不要粉饰成「保持稳定」。
2. 环比变化要明确指出（如「较上周增加 4 人」），下降不要回避。
3. 严禁虚构给定数据之外的任何数字、人名或岗位名。`;

  const userPrompt = `【招聘数据快照】\n${truncate(JSON.stringify(report), 3000)}\n\n【语气要求】${toneInstruction}\n【聚焦要求】${focusInstruction}\n\n请生成招聘周报。`;

  const gen = await deepseekJsonWithUsage(apiKey, system, userPrompt, {
    temperature: 0.4,
    maxTokens: tone === "report" ? 1600 : 900,
  });
  if (!gen) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }
  const raw = gen.data;

  const result = {
    range,
    tone,
    focus,
    period: report.统计区间,
    headline: typeof raw.headline === "string" ? raw.headline.trim().slice(0, 40) : "",
    highlights: toStringArray(raw.highlights, 5),
    narrative: tone === "report" && typeof raw.narrative === "string" ? raw.narrative.trim().slice(0, 600) : "",
    concerns: toStringArray(raw.concerns, 3),
    next_actions: toStringArray(raw.next_actions, 5),
  };
  if (!result.headline && !result.highlights.length && !result.narrative) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }

  await saveArtifact(c.env.DB, session.userId, "weekly_report", "weekly", scene, { ...result, _usage: gen.usage ?? null });
  return c.json({ ...result, _usage: gen.usage ?? null });
});

/** 读上次生成的周报（不扣配额）：同一组「周期+语气+焦点」的最近一条 */
aiAssist.get("/weekly-report", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;
  const range = c.req.query("range") === "last_week" ? "last_week" : "this_week";
  const tone = c.req.query("tone") === "brief" ? "brief" : "report";
  const f = c.req.query("focus");
  const focus = f === "progress" || f === "risk" ? f : "all";
  const content = await loadLatestArtifact(
    c.env.DB, session.userId, "weekly_report", "weekly", `${range}:${tone}:${focus}`
  );
  return c.json(withPersisted(content));
});

// ---------------------------------------------------------------- 候选人对比
// 选 2-3 个候选人，AI 按维度并排对比并给出推荐。复用 talentBrief + 统一护栏；
// 多候选人逐个 loadContext 校验归属（任一无权限即 403），scope = 排序后 id 串，10 分钟缓存。
aiAssist.post("/candidate-compare", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req
    .json<{ talent_ids?: string[]; job_id?: string | null }>()
    .catch(() => null);
  const ids = Array.isArray(body?.talent_ids) ? [...new Set(body!.talent_ids.filter(Boolean))].slice(0, 3) : [];
  if (ids.length < 2) return c.json({ error: "请至少选择 2 个候选人进行对比" }, 400);

  // 逐个校验归属；并查可选岗位（用于「谁更贴合该岗位」的判断）
  const talents: Record<string, any>[] = [];
  for (const id of ids) {
    const ctx = await loadContext(c, session, id, body?.job_id);
    if (isResponse(ctx)) return ctx;
    talents.push(ctx.talent);
  }
  const job = (talents[0] as any) && (body?.job_id ? await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(body.job_id).first<any>() : null);

  const scope = ids.join(",");
  const cached = await loadRecentArtifact(c.env.DB, session.userId, "candidate_compare", scope, "");
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = (await resolveAiKey(c.env, session.userId)).key;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法生成对比", code: "AI_NO_KEY" }, 500);
  }

  const labels = ["A", "B", "C"];
  const block = talents
    .map((t, i) => `候选人${labels[i]}（${t.name || "未知"}）：\n${talentBrief(t)}`)
    .join("\n\n");
  const jobText = job
    ? `\n【对比目标岗位】${job.title}（${job.department || ""}）\n任职要求：${truncate(maskPii(job.requirements || job.description || ""), 1200) || "未填写"}`
    : "\n【对比目标岗位】未指定（做通用能力对比，不强绑岗位）";

  const system = `你是一名资深招聘顾问，帮 HR 在多个候选人之间做取舍。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- verdict: 一句话综合推荐（谁更适合、为什么），不超过 120 字；候选人各有所长时明确说清取舍维度
- aspects: 3-5 个对比维度，每个维度：
  - aspect: 维度名（如「工作年限与稳定性」「核心技能匹配」「薪资期望」「管理/带人经验」「风险点」）
  - notes: 与输入候选人顺序一一对应的要点数组（A、B、C 顺序），每条约 25 字；信息不足写「信息不足，建议面试补充」
- watchouts: 0-3 条需警惕的点（如某候选人频繁跳槽、期望远超预算），每条不超过 30 字

要求：
1. notes 数组长度必须与候选人数量一致，且严格按 A、B、C 顺序。
2. 只基于给定事实对比，不要臆造经历或数字。
3. 维度要真正有区分度（不要比「姓名」「城市」这种无关项）。`;

  const userPrompt = `【候选人并排信息】\n${block}\n${jobText}\n\n请做候选人对比。`;

  const gen = await deepseekJsonWithUsage(apiKey, system, userPrompt, { temperature: 0.4 });
  if (!gen) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }
  const raw = gen.data;

  const aspects = Array.isArray(raw.aspects)
    ? raw.aspects
        .map((a: any) => ({
          aspect: typeof a?.aspect === "string" ? a.aspect.trim().slice(0, 20) : "",
          notes: Array.isArray(a?.notes) ? a.notes.map((n: any) => String(n ?? "").trim().slice(0, 60)) : [],
        }))
        .filter((a: any) => a.aspect && a.notes.length === ids.length)
        .slice(0, 5)
    : [];
  if (!aspects.length) {
    return c.json({ error: "AI 未生成有效对比，请重试", code: "AI_EMPTY" }, 502);
  }

  const result = {
    names: talents.map((t) => t.name || "未知"),
    verdict: typeof raw.verdict === "string" ? raw.verdict.trim().slice(0, 160) : "",
    aspects,
    watchouts: toStringArray(raw.watchouts, 3),
  };
  await saveArtifact(c.env.DB, session.userId, "candidate_compare", scope, "", { ...result, _usage: gen.usage ?? null });
  return c.json({ ...result, _usage: gen.usage ?? null });
});

// ---------------------------------------------------------------- Offer 谈判话术
// 基于候选人、岗位与双方薪资预期，生成谈判基调、筹码话术与注意事项。
// 复用 talentBrief / loadContext；scope = talent_id，scene = job_id 或 nojob，10 分钟缓存。
aiAssist.post("/offer-negotiation", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req
    .json<{ talent_id: string; job_id?: string | null; offered_salary?: string; expected_salary?: string; concerns?: string }>()
    .catch(() => null);
  if (!body?.talent_id) return c.json({ error: "缺少人才信息" }, 400);

  const ctx = await loadContext(c, session, body.talent_id, body.job_id);
  if (isResponse(ctx)) return ctx;
  const { talent, job } = ctx;

  const scene = body.job_id ? `job:${body.job_id}` : "nojob";
  const cached = await loadRecentArtifact(c.env.DB, session.userId, "offer_negotiation", talent.id, scene);
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = (await resolveAiKey(c.env, session.userId)).key;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法生成话术", code: "AI_NO_KEY" }, 500);
  }

  const jobText = job
    ? `目标岗位：${job.title}（${job.department || ""}），薪资范围 ${job.salary_range || "待沟通"}`
    : "目标岗位：暂未指定";
  const salaryText = [
    body.offered_salary ? `我方 Offer 薪资：${truncate(body.offered_salary, 60)}` : "",
    body.expected_salary ? `候选人期望薪资：${truncate(body.expected_salary, 60)}` : "",
    body.concerns ? `候选人顾虑/背景：${truncate(maskPii(body.concerns), 300)}` : "",
  ].filter(Boolean).join("\n") || "（未填写薪资与顾虑，按通用谈判话术写）";

  const system = `你是一名资深 HR / 招聘负责人，擅长做 Offer 谈判。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- strategy: 一句话谈判基调（如「先肯定再给区间，用成长空间补足现金差距」），不超过 50 字
- points: 2-3 个核心筹码/说服点（如职级、项目资源、弹性、长期激励），每条不超过 30 字
- scripts: 2-3 个场景话术，每个 { "situation": "场景", "script": "可直接说的话术" }；场景覆盖：候选人要价高于预算 / 候选人对地点或稳定性犹豫 / 候选人有竞品 Offer 在比
- tips: 1-3 条谈判注意（如不要第一次报价亮底、留 24 小时考虑期），每条不超过 25 字

要求：
1. 话术基于给定薪资与顾虑，不要替公司承诺未确认的数字（用「待沟通」留白）。
2. 语气专业、平等、有温度，不施压、不空头许诺。
3. script 是口语化、可直接发或电话说的，不要书面腔。`;

  const userPrompt = `【候选人】\n${talentBrief(talent)}\n\n【${jobText}】\n\n【薪资与顾虑】\n${salaryText}\n\n请生成 Offer 谈判方案。`;

  const gen = await deepseekJsonWithUsage(apiKey, system, userPrompt, { temperature: 0.5 });
  if (!gen) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }
  const raw = gen.data;

  const scripts = Array.isArray(raw.scripts)
    ? raw.scripts
        .map((s: any) => ({
          situation: typeof s?.situation === "string" ? s.situation.trim().slice(0, 30) : "",
          script: typeof s?.script === "string" ? s.script.trim() : "",
        }))
        .filter((s: any) => s.situation && s.script)
        .slice(0, 3)
    : [];
  if (!scripts.length && !raw.strategy) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }

  const result = {
    strategy: typeof raw.strategy === "string" ? raw.strategy.trim().slice(0, 80) : "",
    points: toStringArray(raw.points, 3),
    scripts,
    tips: toStringArray(raw.tips, 3),
  };
  await saveArtifact(c.env.DB, session.userId, "offer_negotiation", talent.id, scene, { ...result, _usage: gen.usage ?? null });
  return c.json({ ...result, _usage: gen.usage ?? null });
});

// ---------------------------------------------------------------- 被动人才触达文案
// 面向「被动（在职/观望）」候选人的挖角/触达文案，区别于通用跟进话术（outreach）。
// 复用 talentBrief / loadContext；scope = talent_id，scene = job_id 或 nojob，10 分钟缓存。
aiAssist.post("/sourcing-copy", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req
    .json<{ talent_id: string; job_id?: string | null }>()
    .catch(() => null);
  if (!body?.talent_id) return c.json({ error: "缺少人才信息" }, 400);

  const ctx = await loadContext(c, session, body.talent_id, body.job_id);
  if (isResponse(ctx)) return ctx;
  const { talent, job } = ctx;

  const scene = body.job_id ? `job:${body.job_id}` : "nojob";
  const cached = await loadRecentArtifact(c.env.DB, session.userId, "sourcing_copy", talent.id, scene);
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = (await resolveAiKey(c.env, session.userId)).key;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法生成文案", code: "AI_NO_KEY" }, 500);
  }

  const jobText = job
    ? `目标岗位：${job.title}（${job.department || "部门未填"}），工作地 ${job.city || "待定"}，薪资范围 ${job.salary_range || "待沟通"}\n任职要求：${truncate(maskPii(job.requirements || ""), 1000) || "未填写"}`
    : "目标岗位：暂未指定（按通用挖角话术写，HR 自行补充岗位亮点）";

  const system = `你是一名资深猎头/招聘负责人，擅长写让被动候选人愿意聊两句的触达文案。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- title: 文案标题（10 字以内，如「一个可能合适的机会」）
- content: 文案正文，180 字以内；结构：一句破冰（点到他当前履历里具体的一个亮点，不空泛）→ 一句话机会钩子（为什么值得花 5 分钟聊）→ 低门槛下一步（如「方便的话回个 1？」）
- tips: 1-3 条触达注意事项（如最佳触达时段、不要一上来发 JD、避免群发感），每条不超过 25 字

要求：
1. 被动候选人最讨厌「群发感」和「一上来甩 JD」——文案必须像针对他个人写的，引用其履历具体事实。
2. 不编造薪资、职级、编制；未确认项用「待沟通」留白。
3. 语气平等、克制、有专业感，像同行在引荐机会，不像销售。`;

  const userPrompt = `【候选人】\n${talentBrief(talent)}\n\n【${jobText}】\n\n请生成被动人才触达文案。`;

  const gen = await deepseekJsonWithUsage(apiKey, system, userPrompt, { temperature: 0.6 });
  if (!gen) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }
  const raw = gen.data;

  const result = {
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 20) : "触达文案",
    content: typeof raw.content === "string" ? raw.content.trim() : "",
    tips: toStringArray(raw.tips, 3),
  };
  if (!result.content) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }
  await saveArtifact(c.env.DB, session.userId, "sourcing_copy", talent.id, scene, { ...result, _usage: gen.usage ?? null });
  return c.json({ ...result, _usage: gen.usage ?? null });
});

// ---------------------------------------------------------------- 招聘渠道建议
// 输入岗位，AI 基于岗位特征（职能/层级/城市/薪资）推荐投放渠道与优先级。
// 后端自查岗位并校验归属；scope = job_id，10 分钟缓存。
aiAssist.post("/channel-advice", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req.json<{ job_id?: string }>().catch(() => null);
  const jobId = (body?.job_id || "").trim();
  if (!jobId) return c.json({ error: "请先选择岗位" }, 400);

  const job = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<any>();
  if (!job) return c.json({ error: "岗位不存在" }, 404);
  if (!(await canTouch(c.env, session, job.owner_id))) {
    return c.json({ error: "无权操作该岗位" }, 403);
  }

  const cached = await loadRecentArtifact(c.env.DB, session.userId, "channel_advice", job.id, "");
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = (await resolveAiKey(c.env, session.userId)).key;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法生成建议", code: "AI_NO_KEY" }, 500);
  }

  const report = {
    岗位: `${job.title || ""}${job.department ? `（${job.department}）` : ""}`,
    城市: job.city || "未填",
    薪资范围: job.salary_range || "未填",
    职能方向: truncate(maskPii(job.description || job.requirements || ""), 800) || "未填",
    紧急度: job.priority || "未填",
  };

  const system = `你是一名资深招聘渠道专家，针对单个岗位给出「去哪招人」的建议。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- verdict: 一句话结论（主力渠道 + 原因），不超过 60 字
- channels: 3-5 个推荐渠道，每个：
  - channel: 渠道名（如 BOSS直聘、猎聘、内推/员工 referral、校园招聘、拉勾、脉脉、行业社群、猎头公司）
  - priority: 优先级，三选一："高" / "中" / "低"
  - reason: 为什么适合这个岗位（结合职能/层级/城市/薪资），不超过 40 字
- tips: 1-3 条渠道运营建议（如内推激励设计、定向挖角、JD 优化），每条不超过 30 字

可选渠道库（不限于）：BOSS直聘（中基层、响应快）、猎聘（中高端/被动人才）、内推（成本低、质量稳）、校园招聘（校招/管培）、拉勾（互联网）、脉脉/行业社群（被动挖角）、猎头公司（稀缺高端）、垂直论坛（硬核技术）。

要求：
1. 渠道推荐必须贴合岗位特征，不要每个岗位都列同样的五个。
2. 高层级/稀缺岗位优先推猎聘+内推+猎头；校招/实习优先校园招聘；中基层效率岗优先 BOSS。
3. 不要编造岗位没有的信息。`;

  const userPrompt = `【岗位信息】\n${truncate(JSON.stringify(report), 1200)}\n\n请给出招聘渠道建议。`;

  const gen = await deepseekJsonWithUsage(apiKey, system, userPrompt, { temperature: 0.4 });
  if (!gen) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }
  const raw = gen.data;

  const CH_PRIORITY = ["高", "中", "低"];
  const channels = Array.isArray(raw.channels)
    ? raw.channels
        .map((x: any) => ({
          channel: String(x?.channel || "").trim().slice(0, 20),
          priority: CH_PRIORITY.includes(String(x?.priority || "")) ? String(x.priority) : "中",
          reason: String(x?.reason || "").trim().slice(0, 60),
        }))
        .filter((x: any) => x.channel)
        .slice(0, 5)
    : [];
  if (!channels.length) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }

  const result = {
    verdict: typeof raw.verdict === "string" ? raw.verdict.trim().slice(0, 80) : "",
    channels,
    tips: toStringArray(raw.tips, 3),
  };
  await saveArtifact(c.env.DB, session.userId, "channel_advice", job.id, "", { ...result, _usage: gen.usage ?? null });
  return c.json({ ...result, _usage: gen.usage ?? null });
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
  if (!(await canTouch(c.env, session, row.owner_id))) {
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

// 读上次「候选人对比」结果（不扣配额）
aiAssist.get("/candidate-compare", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;
  const ids = (c.req.query("talent_ids") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 3);
  if (ids.length < 2) return c.json({ error: "缺少候选人" }, 400);
  for (const id of ids) {
    const denied = await requireTalent(c, session, id);
    if (isResponse(denied)) return denied;
  }
  const content = await loadLatestArtifact(c.env.DB, session.userId, "candidate_compare", ids.join(","), "");
  return c.json(withPersisted(content));
});

// 读上次「Offer 谈判话术」结果（不扣配额）
aiAssist.get("/offer-negotiation", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;
  const talentId = c.req.query("talent_id");
  const denied = await requireTalent(c, session, talentId);
  if (isResponse(denied)) return denied;
  const jobId = c.req.query("job_id");
  const content = await loadLatestArtifact(c.env.DB, session.userId, "offer_negotiation", talentId!, jobId ? `job:${jobId}` : "nojob");
  return c.json(withPersisted(content));
});

// 读上次「被动人才触达文案」结果（不扣配额）
aiAssist.get("/sourcing-copy", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;
  const talentId = c.req.query("talent_id");
  const denied = await requireTalent(c, session, talentId);
  if (isResponse(denied)) return denied;
  const jobId = c.req.query("job_id");
  const content = await loadLatestArtifact(c.env.DB, session.userId, "sourcing_copy", talentId!, jobId ? `job:${jobId}` : "nojob");
  return c.json(withPersisted(content));
});

// 读上次「招聘渠道建议」结果（不扣配额）
aiAssist.get("/channel-advice", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;
  const jobId = (c.req.query("job_id") || "").trim();
  if (!jobId) return c.json({ error: "缺少岗位" }, 400);
  const job = await c.env.DB.prepare("SELECT id, owner_id FROM jobs WHERE id = ?").bind(jobId).first<{ id: string; owner_id: string }>();
  if (!job) return c.json({ error: "岗位不存在" }, 404);
  if (!(await canTouch(c.env, session, job.owner_id))) {
    return c.json({ error: "无权操作该岗位" }, 403);
  }
  const content = await loadLatestArtifact(c.env.DB, session.userId, "channel_advice", jobId, "");
  return c.json(withPersisted(content));
});

// ---------------------------------------------------------------- 人事：合同风险审查
// 粘贴合同文本，AI 标出风险点、缺失必备条款与健康度评分。需关联候选人（合同主体）。
// 复用 talentBrief / loadContext；scope = talent_id，10 分钟缓存。
aiAssist.post("/contract-review", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req.json<{ talent_id?: string; text?: string }>().catch(() => null);
  if (!body?.talent_id) return c.json({ error: "请先选择候选人（合同主体）" }, 400);
  const ctx = await loadContext(c, session, body.talent_id);
  if (isResponse(ctx)) return ctx;
  const { talent } = ctx;

  const text = (body.text || "").trim();
  if (text.length < 20) return c.json({ error: "请粘贴至少 20 字的合同内容" }, 400);

  const cached = await loadRecentArtifact(c.env.DB, session.userId, "contract_review", talent.id, "");
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = (await resolveAiKey(c.env, session.userId)).key;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法审查", code: "AI_NO_KEY" }, 500);
  }

  const contractText = truncate(maskPii(text), 3000);

  const system = `你是一名资深劳动法顾问 / 企业法务，帮 HR 快速审查一份劳动合同或聘用协议。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- summary: 一句话整体判断（合同是否规范、主要隐患），不超过 80 字
- score: 合规健康度评分，0-100 的整数，越高越规范
- risks: 2-6 个风险点，每个 { "clause": "涉及的条款/原文片段（≤30字）", "risk": "风险说明（≤40字）", "suggestion": "修改/补强建议（≤40字）" }
- missing: 0-5 条缺失的必备条款（如试用期约定、社保公积金、保密与竞业限制、解除条件、工作地点），每条不超过 30 字

要求：
1. 只针对给定合同文本审查，不要臆造未出现的内容。
2. 区分「硬伤」（违法/无效）与「待完善」（表述不清、易被争议）。
3. 建议要可落地，不要只说「建议咨询律师」。`;

  const userPrompt = `【合同主体】\n${talentBrief(talent)}\n\n【合同内容】\n${contractText}\n\n请审查这份合同。`;

  const gen = await deepseekJsonWithUsage(apiKey, system, userPrompt, { temperature: 0.3 });
  if (!gen) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }
  const raw = gen.data;

  const risks = Array.isArray(raw.risks)
    ? raw.risks
        .map((r: any) => ({
          clause: String(r?.clause || "").trim().slice(0, 40),
          risk: String(r?.risk || "").trim().slice(0, 60),
          suggestion: String(r?.suggestion || "").trim().slice(0, 60),
        }))
        .filter((r: any) => r.clause && r.risk)
        .slice(0, 6)
    : [];
  const missing = toStringArray(raw.missing, 5);
  const summary = typeof raw.summary === "string" ? raw.summary.trim().slice(0, 120) : "";
  const scoreNum = Math.floor(Number(raw.score));
  const score = Number.isFinite(scoreNum) && scoreNum >= 0 && scoreNum <= 100 ? scoreNum : 0;

  if (!risks.length && !missing.length && !summary) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }

  const result = { summary, score, risks, missing };
  await saveArtifact(c.env.DB, session.userId, "contract_review", talent.id, "", { ...result, _usage: gen.usage ?? null });
  return c.json({ ...result, _usage: gen.usage ?? null });
});

// ---------------------------------------------------------------- 人事：社保增减员提醒
// 输入事件（增员/减员）、日期与城市，AI 生成截止节点、操作清单与合规注意。需关联候选人。
// scope = talent_id，scene = event:city，10 分钟缓存。
aiAssist.post("/social-reminder", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req.json<{ talent_id?: string; event?: string; date?: string; city?: string }>().catch(() => null);
  if (!body?.talent_id) return c.json({ error: "请先选择候选人" }, 400);
  const ctx = await loadContext(c, session, body.talent_id);
  if (isResponse(ctx)) return ctx;
  const { talent } = ctx;

  const event = body.event === "remove" ? "remove" : "add";
  const date = (body.date || "").trim();
  const city = (body.city || "").trim();
  const scene = `${event}:${city || "any"}`;

  const cached = await loadRecentArtifact(c.env.DB, session.userId, "social_reminder", talent.id, scene);
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = (await resolveAiKey(c.env, session.userId)).key;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法生成提醒", code: "AI_NO_KEY" }, 500);
  }

  const eventLabel = event === "remove" ? "减员（离职停保）" : "增员（入职参保）";
  const system = `你是一名资深 HR / 薪酬社保专员，帮 HR 生成社保公积金增减员的操作提醒。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

背景：企业必须为员工在入职 / 离职后规定时限内办理社保公积金增减员，逾期会产生滞纳金与合规风险。

字段说明：
- deadline: 一句话关键时间节点（如「入职当月 25 日前完成增员，逾期将产生滞纳金」），不超过 60 字
- steps: 3-6 步操作清单（如收集证件、核定缴费基数、线上申报、确认到账），每步不超过 30 字
- notes: 1-4 条合规注意（如试用期也需缴纳、基数上下限、跨地区转移），每条不超过 30 字
- tips: 1-3 条实操建议，每条不超过 25 字

要求：
1. 结合给出的事件（增员/减员）、日期与城市给具体节点；城市影响经办渠道与基数口径。
2. 不编造政策数字；涉及具体比例/基数以「以当地经办机构口径为准」留白。`;

  const userPrompt = `【参保人】\n${talentBrief(talent)}\n\n【事件】${eventLabel}\n【日期】${date || "未填"}\n【城市】${city || "未填"}\n\n请生成社保增减员提醒。`;

  const gen = await deepseekJsonWithUsage(apiKey, system, userPrompt, { temperature: 0.4 });
  if (!gen) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }
  const raw = gen.data;

  const deadline = typeof raw.deadline === "string" ? raw.deadline.trim().slice(0, 100) : "";
  const steps = toStringArray(raw.steps, 6);
  const notes = toStringArray(raw.notes, 4);
  const tips = toStringArray(raw.tips, 3);

  if (!deadline && !steps.length && !notes.length) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }

  const result = { event: eventLabel, deadline, steps, notes, tips };
  await saveArtifact(c.env.DB, session.userId, "social_reminder", talent.id, scene, { ...result, _usage: gen.usage ?? null });
  return c.json({ ...result, _usage: gen.usage ?? null });
});

// ---------------------------------------------------------------- 人事：个税筹划建议
// 输入税前薪资构成与城市，AI 给出到手估算、专项附加扣除与合规节税建议。需关联候选人。
// scope = talent_id，scene = city，10 分钟缓存。
aiAssist.post("/tax-plan", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req.json<{ talent_id?: string; base?: string; bonus?: string; city?: string }>().catch(() => null);
  if (!body?.talent_id) return c.json({ error: "请先选择候选人" }, 400);
  const ctx = await loadContext(c, session, body.talent_id);
  if (isResponse(ctx)) return ctx;
  const { talent } = ctx;

  const base = (body.base || "").trim();
  const bonus = (body.bonus || "").trim();
  const city = (body.city || "").trim();
  const scene = city || "any";

  const cached = await loadRecentArtifact(c.env.DB, session.userId, "tax_plan", talent.id, scene);
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = (await resolveAiKey(c.env, session.userId)).key;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法生成建议", code: "AI_NO_KEY" }, 500);
  }

  const system = `你是一名资深个税筹划顾问，帮候选人或员工估算到手并给出合规节税建议。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- take_home_note: 一句话到手结论（基于给定税前构成做粗略估算，注明「估算」），不超过 80 字
- optimizations: 2-5 条节税/优化点，每个 { "item": "项目（如专项附加扣除、年终奖单独计税、公积金基数）", "detail": "说明（≤40字）" }
- tips: 1-3 条合规提醒（如不要拆分工资逃税、留存凭证），每条不超过 25 字

要求：
1. 只基于给定薪资构成估算，明确标注「估算，以个税 App 为准」。
2. 所有建议必须合法合规，不得建议虚假报销、阴阳合同等违规操作。
3. 专项附加扣除要覆盖七项：子女教育 / 继续教育 / 大病医疗 / 住房贷款 / 住房租金 / 赡养老人 / 3岁以下婴幼儿照护。`;

  const userPrompt = `【纳税人】\n${talentBrief(talent)}\n\n【税前薪资构成】\n月薪（税前）：${base || "未填"}\n年终奖/绩效：${bonus || "未填"}\n【城市】${city || "未填"}\n\n请给出个税筹划建议。`;

  const gen = await deepseekJsonWithUsage(apiKey, system, userPrompt, { temperature: 0.4 });
  if (!gen) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }
  const raw = gen.data;

  const takeHome = typeof raw.take_home_note === "string" ? raw.take_home_note.trim().slice(0, 120) : "";
  const optimizations = Array.isArray(raw.optimizations)
    ? raw.optimizations
        .map((o: any) => ({
          item: String(o?.item || "").trim().slice(0, 30),
          detail: String(o?.detail || "").trim().slice(0, 60),
        }))
        .filter((o: any) => o.item && o.detail)
        .slice(0, 5)
    : [];
  const tips = toStringArray(raw.tips, 3);

  if (!takeHome && !optimizations.length && !tips.length) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }

  const result = { take_home_note: takeHome, optimizations, tips };
  await saveArtifact(c.env.DB, session.userId, "tax_plan", talent.id, scene, { ...result, _usage: gen.usage ?? null });
  return c.json({ ...result, _usage: gen.usage ?? null });
});

// ---------------------------------------------------------------- 人事：试用期合规提醒
// 输入合同起始日与试用期月数，AI 推算转正/解除节点、合规要点与沟通话术。需关联候选人。
// scope = talent_id，scene = start:months，10 分钟缓存。
aiAssist.post("/probation-compliance", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req.json<{ talent_id?: string; start?: string; months?: string }>().catch(() => null);
  if (!body?.talent_id) return c.json({ error: "请先选择候选人" }, 400);
  const ctx = await loadContext(c, session, body.talent_id);
  if (isResponse(ctx)) return ctx;
  const { talent } = ctx;

  const start = (body.start || "").trim();
  const months = (body.months || "").trim();
  const scene = `${start || "any"}:${months || "any"}`;

  const cached = await loadRecentArtifact(c.env.DB, session.userId, "probation_compliance", talent.id, scene);
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = (await resolveAiKey(c.env, session.userId)).key;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法生成提醒", code: "AI_NO_KEY" }, 500);
  }

  const system = `你是一名资深劳动法顾问，帮 HR 梳理试用期相关的合规节点与沟通话术。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- timeline: 2-4 个关键节点，每个 { "node": "节点名（如入职/试用期满/转正/解除窗口）", "action": "该节点 HR 应做的事（≤30字）" }
- points: 2-5 条合规要点（如试用期时长上限、录用条件须书面、解除须有证据），每条不超过 30 字
- scripts: 0-3 个沟通话术 { "situation": "场景（如延长试用期/不予转正）", "script": "可直接说的话术" }
- tips: 1-3 条注意，每条不超过 25 字

要求：
1. 基于给定的合同起始日与试用期月数推算节点（试用期时长依法：合同<3年≤2月，3年以上≤6月，无固定≤6月）。
2. 话术专业、合法、有温度，不施压、不威胁。`;

  const userPrompt = `【员工】\n${talentBrief(talent)}\n\n【合同起始日】${start || "未填"}\n【试用期】${months || "未填"} 个月\n\n请梳理试用期合规节点与话术。`;

  const gen = await deepseekJsonWithUsage(apiKey, system, userPrompt, { temperature: 0.4 });
  if (!gen) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }
  const raw = gen.data;

  const timeline = Array.isArray(raw.timeline)
    ? raw.timeline
        .map((t: any) => ({
          node: String(t?.node || "").trim().slice(0, 20),
          action: String(t?.action || "").trim().slice(0, 40),
        }))
        .filter((t: any) => t.node && t.action)
        .slice(0, 4)
    : [];
  const points = toStringArray(raw.points, 5);
  const scripts = Array.isArray(raw.scripts)
    ? raw.scripts
        .map((s: any) => ({
          situation: String(s?.situation || "").trim().slice(0, 30),
          script: String(s?.script || "").trim().slice(0, 200),
        }))
        .filter((s: any) => s.situation && s.script)
        .slice(0, 3)
    : [];
  const tips = toStringArray(raw.tips, 3);

  if (!timeline.length && !points.length && !scripts.length && !tips.length) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }

  const result = { timeline, points, scripts, tips };
  await saveArtifact(c.env.DB, session.userId, "probation_compliance", talent.id, scene, { ...result, _usage: gen.usage ?? null });
  return c.json({ ...result, _usage: gen.usage ?? null });
});

// ---------------------------------------------------------------- 读取已生成结果（GET，人事）
aiAssist.get("/contract-review", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;
  const talentId = c.req.query("talent_id");
  const denied = await requireTalent(c, session, talentId);
  if (isResponse(denied)) return denied;
  const content = await loadLatestArtifact(c.env.DB, session.userId, "contract_review", talentId!, "");
  return c.json(withPersisted(content));
});

aiAssist.get("/social-reminder", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;
  const talentId = c.req.query("talent_id");
  const denied = await requireTalent(c, session, talentId);
  if (isResponse(denied)) return denied;
  const event = c.req.query("event") === "remove" ? "remove" : "add";
  const city = (c.req.query("city") || "").trim();
  const content = await loadLatestArtifact(c.env.DB, session.userId, "social_reminder", talentId!, `${event}:${city || "any"}`);
  return c.json(withPersisted(content));
});

aiAssist.get("/tax-plan", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;
  const talentId = c.req.query("talent_id");
  const denied = await requireTalent(c, session, talentId);
  if (isResponse(denied)) return denied;
  const city = (c.req.query("city") || "").trim();
  const content = await loadLatestArtifact(c.env.DB, session.userId, "tax_plan", talentId!, city || "any");
  return c.json(withPersisted(content));
});

aiAssist.get("/probation-compliance", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;
  const talentId = c.req.query("talent_id");
  const denied = await requireTalent(c, session, talentId);
  if (isResponse(denied)) return denied;
  const start = (c.req.query("start") || "").trim();
  const months = (c.req.query("months") || "").trim();
  const content = await loadLatestArtifact(c.env.DB, session.userId, "probation_compliance", talentId!, `${start || "any"}:${months || "any"}`);
  return c.json(withPersisted(content));
});

// ---------------------------------------------------------------- AI 配额配置
// 管理员不限额；普通用户每日上限可在「系统设置 → AI 配额」调整。
// 配置存 site_settings（key = ai_quota_config，值 JSON { limit }），未配置回落默认 20。
// limit = 0 语义为「不限制」（管理员可把普通用户也放开）。
aiAssist.get("/quota", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const quota = await checkQuota(c.env.DB, session.userId, session.role);
  const defaultLimit = await loadDailyLimit(c.env.DB);
  return c.json({
    used: quota.used,
    limit: quota.limit,
    unlimited: quota.unlimited,
    // 管理员看到的是"默认值"，因为对自己的生效值恒为不限；避免误以为可改
    default_limit: defaultLimit,
  });
});

// 仅管理员：保存普通用户每日上限
aiAssist.put("/quota", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;
  if (session.role !== "admin") return c.json({ error: "无权限，仅管理员可操作" }, 403);

  const body = await c.req.json<{ limit?: unknown }>().catch(() => ({}) as { limit?: unknown });
  const n = Math.floor(Number(body?.limit));
  if (!Number.isFinite(n) || n < 0 || n > 9999) {
    return c.json({ error: "次数需为 0-9999 的整数（0 表示不限制）" }, 400);
  }
  await c.env.DB.prepare(
    "INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
    .bind(AI_QUOTA_SETTING_KEY, JSON.stringify({ limit: n }))
    .run();
  return c.json({ ok: true, limit: n });
});

// ---------------------------------------------------------------- 自有 AI Key（BYOK）
// 场景：每日 AI 配额用完时，用户填自己的 DeepSeek Key 立即可继续用——花自己的钱，
// 不占系统配额，也不用等管理员扩额度。
// 安全：Key 经 AES-GCM 加密后存 users.ai_key（主密钥为 wrangler secret AI_KEY_SECRET），
// 不明文落库；主密钥未配置时功能整体关闭；保存前先真实调用 DeepSeek 验证有效性。
aiAssist.get("/own-key", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;
  const info = await loadOwnKeyInfo(c.env.DB, session.userId);
  return c.json(info);
});

aiAssist.put("/own-key", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  if (!c.env.AI_KEY_SECRET) {
    return c.json({ error: "服务端未开启自定义 Key 功能，请联系管理员配置", code: "BYOK_DISABLED" }, 400);
  }
  const body = await c.req.json<{ key?: unknown }>().catch(() => ({}) as { key?: unknown });
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  if (!looksLikeDeepSeekKey(key)) {
    return c.json({ error: "Key 格式不正确：DeepSeek Key 一般为 sk- 开头的一串字母数字，请直接粘贴" }, 400);
  }
  // 保存前真实验证，避免存了个无效 Key、用户还以为在花自己的额度
  const verified = await verifyDeepSeekKey(key);
  if (!verified.ok) {
    return c.json({ error: verified.error || "Key 验证失败" }, 400);
  }
  const cipher = await encryptAiKey(key, c.env.AI_KEY_SECRET);
  const masked = maskAiKey(key);
  await c.env.DB.prepare("UPDATE users SET ai_key = ?, ai_key_masked = ? WHERE id = ?")
    .bind(cipher, masked, session.userId)
    .run();
  return c.json({ ok: true, masked });
});

aiAssist.delete("/own-key", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;
  await c.env.DB.prepare("UPDATE users SET ai_key = NULL, ai_key_masked = NULL WHERE id = ?")
    .bind(session.userId)
    .run();
  return c.json({ ok: true });
});

export default aiAssist;
