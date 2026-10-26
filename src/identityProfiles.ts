/**
 * 品牌与身份档案 —— 「一个平台多用」的配置中心。
 *
 * ## 设计原则（改之前先读）
 *
 * 1. **品牌层分身份，业务术语层统一**。
 *    品牌（产品名、卖点、登录页/落地页文案）按身份区分；
 *    「候选人」「职位」「简历」这类业务词全站统一用中性词 ——
 *    HR 和猎头本来都说「候选人」，分叉只会让维护成本爆炸（全站 500+ 处）。
 *
 * 2. **身份不参与鉴权**。能看到哪些菜单永远由 roles.permissions 决定。
 *    这里的 nav 只负责「菜单在这一身份下的显示名」，不做增删。
 *
 * 3. **加身份 = 加一份 PROFILE + 配一个角色**，不改任何页面代码。
 *
 * ## 用法
 *   const brand = useBrand();          // 组件内，自动跟随当前登录用户
 *   brand.name                         // 「Ai 招聘工作台」
 *   navLabel(brand, "talents")         // 按身份取菜单显示名
 */
import type { User } from "./types";

export interface IdentityProfile {
  key: string;
  /** 侧边栏 LOGO 的文字标记（1-3 字符） */
  mark: string;
  /** 产品名 */
  name: string;
  /** 一句话定位，用于登录页副标题、浏览器标题 */
  tagline: string;
  /** 登录页左侧品牌区的主广告语 */
  loginLead: string;
  /** 登录页大标题里「让 AI 替你」后面的那半句 */
  loginHeroTail: string;
  /** 登录页三条卖点（固定 3 条，按序渲染） */
  loginPoints: string[];
  /** 页脚一句话后缀（跟在「© 年份 产品名 · 」后面） */
  loginFooterTail: string;
  /** 落地页 Hero 主标题（不含高亮片段） */
  heroTitle: string;
  /** Hero 标题里需要高亮的那一段 */
  heroHighlight: string;
  heroLead: string;
  /** Hero 上方的引导语 */
  eyebrow: string;
  /** 落地页页脚的一句话介绍 */
  footerDesc: string;
  /** KPI 里第二项的文案（HR=人事模板，猎头=客户 / 职位） */
  templateKpiLabel: string;
  /** 菜单显示名覆盖：key 为路由 path 末段，只改显示名，不影响权限 */
  navLabels: Record<string, string>;
  /**
   * 落地页功能卡的话术覆盖：key = 功能序号（0 起），值只覆盖 title/desc/tags。
   * ⚠️ 只换叙述角度，**不得编造系统里不存在的功能**（如猎头版的「客户管理」「回款」
   * 模块尚未实现，不能写进落地页）。
   */
  featureCopy?: Record<number, { title?: string; desc?: string; tags?: string[] }>;
  /** 落地页「工作流」区块的话术覆盖（标题/副标题/六个步骤），同样只能换角度不换事实 */
  flowCopy?: {
    title?: string;
    desc?: string;
    steps?: Record<number, { title?: string; desc?: string }>;
  };
  /**
   * 新手指引步骤的话术覆盖：key = 步骤序号（0 起，见 onboardingSteps.ts 的 BASE_STEPS）。
   * skip=true 表示该身份不展示这一步（如猎头版没有社保台账）。
   * 未覆盖的步骤文案仍会统一过 termFor（岗位→职位、人才→候选人…）。
   */
  onboardingCopy?: Record<number, { title?: string; desc?: string; skip?: boolean }>;
}

/** 默认档案（HR 人事）——也是所有身份的兜底 */
const HR_PROFILE: IdentityProfile = {
  key: "hr",
  mark: "AI",
  name: "Ai 招聘工作台",
  tagline: "招聘全生命周期管理系统",
  loginLead: "写 JD、筛简历、盯到期、算个税，一个人也能有整个招聘团队的效率。",
  loginHeroTail: "跑招聘全流程",
  loginPoints: [
    "AI 招聘助手 · 一键生成 JD 与画像",
    "招聘漏斗 · 转化率用数据说话",
    "合同社保 · 到期自动提醒",
  ],
  loginFooterTail: "AI 驱动的人力资源管理系统",
  heroTitle: "一个人，也能顶",
  heroHighlight: "一整个招聘团队",
  heroLead: "从简历入库、AI 解析、流程看板到招聘漏斗与到期提醒，把招聘全流程收进一个工作台。不用装软件，打开就能用。",
  eyebrow: "简历 · 面试 · 入职，一个工作台",
  footerDesc: "让小团队用一个人、一份预算，拥有规范的招聘管理能力。",
  templateKpiLabel: "文档模板",
  navLabels: {},
};

/** 其他 / 未选择 —— 回落默认档案（HR），不再作为可选身份暴露 */
export const IDENTITY_PROFILES: Record<string, IdentityProfile> = {
  hr: HR_PROFILE,
};

export const DEFAULT_PROFILE = HR_PROFILE;

/**
 * 按身份取档案。
 * admin 永远用默认档案（管理员是「系统所有者」，不套任何业务身份，
 * 否则管理员改了身份会让自己的界面跟着变，容易误判问题）。
 */
export function profileOf(user: User | null | undefined): IdentityProfile {
  if (!user) return DEFAULT_PROFILE;
  if (user.role === "admin") return DEFAULT_PROFILE;
  const key = user.intended_role;
  if (!key) return DEFAULT_PROFILE;
  return IDENTITY_PROFILES[key] || DEFAULT_PROFILE;
}

/** 菜单在指定身份下的显示名（未覆盖则用原 key 对应的默认名） */
export function navLabelFor(profile: IdentityProfile, to: string, fallback: string): string {
  const seg = to.replace(/^\//, "");
  return profile.navLabels[seg] || fallback;
}

/**
 * 业务高频术语按身份替换。
 * 只覆盖「该身份习惯说法明显不同」的几个词，其余业务术语全站保持中性统一，
 * 避免 250+ 处文案按身份分叉导致维护成本爆炸。
 * 词表必须与 navLabels 对齐（菜单叫什么，页面内就跟着叫），未收录的词原样返回。
 */
const TERM_LABELS: Record<string, Record<string, string>> = {
  // 猎头版已下线（2026-10-24）；HR 档案不做术语替换。
};

export function termFor(profile: IdentityProfile, text: string): string {
  const map = TERM_LABELS[profile.key];
  if (!map) return text;
  // 按词长降序：保证「招聘漏斗」先于单字规则替换，避免长词被拆成碎片
  const pairs = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [from, to] of pairs) out = out.split(from).join(to);
  return out;
}
