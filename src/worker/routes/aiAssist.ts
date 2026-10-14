import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { deepseekJsonSafe, toStringArray } from "../ai";
import {
  AI_QUOTA_SETTING_KEY, checkQuota, loadDailyLimit, loadLatestArtifact, loadRecentArtifact,
  maskPii, saveArtifact, truncate,
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

/**
 * 配额校验；通过返回 null，否则返回要直接 return 的 429 响应。
 * 管理员不限额（checkQuota 直接放行）；普通用户上限取系统设置里的配置。
 */
async function quotaGuard(
  c: Context<{ Bindings: Env }>,
  userId: string,
  role?: string
): Promise<Response | null> {
  const quota = await checkQuota(c.env.DB, userId, role);
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
  const denied = await quotaGuard(c, session.userId, session.role);
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
  const denied = await quotaGuard(c, session.userId, session.role);
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
  const denied = await quotaGuard(c, session.userId, session.role);
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

// ---------------------------------------------------------------- 岗位信息 AI 起草
// 新增岗位表单「AI 一键起草」：基于岗位名称（+部门/城市）生成职责、要求、薪资建议、学历、经验。
// 复用统一护栏（配额 / 缓存 / 脱敏 / 截断）与 deepseekJsonSafe；岗位尚未创建，仅需会话即可。
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

  const apiKey = c.env.DEEPSEEK_API_KEY;
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

  const raw = await deepseekJsonSafe(apiKey, system, userPrompt, { temperature: 0.4 });
  if (!raw) {
    return c.json({ error: "AI 暂时不可用，请稍后重试或手动填写", code: "AI_UNAVAILABLE" }, 502);
  }

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
  await saveArtifact(c.env.DB, session.userId, "job_draft", bizId, scene, result);
  return c.json(result);
});

// ---------------------------------------------------------------- AI 审批摘要
// 审批「10 秒读卡」：后端自查实例 + 候选人 + 岗位 + 快照 + 前级意见，生成摘要与风险点。
// AI 只摆事实不给倾向性结论——批准/驳回由审批人独立决策。scope = instance_id，10 分钟缓存。
const STAGE_ZH: Record<string, string> = {
  applied: "已投递", screening: "初筛", interviewing: "面试中", offer: "Offer 阶段",
  onboard: "待入职", hired: "已入职", rejected: "已淘汰", withdrawn: "已放弃",
};

