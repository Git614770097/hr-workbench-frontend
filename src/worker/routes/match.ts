import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { genId } from "../helpers";
import { deepseekJson, toStringArray } from "../ai";

// 智能匹配：候选人（上传简历或从人才库挑人）+ 职位画像（分级）→ 排序推荐 + 理由
// - 画像 = 一个职位（job_title）下挂多个「级别」（初级/中级/高级…），
//   每个级别有独立的年限区间、学历、技能、城市，以及对应的市场薪资。
// - JD 文本 → 结构化画像（AI 抽取，可人工改）
// - 画像 CRUD（按 owner_id 隔离，级别级联）
// - 单个候选人评分：按年限自动落位到级别，用该级别的硬指标做规则判定，
//   AI 做软性匹配与理由；无 key 或 AI 失败时规则兜底。
const match = new Hono<{ Bindings: Env }>();

// ---- 级别结构 ----
interface MatchLevel {
  id?: string;
  name: string;
  min_years: number | null;
  max_years: number | null;
  education: string;
  city: string;
  must_skills: string[];
  nice_skills: string[];
  requirements: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_note: string;
  sort_order: number;
}

// ---- 画像结构 ----
interface MatchProfile {
  name: string;
  job_title: string;
  city: string;
  education: string;
  min_years: number | null;
  max_years: number | null;
  salary_range: string;
  industry: string;
  must_skills: string[];
  nice_skills: string[];
  requirements: string;
  jd_raw: string;
  /** 分级（可为空数组，表示单一画像不分级） */
  levels: MatchLevel[];
}

/** 候选人结构化字段（前端解析好传过来，避免重复解析） */
interface CandidateParsed {
  name?: string;
  education?: string;
  years_experience?: number | null;
  city?: string;
  current_title?: string;
  current_company?: string;
  skills?: string[];
}

