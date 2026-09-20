import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";

// AI 简历解析接口
// 前端把简历文本（或文件 base64）发到这里，后端用 DEEPSEEK_API_KEY 调 DeepSeek，
// 返回结构化字段。Key 存在 Worker secret 里，不暴露给前端，防止盗刷。
const aiParse = new Hono<{ Bindings: Env }>();

// 期望 AI 返回的字段（与前端 ParsedTalent / Talent 表结构对齐）
interface ParsedResume {
  name: string;
  phone: string;
  email: string;
  age: number | null;
  gender: string;
  education: string;
  school: string;
  current_company: string;
  current_title: string;
  years_experience: number | null;
  city: string;
  skills: string[];
  birth_date: string;
}

const EMPTY: ParsedResume = {
  name: "",
  phone: "",
  email: "",
  age: null,
  gender: "",
  education: "",
  school: "",
  current_company: "",
  current_title: "",
  years_experience: null,
  city: "",
  skills: [],
  birth_date: "",
};

// 把 AI 返回的 JSON 里可能出现的字符串数字/数组做归一化
function normStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}
function normNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}
function normSkills(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(normStr).filter(Boolean);
  if (typeof v === "string") {
    return v.split(/[,，、/;；\s]+/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

// 从 AI 返回内容里稳健地抽出 JSON 对象（兼容被 ```json 包裹 / 前后有杂文的情况）
function extractJson(text: string): Record<string, unknown> | null {
  // 去掉 markdown 代码块围栏
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 直接解析
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Record<string, unknown>;
  } catch {
    /* fallthrough */
  }
  // 截取第一个 { 到最后一个 } 之间的内容再解析
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(s.slice(start, end + 1));
      if (obj && typeof obj === "object") return obj as Record<string, unknown>;
    } catch {
      /* fallthrough */
    }
  }
  return null;
}

// 调用 DeepSeek chat/completions，把简历文本解析为结构化字段
async function callDeepSeek(apiKey: string, resumeText: string): Promise<Record<string, unknown> | null> {
  const systemPrompt = `你是一名专业的简历信息提取助手。请从用户提供的简历文本中，精准提取以下字段，并以严格的 JSON 对象返回（不要输出任何多余解释，不要用 markdown 代码块）。

字段说明：
- name: 姓名（中文名直接写中文；英文名保留原样；复姓/少数民族"·"名要完整）
- phone: 手机号（11位数字，去除空格和横线）
- email: 邮箱（转小写）
- age: 年龄（整数；简历没写年龄但从出生日期可推算的，请按当前年份推算）
- gender: 性别（"男"或"女"，没有则空字符串）
- education: 学历，取值限定为：博士 / 硕士 / 本科 / 大专 / 中专 / 高中及以下 / MBA/EMBA（必须严格从这些里选一个，如"硕士研究生"→"硕士"）
- school: 毕业院校（最高学历对应的学校）
- current_company: 当前/最近一家公司的名称
- current_title: 当前/最近一个职位名称
- years_experience: 工作年限（整数，没有则 null）
- city: 现居城市（只要城市名，如"北京"，不要带"市"字）
- skills: 技能列表（字符串数组，提取技术栈/工具/专业技能关键词）
- birth_date: 出生日期，格式 YYYY-MM-DD（没有则空字符串）

要求：
1. 简历里确实没有的字段，一律用 null（字符串字段用空字符串 ""，数字字段用 null），不要臆造。
2. 姓名、手机号务必准确，这是最重要的两个字段。
3. skills 数组元素要是干净的关键词（如 "Java"、"Spring Boot"、"MySQL"），不要整句。`;

  const userPrompt = `请解析以下简历文本：\n\n${resumeText.slice(0, 6000)}`;

  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      response_format: { type: "json_object" },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`DeepSeek 调用失败 (${resp.status}): ${body.slice(0, 200)}`);
  }

  const data = (await resp.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;
  return extractJson(content);
}

// 把 AI 返回的原始 JSON 归一化成标准 ParsedResume
function normalizeAiResult(raw: Record<string, unknown>): ParsedResume {
  return {
    name: normStr(raw.name),
    phone: normStr(raw.phone).replace(/\D/g, ""),
    email: normStr(raw.email).toLowerCase(),
    age: normNum(raw.age),
    gender: normStr(raw.gender) === "女" ? "女" : normStr(raw.gender) === "男" ? "男" : "",
    education: normStr(raw.education),
    school: normStr(raw.school),
    current_company: normStr(raw.current_company),
    current_title: normStr(raw.current_title),
    years_experience: normNum(raw.years_experience),
    city: normStr(raw.city).replace(/[市省县区]$/, ""),
    skills: normSkills(raw.skills),
    birth_date: normStr(raw.birth_date).match(/^\d{4}-\d{2}-\d{2}/)?.[0] || "",
  };
}

aiParse.post("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const apiKey = c.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return c.json({ error: "未配置 AI 解析密钥" }, 500);
  }

  const body = await c.req.json<{ text: string }>().catch(() => null);
  if (!body || !body.text || !body.text.trim()) {
    return c.json({ error: "缺少简历文本" }, 400);
  }
  const resumeText = body.text.trim();
  if (resumeText.length < 10) {
    return c.json({ error: "简历文本过短，无法解析" }, 400);
  }

  try {
    const raw = await callDeepSeek(apiKey, resumeText);
    if (!raw) {
      return c.json({ error: "AI 未能解析出有效结果" }, 422);
    }
    return c.json(normalizeAiResult(raw));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI 解析失败";
    return c.json({ error: msg }, 502);
  }
});

export default aiParse;
