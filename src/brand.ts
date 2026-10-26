/**
 * 品牌文案常量 —— 原 identityProfiles 的 HR 档案字段。
 * 猎头身份 2026-10-24 下线后，身份间接层（profileOf/termFor/navLabelFor）全部恒等，
 * 2026-10-26 拆除；登录页/落地页/新手指引仍要的产品文案收敛到这里。
 */
export const BRAND = {
  /** 侧边栏 LOGO 的文字标记（1-3 字符） */
  mark: "AI",
  /** 产品名 */
  name: "Ai 招聘工作台",
  /** 一句话定位，用于登录页副标题、浏览器标题 */
  tagline: "招聘全生命周期管理系统",
  /** 登录页左侧品牌区的主广告语 */
  loginLead: "写 JD、筛简历、盯到期、算个税，一个人也能有整个招聘团队的效率。",
  /** 登录页大标题里「让 AI 替你」后面的那半句 */
  loginHeroTail: "跑招聘全流程",
  /** 登录页三条卖点（固定 3 条，按序渲染） */
  loginPoints: [
    "AI 招聘助手 · 一键生成 JD 与画像",
    "招聘漏斗 · 转化率用数据说话",
    "合同社保 · 到期自动提醒",
  ],
  /** 页脚一句话后缀（跟在「© 年份 产品名 · 」后面） */
  loginFooterTail: "AI 驱动的人力资源管理系统",
  /** 落地页 Hero 主标题（不含高亮片段） */
  heroTitle: "一个人，也能顶",
  /** Hero 标题里需要高亮的那一段 */
  heroHighlight: "一整个招聘团队",
  heroLead: "从简历入库、AI 解析、流程看板到招聘漏斗与到期提醒，把招聘全流程收进一个工作台。不用装软件，打开就能用。",
  /** Hero 上方的引导语 */
  eyebrow: "简历 · 面试 · 入职，一个工作台",
  /** 落地页页脚的一句话介绍 */
  footerDesc: "让小团队用一个人、一份预算，拥有规范的招聘管理能力。",
  /** KPI 里第二项的文案 */
  templateKpiLabel: "文档模板",
} as const;

export type Brand = typeof BRAND;
