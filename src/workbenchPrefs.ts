import type { User, WorkbenchModuleConfig, WorkbenchModuleKey } from "./types";
import { api } from "./api";

/**
 * 工作台模块定义（单一来源）。
 * 新增/调整卡片 → 只改这里 + Funnel.tsx 的渲染判断，不要再散落硬编码。
 */
export interface WorkbenchModuleDef {
  key: WorkbenchModuleKey;
  label: string;
  zone: "action" | "analysis";
  desc: string;
  /** 该模块是否始终显示（不可被用户在「调整模块」里关掉） */
  locked?: boolean;
}

export const WORKBENCH_MODULES: WorkbenchModuleDef[] = [
  { key: "today_focus", label: "今日重点", zone: "action", desc: "今日面试 · 到期待办 · 超期跟进" },
  { key: "kpi_band", label: "关键指标", zone: "action", desc: "在招 / 待推进 / 本周新增 / 今日面试" },
  { key: "trend", label: "趋势折线", zone: "analysis", desc: "新增人才 · 进入面试 · 入职" },
  { key: "funnel", label: "转化漏斗", zone: "analysis", desc: "各阶段「曾到达」转化" },
  { key: "sources", label: "渠道效果", zone: "analysis", desc: "各来源入职转化与周期" },
  { key: "cycles", label: "招聘周期", zone: "analysis", desc: "各环节耗时与分位值" },
  { key: "stay", label: "各阶段当前停留", zone: "analysis", desc: "此刻卡在哪一步" },
  { key: "reject", label: "淘汰原因分布", zone: "analysis", desc: "看板淘汰原因汇总" },
];

/** 存 user_settings 的 key */
export const WORKBENCH_SETTING_KEY = "workbench_modules";

/**
 * 角色默认显隐。
 * 管理者（admin）偏结果指标：默认收起「渠道效果 / 淘汰原因」这类执行细节；
 * 招聘专员偏过程漏斗：默认全显示。
 * ⚠️ 这只是「首次进入的默认值」，用户一旦在「调整模块」里改过就以他自己的为准。
 */
export function defaultHidden(user: User | null): WorkbenchModuleKey[] {
  if (user?.role === "admin") return ["sources", "reject"];
  return [];
}

const ALL_KEYS = WORKBENCH_MODULES.map((m) => m.key);

function sanitize(hidden: unknown): WorkbenchModuleKey[] {
  if (!Array.isArray(hidden)) return [];
  return hidden.filter((x): x is WorkbenchModuleKey => ALL_KEYS.includes(x as WorkbenchModuleKey));
}

/** 读取工作台模块配置：优先用户已保存的，否则按角色给默认值 */
export async function loadWorkbenchConfig(user: User | null): Promise<WorkbenchModuleConfig> {
  try {
    const r = await api.getMySetting(WORKBENCH_SETTING_KEY);
    if (r.value) {
      const parsed = JSON.parse(r.value);
      if (parsed && typeof parsed === "object" && "hidden" in parsed) {
        return { hidden: sanitize((parsed as WorkbenchModuleConfig).hidden) };
      }
    }
  } catch {
    // 读取失败（未登录/网络）→ 回退默认，不阻塞页面
  }
  return { hidden: defaultHidden(user) };
}

/** 保存工作台模块配置（失败静默：不打断用户操作） */
export async function saveWorkbenchConfig(cfg: WorkbenchModuleConfig): Promise<boolean> {
  try {
    await api.setMySetting(WORKBENCH_SETTING_KEY, JSON.stringify({ hidden: cfg.hidden }));
    return true;
  } catch {
    return false;
  }
}

/** 管理者预设 / 招聘专员预设（「调整模块」里的一键切换） */
export function presetHidden(preset: "manager" | "recruiter"): WorkbenchModuleKey[] {
  return preset === "manager" ? ["sources", "reject"] : [];
}
