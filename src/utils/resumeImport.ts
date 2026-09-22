import mammoth from "mammoth";
import { api } from "../api";
import {
  extractName, extractPhone, extractEmail, extractAge, extractGender,
  extractTitle, extractCompany, extractSchool, extractCity, extractSkills,
  extractYearsExperience, extractPdfLines, normalizeEducation,
} from "./resumeParser";
import { sanitizeField, sanitizeSkills } from "./fieldSanity";

// 简历文件 → 结构化人才记录。
// 这里的逻辑同时服务于两个入口：人才库「导入简历」与「智能匹配」上传简历，
// 因此抽成公共模块——两边共用同一套解析、同一套兜底策略，
// 避免同一份简历在导入页和匹配页解析出两套结果。

// PDF.js 本地打包 + 按需动态加载：
// 1) 不再依赖 CDN，避免国内网络下 jsdelivr 不稳定导致"PDF.js 加载失败"
// 2) 动态 import 让 pdfjs 单独分包，只在解析简历时才下载，不影响首屏速度
let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    });
  }
  return pdfjsPromise;
}

/** 简历文件 → 纯文本（PDF 用 pdfjs 按坐标还原行，Word 用 mammoth 提取） */
export async function parseResumeFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) {
    const pdfjsLib = await loadPdfjs();
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += extractPdfLines(content).join("\n") + "\n";
    }
    return text;
  }
  if (name.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }
  throw new Error(`不支持的文件格式：${file.name}，请上传 PDF 或 Word（.docx）文件`);
}

/** 一份简历的解析结果（核对弹窗 / 匹配候选人的基础数据结构） */
export interface ParsedTalent {
  key: string;
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
  skills: string;
  status: string;
  notes: string;
  fileName: string;
  file: File | null;
  /** 解析来源：true=AI 解析，false=本地规则回退 */
  _ai?: boolean;
}

// 从纯文本提取人才字段（本地规则引擎，作为兜底）
// 结果再过一遍 sanitizeField：规则引擎偶有误判（如把城市当姓名），
// 与 AI 通道用同一套校验，保证两条路径都不会产出"看起来有值"的脏数据。
export function extractTalentLocal(
  text: string,
  key: string,
  fileName: string,
  file: File | null
): ParsedTalent {
  return {
    key,
    name: sanitizeField("name", extractName(text)),
    phone: extractPhone(text),
    email: extractEmail(text),
    age: extractAge(text),
    gender: extractGender(text),
    education: normalizeEducation(text),
    school: sanitizeField("school", extractSchool(text)),
    current_company: sanitizeField("current_company", extractCompany(text)),
    current_title: sanitizeField("current_title", extractTitle(text)),
    years_experience: extractYearsExperience(text),
    city: sanitizeField("city", extractCity(text)),
    skills: sanitizeSkills(extractSkills(text).split(/[,，、/]+/)).join(", "),
    status: "active",
    notes: "",
    fileName,
    file,
  };
}

// AI 解析结果 → ParsedTalent（AI 优先，缺失字段用本地规则兜底）
export function extractTalentWithAI(
  ai: Awaited<ReturnType<typeof api.parseResume>>,
  local: ParsedTalent
): ParsedTalent {
  const skills = ai.skills?.length ? ai.skills.join(", ") : local.skills;
  return {
    ...local,
    name: ai.name || local.name,
    phone: ai.phone || local.phone,
    email: ai.email || local.email,
    age: ai.age ?? local.age,
    gender: ai.gender || local.gender,
    education: ai.education || local.education,
    school: ai.school || local.school,
    current_company: ai.current_company || local.current_company,
    current_title: ai.current_title || local.current_title,
    years_experience: ai.years_experience ?? local.years_experience,
    city: ai.city || local.city,
    skills,
    _ai: true,
  };
}

/** AI 解析超时时间：超过就回退本地规则，不让用户干等 */
const AI_TIMEOUT_MS = 20000;

/**
 * 解析一份简历文件：抽文本 → 本地规则兜底 → 尝试 AI（失败/超时静默回退）。
 * 返回解析结果 + 简历全文（全文供智能匹配做语义比对，不再二次解析）。
 */
export async function parseResumeToTalent(
  file: File,
  key: string
): Promise<{ talent: ParsedTalent; text: string }> {
  const text = await parseResumeFile(file);
  const local = extractTalentLocal(text, key, file.name, file);
  let talent = local;
  try {
    const ai = await Promise.race([
      api.parseResume(text),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("AI 解析超时")), AI_TIMEOUT_MS)
      ),
    ]);
    talent = extractTalentWithAI(ai, local);
  } catch (err) {
    // AI 失败（无 key/超时/网络/解析异常）静默回退本地规则
    console.warn(`AI 解析失败，回退本地规则：${file.name}`, err);
    talent._ai = false;
  }
  return { talent, text };
}

/** 解析结果 → 人才入库接口入参 */
export function recordToData(r: ParsedTalent) {
  return {
    name: r.name,
    phone: r.phone || undefined,
    email: r.email || undefined,
    age: r.age ?? undefined,
    gender: r.gender || undefined,
    education: r.education || undefined,
    school: r.school || undefined,
    current_company: r.current_company || undefined,
    current_title: r.current_title || undefined,
    years_experience: r.years_experience ?? undefined,
    city: r.city || undefined,
    skills: r.skills ? r.skills.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [],
    status: r.status || "active",
    notes: r.notes || undefined,
  };
}