aiAssist.post("/approval-summary", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req.json<{ instance_id?: string }>().catch(() => null);
  const id = (body?.instance_id || "").trim();
  if (!id) return c.json({ error: "缺少审批单号" }, 400);

  const inst = await c.env.DB.prepare(`
    SELECT i.id, i.owner_id, i.scene, i.title, i.current_step, i.status, i.payload, i.created_at,
           t.current_title, t.current_company, t.years_experience, t.education, t.expected_salary,
           tj.stage, j.title AS job_title_full, j.salary_range AS job_salary, j.city AS job_city
    FROM approval_instances i
    JOIN talents t ON i.talent_id = t.id
    LEFT JOIN talent_jobs tj ON tj.id = i.talent_job_id
    LEFT JOIN jobs j ON j.id = tj.job_id
    WHERE i.id = ?
  `).bind(id).first<any>();
  if (!inst) return c.json({ error: "审批不存在" }, 404);
  // 归属校验：与 decide 接口同规则——admin 任意，普通用户限自己发起的
  if (session.role !== "admin" && inst.owner_id !== session.userId) {
    return c.json({ error: "无权查看该审批" }, 403);
  }

  const scope = id.slice(0, 120);
  const cached = await loadRecentArtifact(c.env.DB, session.userId, "approval_summary", scope, "");
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = c.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法生成摘要", code: "AI_NO_KEY" }, 500);
  }

  // 步骤明细（含前级意见，脱敏截断）
  const stepRows = await c.env.DB.prepare(
    "SELECT step_index, step_name, decision, comment FROM approval_steps WHERE instance_id = ? ORDER BY step_index ASC"
  ).bind(id).all();
  const steps = (stepRows.results || []).map((s: any) => ({
    环节: s.step_name,
    结果: s.decision === "approve" ? "已通过" : s.decision === "reject" ? "已驳回" : "待处理",
    意见: s.comment ? maskPii(String(s.comment)).slice(0, 80) : "",
  }));

  // payload 快照：发起审批时录入的 Offer 等信息，是「批什么」的核心
  let payloadText = "（无）";
  if (inst.payload) {
    try { payloadText = truncate(JSON.stringify(JSON.parse(inst.payload)), 600); } catch { /* 脏快照忽略 */ }
  }

  const openDays = Math.max(0, Math.floor(
    (Date.now() - new Date(String(inst.created_at).replace(" ", "T") + "Z").getTime()) / 86400000
  ));

  const report = {
    审批事项: {
      标题: inst.title, 场景: inst.scene, 状态: inst.status,
      发起至今天数: openDays, 当前环节: (inst.current_step ?? 0) + 1,
      快照内容: payloadText,
    },
    候选人: {
      当前职位: inst.current_title || "", 当前公司: maskPii(inst.current_company || ""),
      工作年限: inst.years_experience != null ? `${inst.years_experience}年` : "",
      学历: inst.education || "", 期望薪资: inst.expected_salary || "",
      招聘流程阶段: STAGE_ZH[inst.stage] || inst.stage || "",
    },
    岗位: { 名称: inst.job_title_full || "", 城市: inst.job_city || "", 薪资范围: inst.job_salary || "" },
    审批步骤与意见: steps,
  };

  const system = `你是一名资深 HR 顾问，为审批人准备「10 秒读卡」审批摘要。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- summary: 不超过 3 句话，讲清「批的是什么」——谁、什么岗位/条件、审批请求的核心内容（从快照取），不超过 90 字
- risks: 0-2 条风险点，每条必须引用给定数据中的具体事实，不超过 40 字；没有可指出的风险就给空数组，不要硬凑

常见风险维度（仅作提示，只列数据能支撑的）：
- 薪资：快照薪资超出岗位薪资范围，或明显高于候选人期望薪资
- 时效：候选人流转或审批停滞过久
- 信息缺失：快照缺少关键信息（如未写薪资、未写入职日期）
- 门槛：候选人年限/学历与岗位要求明显不匹配

要求：
1. 只基于给定数据，查不到的字段不要编造。
2. 严禁给出「建议批准 / 建议驳回」的倾向性结论——决策由审批人独立做出，你只负责把信息摆清楚。`;

  const userPrompt = `【审批上下文】\n${truncate(JSON.stringify(report), 3200)}\n\n请生成审批摘要与风险提示。`;

  const raw = await deepseekJsonSafe(apiKey, system, userPrompt, { temperature: 0.3 });
  if (!raw) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }

  const result = {
    summary: typeof raw.summary === "string" ? raw.summary.trim().slice(0, 120) : "",
    risks: toStringArray(raw.risks, 2),
  };
  if (!result.summary) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }

  await saveArtifact(c.env.DB, session.userId, "approval_summary", scope, "", result);
  return c.json(result);
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
  if (session.role !== "admin" && t.owner_id !== session.userId) {
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

  const apiKey = c.env.DEEPSEEK_API_KEY;
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

  const raw = await deepseekJsonSafe(apiKey, system, userPrompt, { temperature: 0.3 });
  if (!raw) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }

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
  await saveArtifact(c.env.DB, session.userId, "onboard_checklist", scope, "", result);
  return c.json(result);
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
  if (session.role !== "admin") {
    conditions.push("t.owner_id = ?");
    params.push(session.userId);
  }
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
    // 在招岗位（与 jobs 列表同规则 owner 隔离），用于缺口对比
    db.prepare(`SELECT title, city, priority FROM jobs WHERE status = 'open' ${session.role !== "admin" ? "AND owner_id = ?" : ""} ORDER BY created_at DESC LIMIT 20`)
      .bind(...(session.role !== "admin" ? [session.userId] : [])).all(),
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

  const apiKey = c.env.DEEPSEEK_API_KEY;
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

  const raw = await deepseekJsonSafe(apiKey, system, userPrompt, { temperature: 0.3 });
  if (!raw) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }

  const result = {
    profile: typeof raw.profile === "string" ? raw.profile.trim().slice(0, 160) : "",
    gaps: toStringArray(raw.gaps, 3),
    actions: toStringArray(raw.actions, 3),
  };
  if (!result.profile) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }

  await saveArtifact(c.env.DB, session.userId, "talent_inventory", scope, "", result);
  return c.json(result);
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

  const apiKey = c.env.DEEPSEEK_API_KEY;
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

  const raw = await deepseekJsonSafe(apiKey, system, userPrompt, { temperature: 0.4 });
  if (!raw) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }

  const result = {
    verdict: typeof raw.verdict === "string" ? raw.verdict.trim().slice(0, 60) : "",
    reasons: toStringArray(raw.reasons, 3),
    actions: toStringArray(raw.actions, 3),
  };
  if (!result.verdict && !result.reasons.length && !result.actions.length) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }

  await saveArtifact(c.env.DB, session.userId, "job_diagnosis", scope, "", result);
  return c.json(result);
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

  const apiKey = c.env.DEEPSEEK_API_KEY;
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

  const raw = await deepseekJsonSafe(apiKey, system, userPrompt, { temperature: 0.4 });
  if (!raw) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }

  const result = {
    summary: typeof raw.summary === "string" ? raw.summary.trim().slice(0, 300) : "",
    bottlenecks: toStringArray(raw.bottlenecks, 3),
    suggestions: toStringArray(raw.suggestions, 3),
  };
  if (!result.summary && !result.bottlenecks.length && !result.suggestions.length) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }

  await saveArtifact(c.env.DB, session.userId, "recap_report", scope, "", result);
  return c.json(result);
});