// ---- 工具 ----
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}
function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}
function strArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  if (typeof v === "string") {
    return v.split(/[,，、;；\n]+/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}
function safeJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  if (typeof v === "string" && v.trim()) {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(str).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ---- 硬性条件（规则判定，不依赖 AI）----
const EDU_RANK: Record<string, number> = {
  "高中及以下": 1, "中专": 2, "大专": 3, "本科": 4,
  "硕士": 5, "博士": 6, "MBA/EMBA": 5, "其他": 0,
};

interface HardCheck {
  education: { ok: boolean | null; actual: string; require: string };
  years: { ok: boolean | null; actual: number | null; require: string; over: boolean };
  city: { ok: boolean | null; actual: string; require: string };
  must_skills: { hit: string[]; miss: string[] };
  nice_skills: { hit: string[] };
}

/** 画像的「有效要求」：分级时取落位级别的字段，否则取画像本身的字段 */
interface EffectiveReq {
  education: string;
  min_years: number | null;
  max_years: number | null;
  city: string;
  must_skills: string[];
  nice_skills: string[];
  requirements: string;
}

function checkHard(profile: MatchProfile, parsed: CandidateParsed, text: string, req: EffectiveReq): HardCheck {
  let education: HardCheck["education"] = { ok: null, actual: str(parsed.education), require: req.education };
  if (req.education) {
    const rq = EDU_RANK[req.education] ?? 0;
    const act = EDU_RANK[str(parsed.education)] ?? null;
    education = { ok: act == null ? null : act >= rq, actual: str(parsed.education), require: req.education };
  }

  const min = numOrNull(req.min_years);
  const max = numOrNull(req.max_years);
  const years = numOrNull(parsed.years_experience);
  const requireText =
    min != null || max != null
      ? `${min != null ? min : "不限"} - ${max != null ? max : "不限"} 年`
      : "";
  let yearsCheck: HardCheck["years"] = { ok: null, actual: years, require: requireText, over: false };
  if (min != null || max != null) {
    const over = max != null && years != null && years > max;
    yearsCheck = {
      ok: years == null ? null : (min == null || years >= min),
      actual: years,
      require: requireText,
      over,
    };
  }

  const cityRequire = str(req.city);
  const cityActual = str(parsed.city);
  const city: HardCheck["city"] = cityRequire
    ? {
        ok: cityActual ? cityActual.includes(cityRequire) || cityRequire.includes(cityActual) : null,
        actual: cityActual,
        require: cityRequire,
      }
    : { ok: null, actual: cityActual, require: "" };

  const hay = `${text}\n${(parsed.skills || []).join(" ")}`.toLowerCase();
  const hit: string[] = [];
  const miss: string[] = [];
  for (const s of req.must_skills || []) {
    (hay.includes(s.toLowerCase()) ? hit : miss).push(s);
  }
  const niceHit = (req.nice_skills || []).filter((s) => hay.includes(s.toLowerCase()));

  return { education, years: yearsCheck, city, must_skills: { hit, miss }, nice_skills: { hit: niceHit } };
}

/** 无 AI 时的规则兜底评分 */
function ruleScore(hard: HardCheck): { score: number; verdict: string; summary: string } {
  let score = 55;
  if (hard.education.ok === true) score += 10;
  else if (hard.education.ok === false) score -= 12;
  if (hard.years.ok === true) score += 10;
  else if (hard.years.ok === false) score -= 10;
  if (hard.city.ok === true) score += 6;
  else if (hard.city.ok === false) score -= 6;

  const total = hard.must_skills.hit.length + hard.must_skills.miss.length;
  if (total > 0) {
    score += Math.round((hard.must_skills.hit.length / total) * 20);
    score -= Math.round((hard.must_skills.miss.length / total) * 15);
  }
  score += Math.min(hard.nice_skills.hit.length * 4, 12);
  score = Math.max(0, Math.min(100, score));

  const verdict = score >= 80 ? "推荐" : score >= 65 ? "可考虑" : "不建议";
  const missText = hard.must_skills.miss.length ? `缺 ${hard.must_skills.miss.join("、")}` : "必备技能齐全";
  return { score, verdict, summary: `按硬性条件估算（未启用 AI）：${missText}` };
}

// ---- 级别落位：按年限挑出最匹配的级别 ----
// 规则：年限落在某级别 [min, max) 区间内则命中；
// 低于最低级别 → 落在最低级别但标记 below；高于最高级别 → 落在最高级别但标记 above。
function pickLevel(profile: MatchProfile, years: number | null): {
  level: MatchLevel | null;
  below: boolean;
  above: boolean;
  nextLevelName: string | null;
  gapYears: number | null;
} {
  const levels = [...(profile.levels || [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  if (levels.length === 0) return { level: null, below: false, above: false, nextLevelName: null, gapYears: null };
  if (years == null) {
    // 没年限信息时无法落位，用第一级（最低）作为参考，但不做年限判定
    return { level: levels[0], below: false, above: false, nextLevelName: null, gapYears: null };
  }
  // 按 sort_order 找到第一个「上限为空或 years <= 上限」的级别
  let idx = levels.length - 1;
  for (let i = 0; i < levels.length; i++) {
    const max = levels[i].max_years;
    if (max == null || years <= max) { idx = i; break; }
  }
  const level = levels[idx];
  const below = idx === 0 && (level.min_years != null && years < level.min_years);
  const above = idx === levels.length - 1 && (level.max_years != null && years > level.max_years);
  const nextLevelName = below ? level.name : above ? null : null;
  const gapYears = below && level.min_years != null ? level.min_years - years : null;
  return { level, below, above, nextLevelName, gapYears };
}

// ---- 画像 → 有效要求（分级优先）----
function effectiveReq(profile: MatchProfile, level: MatchLevel | null): EffectiveReq {
  if (level) {
    return {
      education: level.education || profile.education,
      min_years: level.min_years,
      max_years: level.max_years,
      city: level.city || profile.city,
      must_skills: level.must_skills.length > 0 ? level.must_skills : profile.must_skills,
      nice_skills: level.nice_skills.length > 0 ? level.nice_skills : profile.nice_skills,
      requirements: level.requirements || profile.requirements,
    };
  }
  return {
    education: profile.education,
    min_years: profile.min_years,
    max_years: profile.max_years,
    city: profile.city,
    must_skills: profile.must_skills,
    nice_skills: profile.nice_skills,
    requirements: profile.requirements,
  };
}

// ---- JD → 结构化画像（含可选分级）----
const PROFILE_SYSTEM = `你是资深招聘顾问。请把用户给的招聘需求（JD）提炼成结构化「人物画像」，严格返回 JSON 对象，不要输出多余解释。

字段：
- name: 画像名称，简短，如「前端开发工程师」（15 字以内）
- job_title: 目标职位名称
- city: 工作城市（只要城市名，不要"市"字；没写则空字符串）
- education: 学历门槛，取值限定：高中及以下 / 中专 / 大专 / 本科 / 硕士 / 博士 / MBA/EMBA / 其他；没写则空字符串
- min_years: 经验年限下限（整数，没写则 null）
- max_years: 经验年限上限（整数，没写或不限则 null）
- salary_range: 薪资范围原文（如"20-35K·13薪"），没写则空字符串
- industry: 行业背景要求（没写则空字符串）
- must_skills: 必备技能数组（硬要求，3-8 个干净关键词，如 "React"、"TypeScript"）
- nice_skills: 加分技能数组（1-6 个）
- requirements: 其它要求（软性素质、管理经验、学历院校等，一段话概括，100 字以内）
- levels: 分级数组（如果 JD 里明确区分了初级/中级/高级等不同级别的要求，则为每个级别生成一项；否则返回空数组 []）。每项字段：
  - name: 级别名（初级/中级/高级/资深等）
  - min_years / max_years: 该级别年限区间（整数，可为 null）
  - education: 该级别学历门槛（可为空字符串，表示沿用整体）
  - city: 该级别城市（可为空字符串）
  - must_skills / nice_skills: 该级别技能（可为空数组，表示沿用整体）
  - requirements: 该级别补充要求（可为空字符串）
  - salary_min / salary_max: 该级别市场月薪（整数，单位元；没写则 null）
  - salary_note: 该级别薪资说明（可为空字符串）
  - sort_order: 级别排序（整数，初级=0 起递增）

要求：
1. 只提炼 JD 里真实写到的内容，不要臆造、不要自行补充行业标准要求。
2. 区分硬要求与加分项：写了"优先""加分""熟悉者优先"的进 nice_skills，其余进 must_skills。
3. must_skills / nice_skills 的元素必须是简短关键词，不要写句子。
4. levels 只在 JD 确实区分级别时生成，不要为了凑结构硬造。`;

// ---- 候选人评分 ----
const SCORE_SYSTEM = `你是资深招聘顾问，负责评估候选人与「人物画像」的匹配度。我会给你一份画像（可能含分级级别）和一份候选人简历，请输出严格的 JSON 对象。

输出字段：
- score: 0-100 的整数。硬性条件（学历/年限/城市/必备技能）不满足要明显扣分；经历与画像越贴合分越高。
- verdict: "强烈推荐" / "推荐" / "可考虑" / "不建议" 四选一
- summary: 一句话结论，40 字以内
- reasons: 2-4 条推荐理由。每条不超过 30 字，必须引用简历里的事实（公司、项目、年限、技能），不要写空话。
- gaps: 1-3 条与画像的差距（没有则空数组）
- risks: 1-3 条用人风险（跳槽频繁、空窗期、学历/年限不达预期等；没有则空数组）
- questions: 1-2 条面试时建议追问的问题

要求：
1. 只依据简历里真实存在的信息，绝不臆造。
2. 简历信息不足时（如没写学历、年限推断不出），在 gaps 里明确说"简历未体现"，并把 score 压在中低区间，不要给虚高分。
3. reasons 要具体到简历内容，避免"沟通能力强"这类无法佐证的评价。`;

// ---- 画像序列化（DB 行 → 前端结构）----
function serializeProfile(r: any, levels: any[]): MatchProfile {
  return {
    name: r.name,
    job_title: str(r.job_title),
    city: str(r.city),
    education: str(r.education),
    min_years: numOrNull(r.min_years),
    max_years: numOrNull(r.max_years),
    salary_range: str(r.salary_range),
    industry: str(r.industry),
    must_skills: safeJsonArray(r.must_skills),
    nice_skills: safeJsonArray(r.nice_skills),
    requirements: str(r.requirements),
    jd_raw: str(r.jd_raw),
    levels: levels.map((l: any) => ({
      id: l.id,
      name: str(l.name),
      min_years: numOrNull(l.min_years),
      max_years: numOrNull(l.max_years),
      education: str(l.education),
      city: str(l.city),
      must_skills: safeJsonArray(l.must_skills),
      nice_skills: safeJsonArray(l.nice_skills),
      requirements: str(l.requirements),
      salary_min: numOrNull(l.salary_min),
      salary_max: numOrNull(l.salary_max),
      salary_note: str(l.salary_note),
      sort_order: numOrNull(l.sort_order) ?? 0,
    })),
  };
}

match.post("/parse-profile", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const body = await c.req.json<{ jd: string }>().catch(() => null);
  const jd = str(body?.jd);
  if (jd.length < 10) return c.json({ error: "招聘需求内容太短，无法提炼画像" }, 400);

  const apiKey = c.env.DEEPSEEK_API_KEY;
  if (!apiKey) return c.json({ error: "未配置 AI 密钥，无法自动生成画像，请手动填写" }, 500);

  try {
    const raw = await deepseekJson(apiKey, PROFILE_SYSTEM, `请把下面这段招聘需求提炼成人物画像：\n\n${jd.slice(0, 6000)}`);
    if (!raw) return c.json({ error: "AI 未能生成有效画像" }, 422);
    const rawLevels = Array.isArray(raw.levels) ? raw.levels : [];
    const levels: MatchLevel[] = rawLevels.map((lv: any, i: number) => ({
      name: str(lv.name) || `级别 ${i + 1}`,
      min_years: numOrNull(lv.min_years),
      max_years: numOrNull(lv.max_years),
      education: str(lv.education),
      city: str(lv.city),
      must_skills: strArr(lv.must_skills),
      nice_skills: strArr(lv.nice_skills),
      requirements: str(lv.requirements),
      salary_min: numOrNull(lv.salary_min),
      salary_max: numOrNull(lv.salary_max),
      salary_note: str(lv.salary_note),
      sort_order: numOrNull(lv.sort_order) ?? i,
    })).filter((lv) => lv.name);
    const profile: MatchProfile = {
      name: str(raw.name) || str(raw.job_title) || "画像",
      job_title: str(raw.job_title),
      city: str(raw.city),
      education: str(raw.education),
      min_years: numOrNull(raw.min_years),
      max_years: numOrNull(raw.max_years),
      salary_range: str(raw.salary_range),
      industry: str(raw.industry),
      must_skills: strArr(raw.must_skills),
      nice_skills: strArr(raw.nice_skills),
      requirements: str(raw.requirements),
      jd_raw: jd.slice(0, 4000),
      levels,
    };
    return c.json(profile);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "画像生成失败" }, 502);
  }
});

// ---- 画像列表（含级别）----
match.get("/profiles", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  let sql = "SELECT id, owner_id, name, job_title, city, education, min_years, max_years, salary_range, industry, must_skills, nice_skills, requirements, jd_raw, created_at, updated_at FROM match_profiles";
  const params: string[] = [];
  if (session.role !== "admin") {
    sql += " WHERE owner_id = ?";
    params.push(session.userId);
  }
  sql += " ORDER BY updated_at DESC";
  const rows = await c.env.DB.prepare(sql).bind(...params).all();

  const items: any[] = [];
  for (const r of rows.results as any[]) {
    const lvRows = await c.env.DB.prepare(
      "SELECT * FROM match_profile_levels WHERE profile_id = ? ORDER BY sort_order ASC"
    ).bind(r.id).all();
    items.push({
      id: r.id,
      ...serializeProfile(r, lvRows.results || []),
      created_at: r.created_at,
      updated_at: r.updated_at,
    });
  }
  return c.json(items);
});

match.post("/profiles", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const body = await c.req.json<Partial<MatchProfile>>().catch(() => null);
  const name = str(body?.name);
  if (!name) return c.json({ error: "请填写画像名称" }, 400);

  const id = genId();
  const levels = Array.isArray(body?.levels) ? body!.levels : [];

  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO match_profiles (id, owner_id, name, job_title, city, education, min_years, max_years, salary_range, industry, must_skills, nice_skills, requirements, jd_raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, session.userId, name,
      str(body?.job_title) || null,
      str(body?.city) || null,
      str(body?.education) || null,
      numOrNull(body?.min_years),
      numOrNull(body?.max_years),
      str(body?.salary_range) || null,
      str(body?.industry) || null,
      JSON.stringify(strArr(body?.must_skills)),
      JSON.stringify(strArr(body?.nice_skills)),
      str(body?.requirements) || null,
      str(body?.jd_raw) || null,
    ),
  ];
  levels.forEach((lv, i) => {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO match_profile_levels (id, profile_id, name, min_years, max_years, education, city, must_skills, nice_skills, requirements, salary_min, salary_max, salary_note, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        genId(), id, str(lv.name), numOrNull(lv.min_years), numOrNull(lv.max_years),
        str(lv.education) || null, str(lv.city) || null,
        JSON.stringify(strArr(lv.must_skills)), JSON.stringify(strArr(lv.nice_skills)),
        str(lv.requirements) || null, numOrNull(lv.salary_min), numOrNull(lv.salary_max),
        str(lv.salary_note) || null, numOrNull(lv.sort_order) ?? i,
      )
    );
  });
  await c.env.DB.batch(stmts);
  return c.json({ id });
});

