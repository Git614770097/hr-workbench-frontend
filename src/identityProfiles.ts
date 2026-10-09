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

/** 猎头 / 招聘顾问 */
const HEADHUNTER_PROFILE: IdentityProfile = {
  key: "headhunter",
  mark: "AI",
  name: "Ai 招聘工作台 · 猎头版",
  tagline: "候选人寻访与职位交付管理",
  loginLead: "职位、候选人、推进进度一站式管理，寻访交付全流程一眼看清。",
  loginHeroTail: "跑通交付全流程",
  loginPoints: [
    "AI 寻访助手 · 一键生成 JD 与画像",
    "推进管道 · 交付转化用数据说话",
    "合同材料 · 到期自动提醒",
  ],
  loginFooterTail: "AI 驱动的招聘交付管理系统",
  heroTitle: "一个人，也能接",
  heroHighlight: "更多职位委托",
  heroLead: "从候选人入库、AI 解析、推进管道到交付转化分析，把寻访与交付的全流程收进一个工作台。不用装软件，打开就能用。",
  eyebrow: "职位 · 候选人 · 交付，一个工作台",
  footerDesc: "让独立顾问和小团队，用一份预算管好所有职位委托。",
  templateKpiLabel: "交付模板",
  navLabels: {
    jobs: "职位管理",
    pipeline: "推进管道",
    funnel: "业绩概览",
    talents: "候选人库",
    profiles: "候选人画像",
  },
  // 只换叙述角度，功能本身与 HR 版一致；不得写系统里没有的模块。
  featureCopy: {
    0: {
      title: "候选人库",
      desc: "简历批量入库、AI 智能解析，候选人一档可投多岗，寻访资源沉淀复用。",
      tags: ["批量导入", "一人多岗"],
    },
    1: {
      title: "职位交付看板",
      desc: "多个职位并行推进，每个候选人卡在哪一轮、停了几天，一眼看清。",
      tags: ["多职位并行", "拖拽流转"],
    },
    2: {
      title: "交付转化分析",
      desc: "来源渠道、转化率与交付周期自动统计，哪个渠道出人快，用数据说话。",
      tags: ["渠道效果", "交付周期"],
    },
    3: {
      title: "入职材料归档",
      desc: "候选人的合同与入职材料集中归档，到期节点自动提醒，交付不烂尾。",
      tags: ["材料归档", "到期提醒"],
    },
    4: {
      title: "任务待办与模板",
      desc: "跟进待办自动生成，简历筛选、面试邀约等常用文档随时调用。",
      tags: ["跟进待办", "文档模板"],
    },
    5: {
      title: "AI 招聘助手",
      desc: "一键生成职位 JD 与候选人画像，批量简历快速打分排序。",
      tags: ["AI 生成", "简历打分"],
    },
  },
  flowCopy: {
    title: "从接单到交付，一条线走到底",
    desc: "寻访不是零散动作，而是一条连续的交付流程。每一步都有对应的模块兜底。",
    steps: {
      0: { title: "录入职位", desc: "AI 辅助生成 JD" },
      1: { title: "积累候选人", desc: "批量导入并解析" },
      2: { title: "推进寻访", desc: "看板拖拽流转" },
      3: { title: "推荐到岗", desc: "阶段记录留痕" },
      4: { title: "入职跟进", desc: "试用期待办提醒" },
      5: { title: "材料归档", desc: "交付成果沉淀" },
    },
  },
  // 新手指引覆盖：去掉社保台账步骤（猎头不办社保），并把雇主口径的合同话术改成交付口径。
  // 其余步骤文案由 termFor 统一替换（岗位→职位、人才→候选人、招聘看板→推进管道）。
  onboardingCopy: {
    3: {
      desc: "系统会自动生成到期提醒（合同到期、试用期结束），但你自己想记的事也能手动加：去「待办日历」，点日历左上角那个「新建待办」，选个日期写好内容。\n所有到期日都会自动落到这块日历上，不会忘。",
    },
    5: {
      title: "合同材料：别在到期节点上翻车",
      desc: "把候选人状态一改成「已入职」，合同提醒就自动来了。上传合同原件，AI 会自动识别里面的签订/到期日期，交付不烂尾。",
    },
    6: { skip: true },
  },
};

/** 其他 / 未选择 —— 回落默认档案（HR），不再作为可选身份暴露 */
export const IDENTITY_PROFILES: Record<string, IdentityProfile> = {
  hr: HR_PROFILE,
  headhunter: HEADHUNTER_PROFILE,
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
  headhunter: {
    // 长词在前，避免「招聘看板」等被更短的规则先拆掉；
    // termFor 内部会再按词长降序排一次，这里书写顺序仅为可读性。
    招聘漏斗: "业绩概览",
    招聘概览: "业绩概览",
    招聘看板: "推进管道",
    人才: "候选人",
    岗位: "职位",
  },
  // 团队版已下架，无对应身份分支。
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