// ---------------------------------------------------------------- 看板卡片 AI 下一步建议
// 输入 link_id：后端自查链路/候选人/岗位/面试并校验归属，输出决策建议 + 跟进话术草稿。
// AI 只出草稿：话术必须用户手动复制，系统永不代发。
aiAssist.post("/next-step", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req.json<{ link_id?: string }>().catch(() => null);
  if (!body?.link_id) return c.json({ error: "缺少候选人记录" }, 400);

  const link = await c.env.DB
    .prepare(
      `SELECT tj.id, tj.stage, tj.rating, tj.notes AS stage_notes, tj.updated_at AS stage_updated_at,
              tj.job_id, t.*
       FROM talent_jobs tj JOIN talents t ON tj.talent_id = t.id WHERE tj.id = ?`
    )
    .bind(body.link_id)
    .first<any>();
  if (!link) return c.json({ error: "候选人记录不存在" }, 404);
  if (session.role !== "admin" && link.owner_id !== session.userId) {
    return c.json({ error: "无权操作该候选人" }, 403);
  }

  const cached = await loadRecentArtifact(c.env.DB, session.userId, "next_step", link.id, "");
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = c.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法生成建议", code: "AI_NO_KEY" }, 500);
  }

  // 停留天数与 pipeline.ts 同算法（UTC 日差），不依赖前端传值
  const stageDays = link.stage_updated_at
    ? Math.max(0, Math.floor((Date.now() - new Date(link.stage_updated_at + "Z").getTime()) / 86400000))
    : 0;

  // 本岗位下一场待面试：已排期就不建议再约
  const nextInterview = await c.env.DB
    .prepare(
      `SELECT scheduled_at FROM interviews
       WHERE talent_id = ? AND job_id = ? AND status = 'pending' AND scheduled_at IS NOT NULL
       ORDER BY scheduled_at ASC LIMIT 1`
    )
    .bind(link.talent_id, link.job_id)
    .first<{ scheduled_at: string }>();

  let jobText = "目标岗位：未指定";
  if (link.job_id) {
    const job = await c.env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(link.job_id).first<any>();
    if (job) {
      jobText = `目标岗位：${job.title}（${job.department || "部门未填"}）\n任职要求：${truncate(maskPii(job.requirements || job.description || ""), 800) || "未填写"}`;
    }
  }

  const STAGE_LABEL: Record<string, string> = {
    applied: "已投递", screening: "简历筛选", interview1: "初试", interview2: "复试",
    offer: "Offer", hired: "已入职", rejected: "已淘汰", withdrawn: "已放弃",
  };

  const system = `你是一名资深招聘负责人，基于候选人看板状态给招聘者一条明确的下一步动作建议。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- action: 动作类型，六选一："advance"（推进下一阶段）/ "arrange_interview"（安排面试）/ "push_offer"（推进 Offer 审批）/ "contact"（触达跟进）/ "standby"（转备选池）/ "drop"（建议淘汰）
- suggestion: 一句话动作建议，不超过 50 字，要带具体时间（如「本周内」「2 天内」）
- reasons: 2-3 条依据，每条不超过 35 字，必须引用给定事实（停留天数 / 备注 / 评分 / 面试安排）
- draft: 招聘者可直接发出的跟进话术草稿（对候选人或部门负责人），不超过 120 字

要求：
1. 只基于给定信息判断；备注为空、评分缺失时给保守建议（contact / standby），不要臆造。
2. 不要仅凭停留久就建议淘汰——没有备注佐证时先建议触达确认意向。
3. 话术语气专业、平等，不施压不推销。`;

  const userPrompt = `【候选人】\n${talentBrief(link)}\n\n【${jobText}】\n\n【看板状态】
当前阶段：${STAGE_LABEL[link.stage] || link.stage}
停留天数：${stageDays} 天
阶段评分：${link.rating != null ? `${link.rating} / 5` : "未评分"}
阶段备注：${truncate(maskPii(link.stage_notes || ""), 300) || "（无）"}
已排面试：${nextInterview ? `有，${nextInterview.scheduled_at}` : "无"}

请给出下一步动作建议。`;

  const raw = await deepseekJsonSafe(apiKey, system, userPrompt, { temperature: 0.4 });
  if (!raw) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }

  const ACTIONS = ["advance", "arrange_interview", "push_offer", "contact", "standby", "drop"];
  const suggestion = typeof raw.suggestion === "string" ? raw.suggestion.trim().slice(0, 60) : "";
  if (!suggestion) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }

  const result = {
    action: ACTIONS.includes(String(raw.action)) ? String(raw.action) : "contact",
    suggestion,
    reasons: toStringArray(raw.reasons, 3),
    draft: typeof raw.draft === "string" ? raw.draft.trim().slice(0, 200) : "",
  };
  await saveArtifact(c.env.DB, session.userId, "next_step", link.id, "", result);
  return c.json(result);
});