match.put("/profiles/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  let sql = "SELECT id FROM match_profiles WHERE id = ?";
  const params: string[] = [id];
  if (session.role !== "admin") {
    sql += " AND owner_id = ?";
    params.push(session.userId);
  }
  const existing = await c.env.DB.prepare(sql).bind(...params).first();
  if (!existing) return c.json({ error: "画像不存在" }, 404);

  const body = await c.req.json<Partial<MatchProfile>>().catch(() => null);
  if (!body) return c.json({ error: "缺少更新内容" }, 400);

  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (body.name !== undefined) { sets.push("name = ?"); vals.push(str(body.name) || null); }
  if (body.job_title !== undefined) { sets.push("job_title = ?"); vals.push(str(body.job_title) || null); }
  if (body.city !== undefined) { sets.push("city = ?"); vals.push(str(body.city) || null); }
  if (body.education !== undefined) { sets.push("education = ?"); vals.push(str(body.education) || null); }
  if (body.min_years !== undefined) { sets.push("min_years = ?"); vals.push(numOrNull(body.min_years)); }
  if (body.max_years !== undefined) { sets.push("max_years = ?"); vals.push(numOrNull(body.max_years)); }
  if (body.salary_range !== undefined) { sets.push("salary_range = ?"); vals.push(str(body.salary_range) || null); }
  if (body.industry !== undefined) { sets.push("industry = ?"); vals.push(str(body.industry) || null); }
  if (body.must_skills !== undefined) { sets.push("must_skills = ?"); vals.push(JSON.stringify(strArr(body.must_skills))); }
  if (body.nice_skills !== undefined) { sets.push("nice_skills = ?"); vals.push(JSON.stringify(strArr(body.nice_skills))); }
  if (body.requirements !== undefined) { sets.push("requirements = ?"); vals.push(str(body.requirements) || null); }
  if (body.jd_raw !== undefined) { sets.push("jd_raw = ?"); vals.push(str(body.jd_raw) || null); }

  const stmts = [];
  if (sets.length > 0) {
    sets.push("updated_at = datetime('now')");
    stmts.push(c.env.DB.prepare(`UPDATE match_profiles SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id));
  }

  // 级别：整组重建（先删后插），保证与前端提交的 levels 完全一致
  if (body.levels !== undefined) {
    stmts.push(c.env.DB.prepare("DELETE FROM match_profile_levels WHERE profile_id = ?").bind(id));
    (Array.isArray(body.levels) ? body.levels : []).forEach((lv, i) => {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO match_profile_levels (id, profile_id, name, min_years, max_years, education, city, must_skills, nice_skills, requirements, salary_min, salary_max, salary_note, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          genId(), id, str(lv.name), numOrNull(lv.min_years), numOrNull(lv.max_years),
          str(lv.education) || null, str(lv.city) || null,
          JSON.stringify(strArr(lv.must_skills)), JSON.stringify(strArr(lv.nice_skills)),
          str(lv.requirements) || null, numOrNull(lv.salary_min), numOrNull(lv.salary_max),
          str(lv.salary_note) || null, numOrNull(lv.sort_order) ?? i,
        )
      );
    });
  }

  if (stmts.length > 0) await c.env.DB.batch(stmts);
  return c.json({ id });
});

match.delete("/profiles/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  let sql = "DELETE FROM match_profiles WHERE id = ?";
  const params: string[] = [id];
  if (session.role !== "admin") {
    sql = "DELETE FROM match_profiles WHERE id = ? AND owner_id = ?";
    params.push(session.userId);
  }
  await c.env.DB.prepare(sql).bind(...params).run();
  return c.json({ ok: true });
});

// ---- 单个候选人评分 ----
// 逐份调用（前端串行调用并展示进度），避免一个请求跑太久被超时中断。
match.post("/score", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const body = await c.req.json<{ profile?: MatchProfile; candidate?: { text?: string; parsed?: CandidateParsed } }>().catch(() => null);
  const profile = body?.profile;
  const text = str(body?.candidate?.text);
  if (!profile) return c.json({ error: "缺少人物画像" }, 400);
  if (text.length < 10) return c.json({ error: "简历内容为空，无法评估" }, 400);

  const parsed: CandidateParsed = body?.candidate?.parsed || {};

  // 按年限落位到级别
  const picked = pickLevel(profile, numOrNull(parsed.years_experience));
  const req = effectiveReq(profile, picked.level);
  const hard = checkHard(profile, parsed, text, req);

  // 级别落位信息（用于前端展示「属于哪个级别 / 离上一档差几年 / 该级别市场薪资」）
  const levelInfo = picked.level
    ? {
        name: picked.level.name,
        min_years: picked.level.min_years,
        max_years: picked.level.max_years,
        salary_min: picked.level.salary_min,
        salary_max: picked.level.salary_max,
        salary_note: picked.level.salary_note,
        below: picked.below,
        above: picked.above,
        next_level: picked.nextLevelName,
        gap_years: picked.gapYears,
      }
    : null;

  const profileBrief = {
    目标职位: profile.job_title || "（未指定）",
    城市: req.city || "不限",
    学历门槛: req.education || "不限",
    经验要求: hard.years.require || "不限",
    薪资范围: picked.level?.salary_min != null
      ? `${picked.level.salary_min}-${picked.level.salary_max ?? "不限"} 元/月${picked.level.salary_note ? `（${picked.level.salary_note}）` : ""}`
      : (profile.salary_range || "未写"),
    行业背景: profile.industry || "不限",
    必备技能: req.must_skills || [],
    加分技能: req.nice_skills || [],
    其它要求: req.requirements || "无",
    ...(picked.level ? { 匹配级别: picked.level.name } : {}),
  };

  const apiKey = c.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    const fb = ruleScore(hard);
    return c.json({
      ...fb,
      reasons: [], gaps: [], risks: [], questions: [],
      hard, level: levelInfo, source: "rule",
    });
  }

  try {
    const raw = await deepseekJson(
      apiKey,
      SCORE_SYSTEM,
      `【人物画像】\n${JSON.stringify(profileBrief, null, 2)}\n\n【候选人简历】\n${text.slice(0, 6000)}`
    );
    if (!raw) throw new Error("AI 未返回有效结果");
    const scoreRaw = numOrNull(raw.score) ?? 0;
    const score = Math.max(0, Math.min(100, Math.round(scoreRaw)));
    return c.json({
      score,
      verdict: str(raw.verdict) || (score >= 85 ? "强烈推荐" : score >= 70 ? "推荐" : score >= 55 ? "可考虑" : "不建议"),
      summary: str(raw.summary),
      reasons: toStringArray(raw.reasons, 4),
      gaps: toStringArray(raw.gaps, 3),
      risks: toStringArray(raw.risks, 3),
      questions: toStringArray(raw.questions, 2),
      hard,
      level: levelInfo,
      source: "ai",
    });
  } catch (err) {
    const fb = ruleScore(hard);
    return c.json({
      ...fb,
      reasons: [],
      gaps: [err instanceof Error ? `AI 评估失败，已按硬性条件估算：${err.message}` : "AI 评估失败，已按硬性条件估算"],
      risks: [], questions: [],
      hard, level: levelInfo, source: "rule",
    });
  }
});

export default match;
