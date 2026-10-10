import type { IdentityProfile } from "../identityProfiles";
import { termFor } from "../identityProfiles";
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
 * ⚠️ 加步骤只改这里；数组下标会被 identityProfiles 的 onboardingCopy 引用作为覆盖位，
 *    所以**在中间插入步骤会错位**——新增请追加到末尾，或同步更新各身份的 onboardingCopy。
 */
const BASE_STEPS: OnbStep[] = [
  {
    center: true,
    title: "欢迎，1 分钟边练边会",
    desc: "前 3 步我会先帮你打开表单，你点「帮我填好表单」自动填好示例，再点「保存」即可；其余模块会自动跳过去看一眼。右上角 ✕ 可随时跳过。",
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
    title: "招聘概览：数据复盘",
    desc: "「招聘概览」用漏斗看各阶段人数、转化率与渠道效果，招聘周期也帮你算好。",
    goTo: "/funnel",
    goToLabel: "去看看概览",
  },
  {
    target: '[data-onb="/templates"]',
    title: "模板库",
    desc: "JD、合同、证明、Offer 等模板都在「模板库」，可导出 Word 或改存本公司版本。",
    goTo: "/templates",
  },
  {
    target: '[data-onb="topbar-help"]',
    title: "随时重看指引",
    desc: "右上角问号 → 重看本指引。增删改查、导入导出、到期提醒都在这个框架里。",
  },
];

/**
 * 按身份 + 实际权限生成新手指引：
 * 1. 先套用 profile.onboardingCopy 的逐条覆盖 / skip（下标按 BASE_STEPS 原序，过滤不会影响下标）；
 * 2. 剔除用户无权访问的步骤 —— 引导里的 goTo 是真实跳转，指向无权页面会撞 403/重定向，
 *    高亮锚点也永远找不到（例如猎头没有合同/社保/模板权限）；
 * 3. 剩下的 title / desc / 引导语统一过 termFor（岗位→职位、人才→候选人、招聘看板→推进管道…）。
 * 注意 termFor 放在覆盖之后：覆盖文案里若含 HR 词也应被一并替换，不必手写两遍。
 */
export function onboardingStepsFor(profile: IdentityProfile, user?: User | null): OnbStep[] {
  const copy = profile.onboardingCopy || {};
  const out: OnbStep[] = [];
  BASE_STEPS.forEach((s, i) => {
    const ov = copy[i];
    if (ov?.skip) return;
    // 无权访问的目标页 → 整步隐藏（传了 user 才做权限判断，方便单独预览引导文案）
    if (user && s.goTo && !canAccessPath(user, s.goTo)) return;
    out.push({
      ...s,
      title: termFor(profile, ov?.title ?? s.title),
      desc: termFor(profile, ov?.desc ?? s.desc),
      goToLabel: s.goToLabel ? termFor(profile, s.goToLabel) : undefined,
      action: s.action
        ? {
            ...s.action,
            label: termFor(profile, s.action.label),
            name: s.action.name ? termFor(profile, s.action.name) : undefined,
          }
        : undefined,
    });
  });
  return out;
}