// ---------------------------------------------------------------- 待办 AI 今日重点
// 输入逾期/今日/未来 7 天的未完成待办，AI 排「今天先做什么」。
// 与复盘同模式：前端传聚合数据（待办为 owner 隔离数据）；scope = 日期+集合指纹，10 分钟缓存。
// AI 只做排序建议，不改动任何待办数据。
aiAssist.post("/today-focus", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req
    .json<{ scope?: string; items?: { title?: string; content?: string; priority?: string; due?: string; talent?: string; job?: string; source?: string }[] }>()
    .catch(() => null);
  if (!body?.items || !Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ error: "没有待排期的待办" }, 400);
  }
  const items = body.items.slice(0, 30);

  const scope = (body.scope || "all").slice(0, 160);
  const cached = await loadRecentArtifact(c.env.DB, session.userId, "today_focus", scope, "");
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = c.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法生成建议", code: "AI_NO_KEY" }, 500);
  }

  const system = `你是一名高效的 HR 助理，帮招聘者把待办排出「今天先做什么」。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- top3: 今天优先处理的 2-3 件事，每条格式「待办标题 — 一句话理由」，理由须引用给定事实（逾期天数 / 到期时间 / 关联人或岗位），不超过 40 字
- arrange: 一句话建议的处理顺序或时段安排（如「上午处理面试相关，下午跟进沟通」），不超过 40 字
- defer: 可放一放的待办 0-2 条，格式「待办标题 — 为什么可以缓」，没有就给空数组

排序依据（按重要度）：
1. 面试/审批类有时效的优先——错过窗口损失最大；
2. 逾期最久且关联人还在流程中的优先；
3. 同等条件参考优先级字段（高 > 中 > 低）；
4. 关联人已入职/已淘汰的待办可以缓。`;

  const userPrompt = `【待办列表（未完成，共 ${items.length} 条）】\n${truncate(
    JSON.stringify(items.map((x, i) => ({
      序号: i + 1,
      标题: x.title || "",
      说明: x.content || "",
      优先级: x.priority || "",
      到期: x.due || "",
      关联人才: x.talent || "",
      关联岗位: x.job || "",
      来源: x.source || "",
    }))),
    3000
  )}\n\n请排出今日重点。`;

  const raw = await deepseekJsonSafe(apiKey, system, userPrompt, { temperature: 0.3 });
  if (!raw) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }

  const result = {
    top3: toStringArray(raw.top3, 3),
    arrange: typeof raw.arrange === "string" ? raw.arrange.trim().slice(0, 60) : "",
    defer: toStringArray(raw.defer, 2),
  };
  if (!result.top3.length) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }

  await saveArtifact(c.env.DB, session.userId, "today_focus", scope, "", result);
  return c.json(result);
});

