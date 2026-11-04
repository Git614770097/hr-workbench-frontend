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
  tagline: "AI 驱动的招聘全生命周期管理系统",
  /** 登录页左侧品牌区的主广告语 */
  loginLead: "解析简历、筛候选人、写 JD、生成面试题 —— 这些 AI 已经能替你做。",
  /** 登录页大标题里「让 AI 替你」后面的那半句 */
  loginHeroTail: "做招聘",
  /** 登录页卖点列表（纯 AI 能力，每条具体到用户可感知的动作） */
  loginPoints: [
    "AI 解析简历 · 上传即抽字段 + 生成人才画像 + 评估匹配度",
    "AI 秒筛候选人 · 写个 JD，从人才库里秒出匹配名单",
    "AI 盘点人才库 · 按筛选条件一键生成盘点报告与风险提示",
    "AI 写 JD 与面试题 · 一句话生成结构化招聘文档和面试问题",
  ],
  /** 页脚一句话后缀（跟在「© 年份 产品名 · 」后面） */
  loginFooterTail: "AI 驱动的人力资源管理系统",
  /** 登录页页脚版权年份（固定值，不随 JS 运行时跨年自动更新） */
  footerYear: "2026",
  /** 落地页 Hero 主标题（不含高亮片段） */
  heroTitle: "让 AI 替你",
  /** Hero 标题里需要高亮的那一段 */
  heroHighlight: "做招聘",
  heroLead: "上传简历 → AI 解析画像 → JD 写好 → AI 秒筛候选人 → 面试 → AI 出评估报告。中间最耗时间的环节，都有 AI 帮你打底。",
  /** Hero 上方的引导语 */
  eyebrow: "简历 · 面试 · 入职，一个工作台",
  /** 落地页页脚的一句话介绍 */
  footerDesc: "让小团队用一个人、一份预算，拥有规范的招聘管理能力。",
  /** KPI 里第二项的文案 */
  templateKpiLabel: "AI 能力",
} as const;

export type Brand = typeof BRAND;
