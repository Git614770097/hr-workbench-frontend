import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { sanitizeField, sanitizeSkills } from "../../utils/fieldSanity";
import { normalizeEducation, normalizeGender } from "../../utils/resumeParser";

import { deepseekJsonSafe, deepseekOcrImage } from "../ai";
import type { AiKeyInput } from "../ai";
import { resolveAiKey } from "../aiKey";
import { extractDocText, extractPageJpegs, DocError } from "../docText";
import { arrayBufferToBase64 } from "../helpers";

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
  major: string;
  current_company: string;
  current_title: string;
  years_experience: number | null;
  city: string;
  skills: string[];
}

const EMPTY: ParsedResume = {
  name: "",
  phone: "",
  email: "",
  age: null,
  gender: "",
  education: "",
  school: "",
  major: "",
  current_company: "",
  current_title: "",
  years_experience: null,
  city: "",
  skills: [],
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

// 调用 DeepSeek chat/completions，把简历文本解析为结构化字段
async function callDeepSeek(apiKey: AiKeyInput, resumeText: string): Promise<Record<string, unknown> | null> {
  const systemPrompt = `你是一名专业的简历信息提取助手。请从用户提供的简历文本中，精准提取以下字段，并以严格的 JSON 对象返回（不要输出任何多余解释，不要用 markdown 代码块）。

字段说明：
- name: 姓名（中文名直接写中文；英文名保留原样；复姓/少数民族"·"名要完整）
- phone: 手机号（11位数字，去除空格和横线）
- email: 邮箱（转小写）
- age: 年龄（整数；简历没写年龄但从出生日期可推算的，请按当前年份推算）
- gender: 性别（"男"或"女"，没有则空字符串）
- education: 学历，取值限定为：博士 / 硕士 / 本科 / 大专 / 中专 / 高中及以下 / MBA/EMBA（必须严格从这些里选一个，如"硕士研究生"→"硕士"）
- school: 毕业院校（最高学历对应的学校）
- major: 所学专业（最高学历对应的就读专业名称，如"计算机科学与技术""工商管理"；没有则空字符串）
- current_company: 当前/最近一家公司的名称
- current_title: 当前/最近一个职位名称
- years_experience: 工作年限（整数，没有则 null）
- city: 现居城市（只要城市名，如"北京"，不要带"市"字）
- skills: 技能列表（字符串数组，提取技术栈/工具/专业技能关键词）

要求：
1. 简历里确实没有的字段，一律用 null（字符串字段用空字符串 ""，数字字段用 null），不要臆造。
2. 姓名、手机号务必准确，这是最重要的两个字段。
3. skills 数组元素要是干净的关键词（如 "Java"、"Spring Boot"、"MySQL"），不要整句。
4. current_company 必须是公司名称。不要填年份、日期、时间段、学校名或学位，
   例如简历里写"2013.2-至今  广东行致互联科技有限公司"，应填"广东行致互联科技有限公司"而不是"2013"。
5. name 必须是人的姓名。不要填城市、省份、职位或章节标题。
6. 一律不要编造：拿不准的字段留空，比填一个错误的答案更有价值。
7. 若简历有多段工作经历，current_company / current_title 取时间最新（含"至今/现在/在职"）的那一段，不要取最早一段或教育经历。
8. skills 也要覆盖非技术岗位的能力与行业关键词（如"团队管理""招聘""薪酬体系"），不要只列技术栈。`;

  const userPrompt = `请解析以下简历文本：\n\n${resumeText.slice(0, 14000)}`;

  return deepseekJsonSafe(apiKey, systemPrompt, userPrompt);
}

// 把 AI 返回的原始 JSON 归一化成标准 ParsedResume
// 关键：对 name / current_company / current_title / school / city 做合理性校验。
// AI 偶尔会把年份当公司名（线上真实出现过 current_company = "2013"）、把城市当姓名
// （name = "广州"）。这类值"看起来有值"，核对弹窗不会提示待填，比空值更危险，
// 因此校验不通过就清空，让问题直接暴露在核对弹窗里。
function normalizeAiResult(raw: Record<string, unknown>): ParsedResume {
  const phone = normStr(raw.phone).replace(/\D/g, "");
  const email = normStr(raw.email).toLowerCase();
  const age = normNum(raw.age);
  return {
    name: sanitizeField("name", normStr(raw.name)),
    phone: /^1[3-9]\d{9}$/.test(phone) ? phone : "",
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "",
    age: age != null && age >= 16 && age <= 80 ? age : null,
    gender: normalizeGender(normStr(raw.gender)),
    education: normalizeEducation(normStr(raw.education)),
    school: sanitizeField("school", normStr(raw.school)),
    major: sanitizeField("major", normStr(raw.major)),
    current_company: sanitizeField("current_company", normStr(raw.current_company)),
    current_title: sanitizeField("current_title", normStr(raw.current_title)),
    years_experience: normNum(raw.years_experience),
    city: sanitizeField("city", normStr(raw.city).replace(/[市省县区]$/, "")),
    skills: sanitizeSkills(normSkills(raw.skills)),
  };
}

aiParse.post("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const apiKey = await resolveAiKey(c.env, session.userId);
  if (!apiKey.key && !apiKey.zhipu) {
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

  // deepseekJsonSafe：AI 超时/失败时返回 null 而非抛错，降级为空字段让用户手动填写
  const raw = await callDeepSeek(apiKey, resumeText);
  if (!raw) {
    // AI 不可用时回退空字段，前端导入弹窗仍可展示，用户手动核对录入
    return c.json({ ...EMPTY, _ai_fallback: true });
  }
  return c.json(normalizeAiResult(raw));
});

/**
 * 文件直传解析：前端把简历文件二进制 POST 上来，Worker 抽文本（+ 可选 AI 解析）。
 *
 * 为什么要这个接口：浏览器端解析必须先下载 pdfjs 引擎（1.4MB worker + 0.8MB 主库），
 * 弱网下要几分钟；上传简历本身（几百 KB）快一个数量级。
 *
 * query:
 *   name  文件名（带扩展名，用于判断 pdf/docx；前端已 encodeURIComponent）
 *   ai=0  只抽文本不跑 AI（人才库简历预览用），默认跑
 */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * 图片型 PDF 的兜底：把整页图交给视觉模型转录成文字。
 *
 * 为什么只做「转录」不做「直接抽字段」：转录是视觉模型最稳的任务，
 * 字段抽取交给后面已经调好的 DeepSeek + 本地规则管线。这样即使模型
 * 这一轮状态不好，也只是文字质量差一点，而不是整份简历全空。
 * 附带好处：转录出的文字会回填到核对弹窗左侧的「简历原文」，
 * 扫描件用户第一次能在界面上看到内容。
 *
 * 为什么只取前 2 页：简历正文基本都在前两页；每页一次视觉调用要十几秒，
 * 前端等的是 120s，取多了必然超时。第 3 页起的内容对招聘决策价值很低。
 */
const OCR_MAX_PAGES = 2;

const OCR_PROMPT = `请把这张图片里的全部文字完整转录出来，用于简历信息提取。要求：
1. 只输出文字本身，不要总结、不要解释、不要加任何前后缀或标记；
2. 保持原有的分行与段落顺序；
3. 表格式排版按「字段名: 值」逐行输出；
4. 看不清的字用「□」代替，绝对不要猜测或编造。`;

async function ocrScannedPdf(
  apiKey: string,
  buf: Uint8Array,
  model?: string | null
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const pages = extractPageJpegs(buf, OCR_MAX_PAGES);
  if (pages.length === 0) {
    return { ok: false, reason: "这份 PDF 里取不出整页图片（可能是 JBIG2/CCITT 压缩）" };
  }

  const texts: string[] = [];
  for (const jpg of pages) {
    // Uint8Array 的 buffer 可能比视图大（subarray 出来的），必须按 byteOffset 精确切
    const ab = jpg.buffer.slice(jpg.byteOffset, jpg.byteOffset + jpg.byteLength) as ArrayBuffer;
    const r = await deepseekOcrImage(apiKey, arrayBufferToBase64(ab), OCR_PROMPT, model);
    if (!r.ok) {
      // 一页失败就整体算失败：半份简历比没有更危险（缺的那半不会被发现）
      return { ok: false, reason: r.reason || "识别失败" };
    }
    // 截断不判失败（有上半页总比没有强），但必须留痕：
    // 线上如果频繁出现，说明 max_tokens 或 thinking 配置退化了。
    if (r.truncated) {
      console.log(`[ai] OCR 输出被截断，第 ${texts.length + 1} 页后续内容缺失`);
    }
    texts.push(r.text.trim());
  }

  const text = texts.join("\n\n");
  if (text.length < 30) return { ok: false, reason: "识别结果为空" };
  return { ok: true, text };
}

aiParse.post("/file", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const fileName = c.req.query("name") || "";
  const wantAi = c.req.query("ai") !== "0";

  // 先用声明的长度挡掉超大文件，避免把几十 MB 全读进内存
  const declared = Number(c.req.header("content-length") || 0);
  if (declared > MAX_FILE_BYTES) {
    return c.json({ error: "文件超过 20MB，请压缩后再上传" }, 413);
  }

  const ab = await c.req.arrayBuffer();
  if (ab.byteLength === 0) return c.json({ error: "文件内容为空" }, 400);
  if (ab.byteLength > MAX_FILE_BYTES) {
    return c.json({ error: "文件超过 20MB，请压缩后再上传" }, 413);
  }

  // Key 延迟解析并缓存：普通文本 PDF 用不到它，没必要为每次预览都查一次库；
  // 但扫描件要 OCR、以及后面的 AI 抽取都要用，所以只查一次、两处共用。
  let cachedKey: Awaited<ReturnType<typeof resolveAiKey>> | null = null;
  const getKey = async () => (cachedKey ??= await resolveAiKey(c.env, session.userId));

  const bytes = new Uint8Array(ab);
  let text: string;
  /** 这份文本是不是 OCR 出来的（前端据此提示「已识别图片文字，请重点核对」） */
  let ocrUsed = false;

  try {
    ({ text } = await extractDocText(bytes, fileName));
  } catch (e) {
    if (!(e instanceof DocError)) {
      console.log(`[ai] 文件解析异常 ${fileName}: ${(e as Error)?.message}`);
      return c.json({ error: "文件解析失败，请稍后重试" }, 500);
    }

    // 图片型 PDF：抽出文字这条路走不通，改走视觉识别
    if (e.code === "scanned" && e.hasImages) {
      const aiKey = await getKey();
      if (!aiKey.key) {
        return c.json(
          {
            error: "这份 PDF 是图片，需要 AI 识别，但系统还没配置 DeepSeek Key。可以手动填写信息，或换一份能复制文字的 PDF。",
            code: "scanned",
          },
          422
        );
      }
      const ocr = await ocrScannedPdf(aiKey.key, bytes, c.env.DEEPSEEK_VISION_MODEL);
      if (ocr.ok) {
        text = ocr.text;
        ocrUsed = true;
      } else {
        console.log(`[ai] 图片型 PDF 识别失败 ${fileName}: ${ocr.reason}`);
        return c.json(
          {
            error: `这份 PDF 是图片，自动识别没成功（${ocr.reason}）。可以手动填写信息，或换一份能复制文字的 PDF。`,
            code: "scanned",
          },
          422
        );
      }
    } else {
      // code 透传给前端：scanned / fontmap / unsupported / corrupt 文案不同
      return c.json({ error: e.message, code: e.code }, 422);
    }
  }

  if (!wantAi) return c.json({ text, _ocr: ocrUsed || undefined });

  const apiKey = await getKey();
  if (!apiKey.key && !apiKey.zhipu) {
    // 没配 Key 也把文本返回：前端用本地正则规则兜底，至少不丢内容
    return c.json({ ...EMPTY, text, _ai_fallback: true, _ocr: ocrUsed || undefined });
  }

  const raw = await callDeepSeek(apiKey, text);
  if (!raw) return c.json({ ...EMPTY, text, _ai_fallback: true, _ocr: ocrUsed || undefined });
  return c.json({ ...normalizeAiResult(raw), text, _ocr: ocrUsed || undefined });
});

export default aiParse;
