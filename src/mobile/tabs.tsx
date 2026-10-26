/**
 * 移动版底部 Tab 的唯一定义源。
 *
 * 桌面菜单的可见性由 roles.permissions 决定，移动端必须保持同一口径，
 * 否则「桌面进不去、手机能进」——两端鉴权不一致。
 * 这里每个 Tab 都带 perm，由 App.tsx 的守卫和 MobileLayout 的渲染共同消费。
 *
 * label 为显示名
 * （如猎头版「人才库」→「候选人库」），菜单文案保持单一真源。
 */
import type { ReactNode } from "react";
// ⚠️ 本文件被 MobileLayout 静态引用（在首屏闭包里），图标必须走深路径，
//    别用 `from "@ant-design/icons"`——桶文件会把全部 831 个图标拖进来。
import CalendarOutlined from "@ant-design/icons/es/icons/CalendarOutlined";
import DeploymentUnitOutlined from "@ant-design/icons/es/icons/DeploymentUnitOutlined";
import TeamOutlined from "@ant-design/icons/es/icons/TeamOutlined";
import FunnelPlotOutlined from "@ant-design/icons/es/icons/FunnelPlotOutlined";
import ScheduleOutlined from "@ant-design/icons/es/icons/ScheduleOutlined";
import type { User } from "../types";

export interface MobileTab {
  /** 移动版路由 */
  path: string;
  /** 对应权限 key（与 roles.permissions / 桌面菜单一致） */
  perm: string;
  /** 桌面同源路由 */
  navPath: string;
  /** 兜底显示名 */
  label: string;
  icon: ReactNode;
}

export const MOBILE_TABS: MobileTab[] = [
  { path: "/m/tasks", perm: "tasks", navPath: "/tasks", label: "待办", icon: <CalendarOutlined /> },
  // 面试排在待办之后：面完随手记、随时看时间，是手机上最高频的招聘动作
  { path: "/m/interviews", perm: "interviews", navPath: "/interviews", label: "面试", icon: <ScheduleOutlined /> },
  { path: "/m/pipeline", perm: "pipeline", navPath: "/pipeline", label: "看板", icon: <DeploymentUnitOutlined /> },
  { path: "/m/talents", perm: "talents", navPath: "/talents", label: "人才库", icon: <TeamOutlined /> },
  { path: "/m/funnel", perm: "funnel", navPath: "/funnel", label: "概览", icon: <FunnelPlotOutlined /> },
];

/** 该用户在移动端可用的 Tab（admin 全可用；普通用户按 permissions 过滤） */
export function mobileTabsFor(user: User): MobileTab[] {
  if (user.role === "admin") return MOBILE_TABS;
  const perms = user.permissions || [];
  return MOBILE_TABS.filter((t) => perms.includes(t.perm));
}
