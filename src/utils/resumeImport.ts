import { api } from "../api";
import {
  extractName, extractPhone, extractEmail, extractAge, extractGender,
  extractTitle, extractCompany, extractSchool, extractMajor, extractCity, extractSkills,
  extractYearsExperience, normalizeEducation,
} from "./resumeParser";
import { sanitizeField, sanitizeSkills } from "./fieldSanity";

// 简历文件 → 结构化人才记录。
// 这里的逻辑同时服务于两个入口：人才库「导入简历」与「人才AI匹配」上传简历，
// 因此抽成公共模块——两边共用同一套解析、同一套兜底策略，
// 避免同一份简历在导入页和匹配页解析出两套结果。

/**
 * 简历文件 → 纯文本。
 *
 * 抽文本放在服务端（POST /api/parse-resume/file）：浏览器端解析要先下载
 * pdfjs 引擎（worker 1.4MB + 主库 0.8MB），弱网下要几分钟才出结果；上传
 * 简历本身（通常几百 KB）快一个数量级。服务端还统一做了 NFKC 归一化
 * （修复 pdfjs 抽出的康熙部首「⽉/⾼/⼯」）和扫描件检测。
 */
export async function parseResumeFile(file: File): Promise<string> {
  const r = await api.parseResumeFile(file, false);
  return r.text;
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
  major: string;
  current_company: string;
  current_title: string;
  years_experience: number | null;
  city: string;
  skills: string;
  status: string;
  notes: string;
  /** 期望薪资：只有「从人才库添加」的候选人有（简历解析不抽这个字段），对比矩阵的「价格」行用它 */
  expected_salary?: string;
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
    major: sanitizeField("major", extractMajor(text)),
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
  ai: Awaited<ReturnType<typeof api.parseResumeFile>>,
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
    major: ai.major || local.major,
    current_company: ai.current_company || local.current_company,
    current_title: ai.current_title || local.current_title,
    years_experience: ai.years_experience ?? local.years_experience,
    city: ai.city || local.city,
    skills,
    _ai: true,
  };
}

/**
 * 解析一份简历文件：一次请求完成「上传 → 服务端抽文本 → AI 解析」。
 *
 * 服务端已内置降级：AI 不可用（无 Key / 超时 / 上游失败）时返回 `_ai_fallback`，
 * 这里只需决定用哪套字段——AI 成功则以 AI 为准、缺失用本地规则补；降级则全用
 * 本地规则（文本已在服务端归一化，正则命中率比浏览器端更高）。
 *
 * 文件本身解析失败（扫描件 / 格式不支持 / 文件损坏）会抛出带具体原因的错误，
 * 由调用方提示用户，不再静默返回空结果。
 */
export async function parseResumeToTalent(
  file: File,
  key: string
): Promise<{ talent: ParsedTalent; text: string }> {
  const r = await api.parseResumeFile(file, true);
  const text = r.text;
  const local = extractTalentLocal(text, key, file.name, file);
  const talent = r._ai_fallback ? { ...local, _ai: false } : extractTalentWithAI(r, local);
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
    major: r.major || undefined,
    current_company: r.current_company || undefined,
    current_title: r.current_title || undefined,
    years_experience: r.years_experience ?? undefined,
    city: r.city || undefined,
    skills: r.skills ? r.skills.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [],
    status: r.status || "active",
    notes: r.notes || undefined,
  };
}
