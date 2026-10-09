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
    title: "欢迎，接下来 1 分钟边讲边练",
    desc: "我不会光讲功能。接下来只带你亲手做三件事：新增一个岗位、新增一位人才、新建一条待办——做完这三个，这个系统你就摸熟了。\n中途觉得烦，右上角 ✕ 随时跳过，不会给你发消息催。",
  },
  {
    target: '[data-onb-action="new-job"]',
    title: "第一步：亲手新增一个岗位",
    desc: "招聘的一切都围绕岗位组织。先去「岗位管理」，点一下页面左上角的「新增岗位」，把你要招的职位和 JD 填进去保存。\n这一步做完，人才库、招聘看板、漏斗分析都会自动挂到这个岗位上。",
    goTo: "/jobs",
    action: {
      target: '[data-onb-action="new-job"]',
      label: "点一下「新增岗位」按钮",
      name: "新增岗位",
    },
  },
  {
    target: '[data-onb-action="new-talent"]',
    title: "第二步：把一个人存进人才库",
    desc: "光有岗位还没有人。去「人才库管理」，点「新增人才」填一份基本信息；手上真有简历的话，用旁边的「导入」直接解析，几秒钟就录进来了。",
    goTo: "/talents",
    action: {
      target: '[data-onb-action="new-talent"]',
      label: "点一下「新增人才」按钮",
      name: "新增人才",
    },
  },
  {
    target: '[data-onb-action="new-task"]',
    title: "第三步：给自己建一条待办",
    desc: "系统会自动生成到期提醒（合同到期、试用期结束、社保增减员），但你自己想记的事也能手动加：去「待办日历」，点日历左上角那个「新建待办」，选个日期写好内容。\n所有到期日都会自动落到这块日历上，不会忘。",
    goTo: "/tasks",
    action: {
      target: '[data-onb-action="new-task"]',
      label: "点一下「新建待办」按钮",
      name: "新建待办",
    },
  },
  {
    target: '[data-onb="/pipeline"]',
    title: "招聘看板：候选人就这么一路推进",
    desc: "刚才新增的岗位会在这里出现。把候选人从「简历筛选」拖到「面试 → Offer → 入职」，整个过程拖一下就完成了，系统自动记录每个阶段的时间。",
    goTo: "/pipeline",
    goToLabel: "去看看看板",
  },
  {
    target: '[data-onb="/contracts"]',
    title: "合同管理：最容易出现赔钱坑的地方",
    desc: "把人才的状态一改成「已入职」，合同提醒就自动来了。上传合同原件，AI 会自动识别里面的签订/到期日期——漏签一次的成本是 2N，这笔账不划算。",
    goTo: "/contracts",
  },
  {
    target: '[data-onb="/social"]',
    title: "社保公积金：自动算增减员，还能算个税",
    desc: "入职状态一变，增减员待办自动生成，不用你记。里面还有个税计算器，输入薪资直接看到每月到手和全年合计。",
    goTo: "/social",
  },
  {
    target: '[data-onb="/templates"]',
    title: "模板库管理：常用文书都在这儿",
    desc: "JD、劳动合同、离职证明、在职证明、Offer 等模板都整理好了，可以直接导出成 Word 拿去用；也能自己改，存成你公司的版本。",
    goTo: "/templates",
  },
  {
    target: '[data-onb="topbar-help"]',
    title: "最后：随时能把这一步调出来",
    desc: "右上角这个问号就是提醒按钮，任何时候点它都能重看这份引导。\n看完就可以放心用了——增删改查、导入导出、到期提醒，都在这个框架里。",
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