// ---------------------------------------------------------------- HR 侧 AI 改简历
// 把候选人简历精简、结构化并突出与目标岗位的匹配点，产出「优化稿」草稿。
// 入口：AI 助手页——可传简历原文 text，不传则按已录入字段生成。
// 产出为草稿，供 HR 参考后手动复制，不写回候选人记录。
aiAssist.post("/resume-optimize", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;

  const body = await c.req
    .json<{ talent_id?: string; job_id?: string | null; text?: string | null }>()
    .catch(() => null);
  if (!body?.talent_id) return c.json({ error: "缺少人才信息" }, 400);

  const ctx = await loadContext(c, session, body.talent_id, body.job_id);
  if (isResponse(ctx)) return ctx;
  const { talent, job } = ctx;

  const scene = "";
  const cached = await loadRecentArtifact(c.env.DB, session.userId, "resume_optimize", talent.id, scene);
  if (cached) return c.json({ ...cached, _cached: true });
  const denied = await quotaGuard(c, session.userId, session.role);
  if (denied) return denied;

  const apiKey = c.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 密钥，无法优化简历", code: "AI_NO_KEY" }, 500);
  }

  const system = `你是一名资深招聘顾问，擅长把简历改得更精炼、更有针对性。以严格的 JSON 对象返回，不要输出任何多余解释，不要用 markdown 代码块。

字段说明：
- headline: 一句话核心亮点（不超过 30 字，可放简历开头的定位句）
- optimized: 优化后的简历正文（纯文本，按 个人概述 / 核心技能 / 工作经历 / 教育背景 分区块，要点式，全文控制在 400 字以内）
- changes: 2-4 条关键改动说明（做了哪些精简、合并、突出），每条不超过 30 字
- tips: 1-3 条进一步优化建议（如建议补充哪些信息、面试可强调的点），每条不超过 30 字

要求：
1. 只做「精简 + 结构化 + 突出重点」，绝不编造经历、数字、学历或技能。
2. 有目标岗位时，围绕该岗位的关键要求组织并突出相关内容；没有则做通用优化。
3. 原文缺失的信息标注「（建议补充）」，不要虚构。
4. optimized 输出纯文本，不要使用 markdown 语法。`;

  const jdText = job
    ? `目标岗位：${job.title}（${job.department || "部门未填"}）\n任职要求：${truncate(maskPii(job.requirements || job.description || ""), 1500) || "未填写"}`
    : "目标岗位：暂未指定（按通用优化，HR 可自行补充岗位信息）";

  const resumeText = body.text ? truncate(maskPii(body.text)) : "";
  const userPrompt = `【候选人信息】\n${talentBrief(talent)}\n\n【简历原文】\n${resumeText || "（未提供原文，请仅依据上方已录入字段做合理优化，不要编造）"}\n\n【${jdText}】\n\n请生成优化后的简历稿。`;

  const raw = await deepseekJsonSafe(apiKey, system, userPrompt, { temperature: 0.4 });
  if (!raw) {
    return c.json({ error: "AI 暂时不可用，请稍后重试", code: "AI_UNAVAILABLE" }, 502);
  }

  const result = {
    headline: typeof raw.headline === "string" ? raw.headline.trim().slice(0, 60) : "",
    optimized: typeof raw.optimized === "string" ? raw.optimized.trim() : "",
    changes: toStringArray(raw.changes, 4),
    tips: toStringArray(raw.tips, 3),
  };
  if (!result.optimized) {
    return c.json({ error: "AI 未生成有效内容，请重试", code: "AI_EMPTY" }, 502);
  }

  await saveArtifact(c.env.DB, session.userId, "resume_optimize", talent.id, scene, result);
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

aiAssist.get("/resume-optimize", async (c) => {
  const session = await sessionOnly(c);
  if (session instanceof Response) return session;
  const talentId = c.req.query("talent_id");
  const denied = await requireTalent(c, session, talentId);
  if (isResponse(denied)) return denied;
  const content = await loadLatestArtifact(c.env.DB, session.userId, "resume_optimize", talentId!, "");
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

export default aiAssist;
