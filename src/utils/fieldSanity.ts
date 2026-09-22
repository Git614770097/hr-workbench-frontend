// 字段值合理性校验（AI 解析与本地规则共用）
//
// 背景：线上出现过 current_company = "2013"（把年份当公司名）、name = "广州"（把城市当姓名）。
// 这类脏值最麻烦的地方是"看起来有值"——核对弹窗只对空字段提示「待填」，
// 用户会以为这条记录已经解析好了。因此这里的策略是：
// **明显不合理的值一律清成空字符串**，宁可空着让用户看见，也不要静默存错。

import { isPlaceName } from "./resumeParser";

/** 纯数字 / 纯时间表达式：2013、2013-2016、2020.03、3年、至今 */
const NUMERIC_LIKE_RE = /^[\d\s.\-~至—年月日/今现]+$/;
const SCHOOL_WORD_RE = /(大学|学院|学校|中学|小学|职业技术|高等专科|研究生院)/;
/** 含这些词说明确实像企业实体，即使是"XX大学科技园有限公司"也应保留 */
const COMPANY_ENTITY_RE = /(公司|集团|有限|银行|医院|厂|事务所|研究院)/;
const NAME_STOP_RE = /(简历|求职|应聘|姓名|名字|电话|手机|邮箱|学历|年龄|性别|个人优势|自我评价)/;

export function isNumericLike(s: string): boolean {
  return NUMERIC_LIKE_RE.test(s);
}

function plausibleName(s: string): boolean {
  if (s.length < 2 || s.length > 10) return false; // 英文全名会略长，放宽到 10
  if (/\d/.test(s)) return false;
  if (isPlaceName(s)) return false;                // "广州"、"广东"
  if (NAME_STOP_RE.test(s)) return false;          // 章节词/标签词
  return true;
}

function plausibleCompany(s: string): boolean {
  if (s.length < 2 || s.length > 40) return false;
  if (isNumericLike(s)) return false;              // "2013"、"2013-2016"
  if (isPlaceName(s)) return false;                // "广州"
  if (SCHOOL_WORD_RE.test(s) && !COMPANY_ENTITY_RE.test(s)) return false; // "华南师范大学"
  return true;
}

function plausibleTitle(s: string): boolean {
  if (s.length < 2 || s.length > 30) return false;
  if (isNumericLike(s)) return false;
  return true;
}

function plausibleSchool(s: string): boolean {
  if (s.length < 4 || s.length > 30) return false;
  if (isNumericLike(s)) return false;
  // 院校名必须带院校特征词，否则很可能抓到了别的东西
  return /(大学|学院|学校|职业技术|专科|研究院|中学)/.test(s);
}

function plausibleCity(s: string): boolean {
  if (s.length < 2 || s.length > 6) return false;
  if (isNumericLike(s)) return false;
  return true;
}

type Checker = (s: string) => boolean;

const FIELD_CHECKERS: Record<string, Checker> = {
  name: plausibleName,
  current_company: plausibleCompany,
  current_title: plausibleTitle,
  school: plausibleSchool,
  city: plausibleCity,
};

/** 校验并清洗单个字段值；不合理则返回空字符串 */
export function sanitizeField(field: string, value: string): string {
  const v = (value || "").trim();
  if (!v) return "";
  const check = FIELD_CHECKERS[field];
  if (!check) return v;
  return check(v) ? v : "";
}

/** 技能列表清洗：去掉纯数字/纯时间/过长整句等噪音 */
export function sanitizeSkills(skills: string[]): string[] {
  return skills
    .map((s) => (s || "").trim())
    .filter((s) => s.length >= 1 && s.length <= 30 && !isNumericLike(s) && !/^(熟悉|精通|了解|掌握|熟练)$/.test(s));
}
