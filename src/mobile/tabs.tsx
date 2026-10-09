/**
 * 移动版底部 Tab 的唯一定义源。
 *
 * 桌面菜单的可见性由 roles.permissions 决定，移动端必须保持同一口径，
 * 否则「桌面进不去、手机能进」——两端鉴权不一致。
 * 这里每个 Tab 都带 perm，由 App.tsx 的守卫和 MobileLayout 的渲染共同消费。
 *
 * label 只是兜底文案：真正显示时会经 navLabelFor 按身份覆盖
 * （如猎头版「人才库」→「候选人库」），菜单文案保持单一真源。
 */
import type { ReactNode } from "react";
import {
  CalendarOutlined,
  DeploymentUnitOutlined,
  TeamOutlined,
  FunnelPlotOutlined,
} from "@ant-design/icons";
import type { User } from "../types";

export interface MobileTab {
  /** 移动版路由 */
  path: string;
  /** 对应权限 key（与 roles.permissions / 桌面菜单一致） */
  perm: string;
  /** 桌面同源路由，用于按身份取菜单显示名（navLabelFor 用 path 末段） */
  navPath: string;
  /** 兜底显示名 */
  label: string;
  icon: ReactNode;
}

export const MOBILE_TABS: MobileTab[] = [
  { path: "/m/tasks", perm: "tasks", navPath: "/tasks", label: "待办", icon: <CalendarOutlined /> },
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
