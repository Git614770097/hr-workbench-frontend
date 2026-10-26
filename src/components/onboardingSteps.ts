import type { User } from "../types";
import { canAccessPath } from "../utils/routeAccess";

export interface OnbStep {
  /** 高亮目标元素的 CSS 选择器；不传则居中展示（用于开场/收尾） */
  target?: string;
  /** 居中展示 */
  center?: boolean;
  title: string;
  desc: string;
  /** 底部「去体验」按钮的跳转地址 */
  goTo?: string;
  goToLabel?: string;
  /**
   * 动手任务：引导用户真的去点某个按钮。
   * 点击命中 target 后自动判定成功并进入下一步，无需手动点「下一步」。
   */
  action?: {
    /** 必须真实点击到的元素选择器（页面需先 goTo 到目标页） */
    target: string;
    /** 引导语，如「点一下『新增岗位』」 */
    label: string;
    /** 目标按钮的可见名称，用于「没找到入口」时给出提示 */
    name?: string;
  };
}

/**
 * 新手指引（文案基准，默认 HR 口径）：不只是一路讲解，而是「讲一句 → 让你亲手做一次」。
 * 三个核心动作（新增岗位 / 新增人才 / 新建待办）均为动手任务，
 * 点中目标按钮后自动进入下一步，做错的可以点「跳过这步」继续。
 *
 * ⚠️ 加步骤只改这里。
 *    所以**在中间插入步骤会错位**——新增请追加到末尾，或同步更新各身份的 onboardingCopy。
 */
const BASE_STEPS: OnbStep[] = [
  {
    center: true,
    title: "欢迎，1 分钟边练边会",
    desc: "前 3 步会高亮入口按钮，点「帮我填好表单」自动打开并填好示例，再点「保存」即可；其余模块会自动跳过去看一眼。右上角 ✕ 可随时跳过。",
  },
  {
    target: '[data-onb-action="new-job"]',
    title: "① 新增岗位",
    desc: "「岗位管理」→ 点左上角「新增岗位」，填职位和 JD 保存。招聘需求也可先在「招聘需求」登记再转岗位。",
    goTo: "/jobs",
    action: {
      target: '[data-onb-action="new-job"]',
      label: "点一下「新增岗位」按钮",
      name: "新增岗位",
    },
  },
  {
    target: '[data-onb-action="new-talent"]',
    title: "② 新增人才",
    desc: "「人才库管理」→ 点「新增人才」录信息，或用「导入」解析简历。一人可投多岗。",
    goTo: "/talents",
    action: {
      target: '[data-onb-action="new-talent"]',
      label: "点一下「新增人才」按钮",
      name: "新增人才",
    },
  },
  {
    target: '[data-onb-action="new-task"]',
    title: "③ 新建待办",
    desc: "「待办日历」→ 点左上角「新建待办」，选日期写内容。合同/试用/社保到期会自动落进来。",
    goTo: "/tasks",
    action: {
      target: '[data-onb-action="new-task"]',
      label: "点一下「新建待办」按钮",
      name: "新建待办",
    },
  },
  {
    target: '[data-onb="/pipeline"]',
    title: "招聘看板：拖拽推进",
    desc: "岗位出现在这里。把候选人从「筛选」拖到「面试→Offer→入职」。面试去「面试管理」录双评，Offer 走「审批中心」，入职去「入职办理」生成清单。",
    goTo: "/pipeline",
    goToLabel: "去看看看板",
  },
  {
    target: '[data-onb="/profiles"]',
    title: "人才画像：AI 自动打分",
    desc: "「人才画像」配置能力模型，系统自动给人才生成画像与匹配度，搜索排序更省力，可多岗共用。",
    goTo: "/profiles",
    goToLabel: "去看看画像",
  },
  {
    target: '[data-onb="/contracts"]',
    title: "合同管理：别漏签",
    desc: "状态改「已入职」→ 合同提醒自动来。上传原件，AI 识别签订/到期日。入职材料也在这归档。",
    goTo: "/contracts",
  },
  {
    target: '[data-onb="/social"]',
    title: "社保公积金",
    desc: "入职即自动生成增减员待办。内含个税计算器，输入薪资看每月到手与全年合计。",
    goTo: "/social",
  },
  {
    target: '[data-onb="/funnel"]',
    title: "招聘概览：数据复盘 + AI 复盘",
    desc: "「招聘概览」用漏斗看各阶段人数、转化率与渠道效果，招聘周期也帮你算好；点「AI 复盘」可让 AI 直接写出一段复盘结论，复制就能用。",
    goTo: "/funnel",
    goToLabel: "去看看概览",
  },
  {
    target: '[data-onb="/templates"]',
    title: "模板库",
    desc: "JD、合同、证明、Offer 等模板都在「模板库」，可导出 Word 或改存本公司版本。",
    goTo: "/templates",
  },
  // ── v1.1 新增：AI 助手（追加到收尾步骤之前；⚠️ 勿插到更前面，见上方下标错位注释）──
  {
    target: '[data-onb="/jobs"]',
    title: "AI 助手：全流程帮你起草",
    desc: "现在多个页面都有 AI 按钮：新增岗位可一键起草职责与要求、审批有「10 秒读卡」、入职生成材料清单、人才库可一键盘点。生成的都是草稿，核对后再用。",
    goTo: "/jobs",
    goToLabel: "去看看 AI 能力",
  },
  // ── v1.2 新增：人才AI匹配（2026-10-21 插在 AI 助手步之后、收尾步之前。
  //    本文件下标被 identityProfiles 的 onboardingCopy 按 BASE_STEPS 原序引用；
  //    追加在末尾只会把收尾步 11→12，不会动 6/7 等靠前的覆盖位）──
  {
    target: '[data-onb="/match"]',
    title: "人才AI匹配：让 AI 替你挑人",
    desc: "「人才资产 → 人才AI匹配」选一个职位画像，从人才库添加几个候选人，AI 按匹配度排序并给出理由，先聊分高的；也可以从人才详情页点「人才AI匹配」测单个人。",
    goTo: "/match",
    goToLabel: "去匹配看看",
  },
  {
    target: '[data-onb="topbar-help"]',
    title: "随时重看指引",
    desc: "右上角问号 → 重看本指引。增删改查、导入导出、到期提醒都在这个框架里。",
  },
];

/**
 * 按实际权限生成新手指引：剔除用户无权访问的步骤 —— 引导里的 goTo 是真实跳转，
 * 指向无权页面会撞 403/重定向，高亮锚点也永远找不到。
 * （10-26 起不再做身份文案覆盖：identityProfiles 已拆，只服务 HR。）
 */
export function onboardingStepsFor(user?: User | null): OnbStep[] {
  const out: OnbStep[] = [];
  BASE_STEPS.forEach((s) => {
    // 无权访问的目标页 → 整步隐藏（传了 user 才做权限判断，方便单独预览引导文案）
    if (user && s.goTo && !canAccessPath(user, s.goTo)) return;
    out.push({
      ...s,
      goToLabel: s.goToLabel ? s.goToLabel : undefined,
      action: s.action
        ? {
            ...s.action,
            label: s.action.label,
            name: s.action.name ? s.action.name : undefined,
          }
        : undefined,
    });
  });
  return out;
}
