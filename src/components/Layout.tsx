import { useState, useEffect, useCallback, useMemo } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { prefetchPage } from "../routePages";
import { lazyModal } from "../utils/lazyModal";
import { BRAND } from "../brand";
import Avatar from "antd/es/avatar";
import Button from "antd/es/button";
import Tag from "antd/es/tag";
import Dropdown from "antd/es/dropdown";
import Tooltip from "antd/es/tooltip";
import Popover from "antd/es/popover";
import Alert from "antd/es/alert";
import Badge from "antd/es/badge";
import message from "antd/es/message";
// ⚠️ 图标一律走深路径 `@ant-design/icons/es/icons/Xxx`，**不要** `from "@ant-design/icons"`。
//    那个包的 es/index.js 是桶文件，静态 re-export 全部 831 个图标；它一旦进入首屏
//    模块图，832 个图标文件就全被拖进来（Rollup 能 tree-shake 掉没用的图标，所以
//    gzip 看不出差别，但模块图会从 739 暴涨到 2297——而 vite.config.ts 的分包规则
//    正是按「首屏可达性」判断的，模块图一旦失真，分包就全错）。
import LogoutOutlined from "@ant-design/icons/es/icons/LogoutOutlined";
import MobileOutlined from "@ant-design/icons/es/icons/MobileOutlined";
import TeamOutlined from "@ant-design/icons/es/icons/TeamOutlined";
import FileTextOutlined from "@ant-design/icons/es/icons/FileTextOutlined";
import UserOutlined from "@ant-design/icons/es/icons/UserOutlined";
import MenuFoldOutlined from "@ant-design/icons/es/icons/MenuFoldOutlined";
import MenuUnfoldOutlined from "@ant-design/icons/es/icons/MenuUnfoldOutlined";
import BgColorsOutlined from "@ant-design/icons/es/icons/BgColorsOutlined";
import CheckOutlined from "@ant-design/icons/es/icons/CheckOutlined";
import SafetyOutlined from "@ant-design/icons/es/icons/SafetyOutlined";
import DeploymentUnitOutlined from "@ant-design/icons/es/icons/DeploymentUnitOutlined";
import FunnelPlotOutlined from "@ant-design/icons/es/icons/FunnelPlotOutlined";
import SolutionOutlined from "@ant-design/icons/es/icons/SolutionOutlined";
import FileAddOutlined from "@ant-design/icons/es/icons/FileAddOutlined";
import CarryOutOutlined from "@ant-design/icons/es/icons/CarryOutOutlined";
import CalendarOutlined from "@ant-design/icons/es/icons/CalendarOutlined";
import AuditOutlined from "@ant-design/icons/es/icons/AuditOutlined";
import UserSwitchOutlined from "@ant-design/icons/es/icons/UserSwitchOutlined";
import FileProtectOutlined from "@ant-design/icons/es/icons/FileProtectOutlined";
import SafetyCertificateOutlined from "@ant-design/icons/es/icons/SafetyCertificateOutlined";
import SunOutlined from "@ant-design/icons/es/icons/SunOutlined";
import MoonOutlined from "@ant-design/icons/es/icons/MoonOutlined";
import BellOutlined from "@ant-design/icons/es/icons/BellOutlined";
import LockOutlined from "@ant-design/icons/es/icons/LockOutlined";
import CrownOutlined from "@ant-design/icons/es/icons/CrownOutlined";
import GiftOutlined from "@ant-design/icons/es/icons/GiftOutlined";
import KeyOutlined from "@ant-design/icons/es/icons/KeyOutlined";
import SettingOutlined from "@ant-design/icons/es/icons/SettingOutlined";
import RocketOutlined from "@ant-design/icons/es/icons/RocketOutlined";
import AppstoreOutlined from "@ant-design/icons/es/icons/AppstoreOutlined";
import ProfileOutlined from "@ant-design/icons/es/icons/ProfileOutlined";
import BarChartOutlined from "@ant-design/icons/es/icons/BarChartOutlined";
import ToolOutlined from "@ant-design/icons/es/icons/ToolOutlined";
import RobotOutlined from "@ant-design/icons/es/icons/RobotOutlined";
import ThunderboltOutlined from "@ant-design/icons/es/icons/ThunderboltOutlined";
import QuestionCircleOutlined from "@ant-design/icons/es/icons/QuestionCircleOutlined";
import PlayCircleOutlined from "@ant-design/icons/es/icons/PlayCircleOutlined";
import type { User } from "../types";
import { ROLE_LABELS, PALETTE } from "../types";
import { api } from "../api";
import { THEME_COLORS, type ThemeState } from "../theme";
import { onboardingStepsFor } from "./onboardingSteps";
import FeishuLogo from "./FeishuLogo";
import { isTouchDevice, setDeviceOverride } from "../utils/device";
// 以下弹窗原来都是静态引入，会被无条件打进首屏 chunk —— 后果不只是多几 KB：
// ReferralModal 里用了 antd 的 Table，而它是首屏静态闭包里**唯一**引 Table 的文件，
// 于是一个冷门的「邀请」弹窗把 Table(118KB) 连带 rc-table / rc-pagination /
// rc-virtual-list 一起拖进了首屏。Pushplus / FeishuBind / AiKey 三个又各引了
// Popconfirm。改成按 open 门控的懒加载后，这些只在用户真正点开时才下载。
//
// ⚠️ 用 lazyModal 而不是 React.lazy：后者加载失败会把错误抛给顶层 ErrorBoundary，
//    整页变成「页面出错了」；弹窗打不开不该把用户正在填的表单冲掉。
const Onboarding = lazyModal(() => import("./Onboarding"), "新手指引");
const PushplusModal = lazyModal(() => import("./PushplusModal"), "PushPlus 推送");
const FeishuBindModal = lazyModal(() => import("./FeishuBindModal"), "飞书绑定");
const PasswordModal = lazyModal(() => import("./PasswordModal"), "修改密码");
const AiKeyModal = lazyModal(() => import("./AiKeyModal"), "AI 密钥");
const MembershipModal = lazyModal(() => import("./MembershipModal"), "会员");
const ReferralModal = lazyModal(() => import("./ReferralModal"), "邀请好友");

// 引导只自动播放一次，之后靠顶栏问号按钮手动唤出
// 「已看过」按用户维度记录（换账号后新账号仍会走一次首次引导）
const ONBOARD_PREFIX = "wb.onboarding.";
const seenKeyFor = (uid?: string) => `${ONBOARD_PREFIX}seen${uid ? `.${uid}` : ""}`;

// 强制重播开关：网址后加 ?onboarding=1 只跳过「已看过」抑制；
// ?onboarding=reset 则先清掉引导相关标记再弹，等效手动重置
type OnbFlag = "reset" | "force" | null;
const readOnbFlag = (): OnbFlag => {
  try {
    const v = new URLSearchParams(window.location.search).get("onboarding");
    if (v === "reset") return "reset";
    if (v === "1") return "force";
    return null;
  } catch {
    return null;
  }
};

// 清掉所有引导标记（含旧版无后缀的 seen 键）
const clearOnboardMarks = () => {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(ONBOARD_PREFIX)) doomed.push(k);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  } catch {}
};

/* ===================== 侧栏菜单树（一级 / 二级） =====================
 * 这里**只描述结构与显示**，不做权限判断：
 *   · 可见性一律由叶子节点的 perm（或 adminOnly）决定 —— 与改造前的
 *     `.filter(item => canSee(item.perm))` 逐条等价，没有新增/删除任何权限语义。
 *   · 一级分组**自身没有 perm**：组内叶子被过滤光时整组消失，不会留下空壳。
 * ⚠️ 改动本文件时请勿修改叶子节点的 to / perm —— 它们与
 *    types.ts(MENU_PERMISSIONS) / worker/permissions.ts(MENU_KEYS) /
 *    utils/routeAccess.ts(DESKTOP_ROUTES) 一一对应，属菜单权限 5 处接线。
 */
interface NavLeaf {
  to: string;
  label: string;
  icon: React.ReactNode;
  color: string;
  perm: string;
  /** 仅管理员可见（角色/用户/系统设置），等价于旧版的 user.role === "admin" 判断 */
  adminOnly?: boolean;
  /** 仅团队管理员可见（团队管理），等价于 user.role === "manager"；与 adminOnly 互斥使用 */
  managerOnly?: boolean;
  /** 动态角标（待办数），运行时注入 */
  badge?: number;
}

interface NavGroup {
  /** 分组 id：仅作展开状态的 key，不参与路由 */
  id: string;
  /** 菜单显示名查找键（不是路由） */
  labelKey: string;
  label: string;
  icon: React.ReactNode;
  color: string;
  /** 组内角标合计（当前只有待办有角标，机制先留好） */
  badge?: number;
  children: NavLeaf[];
}

const NAV_TREE: (NavGroup | NavLeaf)[] = [
  // —— 高频：每天第一眼看，独立平铺不折叠 ——
  { to: "/tasks", label: "待办日历", icon: <CarryOutOutlined />, color: "#f97316", perm: "tasks" },

  // —— 分析复盘：独立页，不折叠，置于招聘主循环上方 ——
  { to: "/funnel", label: "招聘概览", icon: <FunnelPlotOutlined />, color: "#14b8a6", perm: "funnel" },

  // —— 招聘主循环：建岗 → 推人 → 面试 → 审批 → 入职 ——
  {
    id: "recruit",
    labelKey: "group-recruit",
    label: "招聘推进",
    icon: <RocketOutlined />,
    color: "#0ea5e9",
    children: [
      { to: "/jobs", label: "岗位管理", icon: <SolutionOutlined />, color: "#6366f1", perm: "jobs" },
      { to: "/requisitions", label: "招聘需求", icon: <FileAddOutlined />, color: "#818cf8", perm: "jobs" },
      { to: "/pipeline", label: "招聘看板", icon: <DeploymentUnitOutlined />, color: "#0ea5e9", perm: "pipeline" },
      { to: "/interviews", label: "面试管理", icon: <CalendarOutlined />, color: "#8b5cf6", perm: "interviews" },
      // 审批中心 / 入职办理：权限跟随 pipeline，不新增菜单 key
      { to: "/approvals", label: "审批中心", icon: <AuditOutlined />, color: "#d97706", perm: "pipeline" },
      { to: "/onboarding", label: "入职办理", icon: <SolutionOutlined />, color: "#059669", perm: "pipeline" },
    ],
  },

  // —— 可复用的存量资产 ——
  {
    id: "talent-assets",
    labelKey: "group-talent",
    label: "人才资产",
    icon: <AppstoreOutlined />,
    color: "#10b981",
    children: [
      { to: "/talents", label: "人才库管理", icon: <TeamOutlined />, color: PALETTE.blue, perm: "talents" },
      { to: "/profiles", label: "人才画像", icon: <UserSwitchOutlined />, color: "#10b981", perm: "profiles" },
      // 人才AI匹配：与画像并列的独立菜单。画像=配置岗位能力模型，匹配=按模型给候选人评分，
      // 两件事分开摆概念更清晰；权限仍复用 profiles（后端路由同口径）
      { to: "/match", label: "人才AI匹配", icon: <ThunderboltOutlined />, color: "#6366f1", perm: "profiles" },
    ],
  },

  // —— 工具中心：模板库 + AI 助手（AI 能力集中入口）——
  {
    id: "tools",
    labelKey: "group-tools",
    label: "工具中心",
    icon: <ToolOutlined />,
    color: "#7c3aed",
    children: [
      { to: "/ai-assistant", label: "AI 助手", icon: <RobotOutlined />, color: "#7c3aed", perm: "tools" },
      { to: "/templates", label: "模板库管理", icon: <FileTextOutlined />, color: "#8b5cf6", perm: "templates" },
    ],
  },

  // —— 人事台账：合同 / 社保 已拆为独立权限，主体数据仍取自 talents 表 ——
  {
    id: "hr-ledger",
    labelKey: "group-ledger",
    label: "人事台账",
    icon: <ProfileOutlined />,
    color: "#0d9488",
    children: [
      { to: "/contracts", label: "合同管理", icon: <FileProtectOutlined />, color: "#d97706", perm: "contracts" },
      { to: "/social", label: "社保公积金", icon: <SafetyCertificateOutlined />, color: "#0d9488", perm: "social" },
    ],
  },

  // —— 系统管理：全部仅管理员 ——
  // 系统设置的 perm 用 "settings"，刻意不进 MENU_PERMISSIONS：与「角色管理」一样走
  // admin 硬放行，不需要给存量角色回填权限，也不开放给普通角色勾选。
  {
    id: "system",
    labelKey: "group-system",
    label: "系统管理",
    icon: <SettingOutlined />,
    color: "#64748b",
    children: [
      { to: "/roles", label: "角色管理", icon: <SafetyOutlined />, color: "#f59e0b", perm: "roles", adminOnly: true },
      { to: "/users", label: "用户管理", icon: <UserOutlined />, color: "#f59e0b", perm: "users", adminOnly: true },
      { to: "/team", label: "团队管理", icon: <TeamOutlined />, color: "#f59e0b", perm: "team", managerOnly: true },
      { to: "/settings", label: "系统设置", icon: <SettingOutlined />, color: "#64748b", perm: "settings", adminOnly: true },
      // 日志管理：上报明细 + 操作审计（合一页双列表），管理员专属，不占菜单权限 key
      { to: "/logs", label: "日志管理", icon: <BarChartOutlined />, color: "#64748b", perm: "logs", adminOnly: true },
    ],
  },
];

/** 分组展开状态的持久化键：只存「用户显式点开/收起」的选择 */
const GROUP_OPEN_KEY = "sidebar-groups-open";
const readOpenGroups = (): string[] => {
  try {
    const raw = localStorage.getItem(GROUP_OPEN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};
const writeOpenGroups = (ids: string[]) => {
  try {
    localStorage.setItem(GROUP_OPEN_KEY, JSON.stringify(ids));
  } catch {}
};

/** 当前路由落在哪个一级分组下（/talents/xxx 也能命中 /talents） */
const groupIdForPath = (path: string): string | null => {
  for (const node of NAV_TREE) {
    if (!("children" in node)) continue;
    if (node.children.some((c) => path === c.to || path.startsWith(c.to + "/"))) return node.id;
  }
  return null;
};

interface Props {
  user: User;
  onLogout: () => void;
  theme: ThemeState;
  onChangeTheme: (s: ThemeState) => void;
  /** 保存推送设置后，把最新 user 状态回传给 App 更新（pushplus_configured） */
  onUserChange: (u: User) => void;
  children: React.ReactNode;
}

export default function Layout({ user, onLogout, theme, onChangeTheme, onUserChange, children }: Props) {
  const navigate = useNavigate();
  // 当前路由：用于「自动展开所在的一级分组」（见下方 isGroupOpen）
  const location = useLocation();
  // 品牌档案：按当前用户身份取（猎头/团队版会换品牌名与部分菜单名）  // 新手指引按身份 + 实际权限生成（文案过 termFor，并按权限剔除无权访问的步骤），
  // 用 useMemo 固定引用，避免每次 render 生成新数组导致引导弹窗重置。
  // 依赖用「权限指纹」字符串而非 user 对象：静默刷新会换 user 引用，
  // 直接依赖 user 会在用户切回窗口时把引导重置回第一步。
  const permFingerprint = `${user.role}|${(user.permissions || []).join(",")}`;
  const onbSteps = useMemo(() => onboardingStepsFor(user), ["hr", permFingerprint]);
  // 侧栏待办角标（逾期 + 今日到期），失败静默
  const [taskBadge, setTaskBadge] = useState(0);
  // 侧栏折叠状态，记住用户偏好
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("sidebar-collapsed") === "1";
    } catch {
      return false;
    }
  });

  // 新手指引：首次进入自动播放，之后由顶栏按钮唤出
  const [onbOpen, setOnbOpen] = useState(false);
  // 重看计数：每次唤出引导都 +1 并作为 Onboarding 的 key 强制重新挂载，
  // 保证引导每次都从第 1 步开始（避免上次停留的步数残留导致重看错位 / 越界不显示）。
  const [onbNonce, setOnbNonce] = useState(0);
  // 个人消息推送设置弹窗
  const [pushplusOpen, setPushplusOpen] = useState(false);
  // 飞书推送绑定弹窗
  const [feishuOpen, setFeishuOpen] = useState(false);
  // 飞书集成是否已配置（null=未知/查询失败）：**只用于引导横幅文案**。
  // 不用于点击分流——那里一律以服务端 /oauth/start 的返回为准（见 openFeishuEntry），
  // 否则「管理员刚配好、成员端缓存还写着未配置」会把可绑定的用户错误分流掉。
  const [feishuConfigured, setFeishuConfigured] = useState<boolean | null>(null);
  const refreshFeishuStatus = useCallback(() => {
    api.getFeishuStatus()
      .then((res) => setFeishuConfigured(!!res.configured))
      .catch(() => setFeishuConfigured(null));
  }, []);
  useEffect(() => {
    let alive = true;
    api.getFeishuStatus()
      .then((res) => { if (alive) setFeishuConfigured(!!res.configured); })
      .catch(() => { if (alive) setFeishuConfigured(null); });
    return () => { alive = false; };
  }, []);
  // 管理员在设置页保存飞书配置后广播刷新（沿用 open-ai-key 的 window 事件模式）：
  // 横幅文案即时从「未配置」翻成「立即开启」，不用等整页刷新
  useEffect(() => {
    const handler = () => refreshFeishuStatus();
    window.addEventListener("feishu-config-changed", handler);
    return () => window.removeEventListener("feishu-config-changed", handler);
  }, [refreshFeishuStatus]);
  // 引导横幅关闭状态按用户记忆：换账号后新账号仍会看到一次
  const [feishuGuideDismissed, setFeishuGuideDismissed] = useState(() => {
    try {
      return localStorage.getItem(`wb.feishu.guide.dismiss.${user.id}`) === "1";
    } catch {
      return false;
    }
  });
  const dismissFeishuGuide = () => {
    try { localStorage.setItem(`wb.feishu.guide.dismiss.${user.id}`, "1"); } catch {}
    setFeishuGuideDismissed(true);
  };
  // 「开启飞书提醒」跳转中（取授权链接 → 整页离开前的 loading）
  const [feishuJumping, setFeishuJumping] = useState(false);
  // 飞书功能统一入口（顶栏按钮 + 引导横幅共用）：未绑定用户点击后**直接整页跳转**
  // 飞书授权页，不再绕弹窗；授权回来后走既有「绑定确认页」闭环。
  // 已绑定 → 弹窗（测试 / 解绑）。未绑定时不在前端按缓存预分流：一律先取授权
  // 链接，取不到（未配置）再按角色走设置页 / 提示——服务端裁决，缓存只服务文案。
  const openFeishuEntry = () => {
    if (user.feishu_bound) { setFeishuOpen(true); return; }
    setFeishuJumping(true);
    api.feishuBindUrl()
      .then((res) => { window.location.href = res.url; })
      .catch((err) => {
        setFeishuJumping(false);
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("尚未配置")) {
          if (user.role === "admin") navigate("/settings?tab=feishu");
          else message.warning("飞书集成尚未启用，请联系管理员开启（系统设置 → 飞书集成）");
        } else {
          message.error(msg || "发起授权失败，请稍后重试");
        }
      });
  };
  // 修改自己的密码弹窗；forced=true 表示管理员重置过密码、本次登录必须先改掉
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [aiKeyOpen, setAiKeyOpen] = useState(false);
  const [forcePassword, setForcePassword] = useState(false);
  // 会员续费（全员）与收款码设置（管理员）
  const [memberOpen, setMemberOpen] = useState(false);
  const [referralOpen, setReferralOpen] = useState(false);
  useEffect(() => {
    // URL 开关：reset 先清标记，force 只跳过抑制，随后把参数从地址栏抹掉避免重复触发
    const flag = readOnbFlag();
    if (flag === "reset") clearOnboardMarks();
    if (flag) {
      try {
        window.history.replaceState(null, "", window.location.pathname + window.location.hash);
      } catch {}
    }
      if (flag === "force") {
      setOnbNonce((n) => n + 1);
      setOnbOpen(true);
      return;
    }
    let seen = false;
    try {
      seen = localStorage.getItem(seenKeyFor(user.id)) === "1";
    } catch {}
    if (seen) return;
    // 延迟一点，等首屏接口与布局稳定再弹，避免高亮位置算歪
    const timer = window.setTimeout(() => {
      setOnbNonce((n) => n + 1);
      setOnbOpen(true);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [user.id]);

  // 跳过也算看过（否则每次进系统都被弹一次），想重看走顶栏问号按钮
  const closeOnboarding = useCallback(
    (_finished?: boolean) => {
      setOnbOpen(false);
      try {
        localStorage.setItem(seenKeyFor(user.id), "1");
      } catch {}
    },
    [user.id],
  );

  // canSee 需要先于 useEffect 使用，提前定义（函数声明有提升，但为可读性放前面）
  const canSee = (key: string) => {
    if (user.role === "admin") return true;
    return (user.permissions || []).includes(key);
  };

  useEffect(() => {
    if (canSee("tasks")) {
      api.getTaskSummary()
        .then((res) => setTaskBadge(res.overdue + res.today))
        .catch(() => setTaskBadge(0));
    }
  }, []);

  // 空闲批量预取：进系统后错峰把菜单各页的 chunk 拉下来。
  // 配合 lazyPage（非挂起懒加载），首次进某页不再「URL 变了、旧页面赖着不走」。
  // 只预取当前账号可见的菜单，序列化逐个下载避免抢占首屏带宽。
  useEffect(() => {
    const paths: string[] = [];
    for (const node of NAV_TREE) {
      if ("children" in node) {
        for (const c of node.children) {
          if (c.managerOnly ? user.role === "manager" : c.adminOnly ? user.role === "admin" : canSee(c.perm)) paths.push(c.to);
        }
      } else if (node.managerOnly ? user.role === "manager" : node.adminOnly ? user.role === "admin" : canSee(node.perm)) {
        paths.push(node.to);
      }
    }
    // 详情页跟随人才库一起预取
    if (paths.includes("/talents")) paths.push("/talents/detail");
    let i = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled || i >= paths.length) return;
      prefetchPage(paths[i++]);
      setTimeout(tick, 400);
    };
    // 首屏稳定后再开跑（requestIdleCallback 不可用时退化为 2s）
    const ric = (window as any).requestIdleCallback as ((cb: () => void, opts?: { timeout: number }) => number) | undefined;
    const handle = ric ? ric(tick, { timeout: 3000 }) : (setTimeout(tick, 2000) as unknown as number);
    return () => {
      cancelled = true;
      if (ric) (window as any).cancelIdleCallback?.(handle);
      else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    };
    // canSee 依赖 user/permFingerprint，登录后只跑一次即可（后续权限热变更少见，hover 预取兜底）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem("sidebar-collapsed", next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  // 移动端抽屉菜单开关：≤768px 时侧栏变 fixed 滑入（CSS 断点负责表现），
  // 顶栏同一个按钮按当前视口分流：手机开/关抽屉，桌面切侧栏折叠。
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const toggleMenu = () => {
    if (window.matchMedia("(max-width: 768px)").matches) {
      setMobileNavOpen((v) => !v);
    } else {
      toggleCollapsed();
    }
  };

  // 判断某菜单是否可见（admin 全可见；普通用户看 permissions）
  // 见上方提前定义的 canSee

  // ===== 侧栏菜单：可见性过滤 + 身份化改名 + 角标注入 =====
  // 与改造前逐条等价：叶子仍按 canSee(perm)（系统管理另加 adminOnly）过滤，
  // 只是外面多套了一层分组容器 —— 不新增、不删除任何权限语义。
  // 菜单显示名按身份微调（如猎头版「招聘概览」→「业绩概览」），只改文字不增删权限。
  const visibleNav = useMemo<(NavGroup | NavLeaf)[]>(() => {
    const decorate = (leaf: NavLeaf): NavLeaf => ({
      ...leaf,
      label: leaf.label,
      badge: leaf.to === "/tasks" ? taskBadge : undefined,
    });
    const out: (NavGroup | NavLeaf)[] = [];
    for (const node of NAV_TREE) {
      if ("children" in node) {
        const kids = node.children
          .filter((c) => (c.managerOnly ? user.role === "manager" : c.adminOnly ? user.role === "admin" : canSee(c.perm)))
          .map(decorate);
        // 组内一项都看不到 → 整组不渲染，避免出现「打开是空的」分组
        if (kids.length === 0) continue;
        out.push({
          ...node,
          // 一级标题也走身份化：labelKey 不是路由，只作 navLabels 的查找键，
          // 两档身份都未收录时回落到原 label（显示与改造前一致）
          label: node.label,
          badge: kids.reduce((n, k) => n + (k.badge || 0), 0) || undefined,
          children: kids,
        });
      } else {
        if (node.managerOnly ? user.role !== "manager" : node.adminOnly ? user.role !== "admin" : !canSee(node.perm)) continue;
        out.push(decorate(node));
      }
    }
    return out;
    // permFingerprint 已含 role + permissions 指纹，等价于依赖 canSee 的结果
  }, ["hr", permFingerprint, taskBadge]);

  // ===== 一级分组展开状态 =====
  // 两个来源合并，避免「路由自动展开」把用户偏好污染进 localStorage：
  //   · userOpen  用户显式点开的（落盘，下次进系统仍保持）
  //   · routeOpen 当前路由所在分组（仅本次会话，逛到哪自动展开到哪）
  const [userOpen, setUserOpen] = useState<string[]>(readOpenGroups);
  const [routeOpen, setRouteOpen] = useState<string[]>(() => {
    const g = groupIdForPath(window.location.pathname);
    return g ? [g] : [];
  });
  useEffect(() => {
    const g = groupIdForPath(location.pathname);
    if (!g) return;
    setRouteOpen((prev) => (prev.includes(g) ? prev : [...prev, g]));
  }, [location.pathname]);

  // 新手指引靠 [data-onb] 高亮侧栏项，而分组收起时锚点不在 DOM 里（measure 会退化成
  // 居中卡片）→ 引导打开期间强制「全部分组展开 + 展开态布局」，保证一定找得到目标。
  const isGroupOpen = (id: string) => onbOpen || userOpen.includes(id) || routeOpen.includes(id);

  const toggleGroup = (id: string) => {
    if (userOpen.includes(id) || routeOpen.includes(id)) {
      // 显式收起：用户选择与路由自动展开都要清掉，否则会出现「点了没反应」
      setUserOpen((prev) => {
        const next = prev.filter((x) => x !== id);
        writeOpenGroups(next);
        return next;
      });
      setRouteOpen((prev) => prev.filter((x) => x !== id));
    } else {
      setUserOpen((prev) => {
        if (prev.includes(id)) return prev;
        const next = [...prev, id];
        writeOpenGroups(next);
        return next;
      });
    }
  };

  // ≤768px 时侧栏是抽屉（CSS 已强制 264px 宽），一律按展开态渲染：
  // 否则在桌面折叠过的用户（localStorage=1）打开手机抽屉会看到一个只剩图标的空壳。
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 768px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const sync = () => setIsNarrow(mq.matches);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // 侧栏是否按「收缩态」渲染：引导期间强制展开，保证锚点可见
  const navCollapsed = collapsed && !isNarrow && !onbOpen;

  // 浏览器标签页标题跟随品牌（猎头版不该显示 HR 工作台）
  useEffect(() => {
    document.title = `${BRAND.name} · ${BRAND.tagline}`;
  }, [BRAND.name, BRAND.tagline]);

  // 退出后的跳转交给 App.logout（整页跳 /login），避免与「清空用户态」抢时序
  const handleLogout = () => {
    onLogout();
  };

  // 管理员重置过密码 → 本次登录自动弹一次；用户选「稍后再说」后本次会话不再烦他
  useEffect(() => {
    if (!user.must_change_password) return;
    let dismissed = false;
    try {
      dismissed = sessionStorage.getItem(`wb.pwd.dismiss.${user.id}`) === "1";
    } catch {}
    if (dismissed) return;
    const timer = window.setTimeout(() => {
      setForcePassword(true);
      setPasswordOpen(true);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [user.id, user.must_change_password]);

  const dismissForcePassword = () => {
    try {
      sessionStorage.setItem(`wb.pwd.dismiss.${user.id}`, "1");
    } catch {}
    setForcePassword(false);
    setPasswordOpen(false);
  };

  // 配额用尽的提示等场景通过 window 事件打开「AI Key 设置」弹窗（openAiKeyModal()）
  useEffect(() => {
    const handler = () => setAiKeyOpen(true);
    window.addEventListener("open-ai-key", handler);
    return () => window.removeEventListener("open-ai-key", handler);
  }, []);

  const userMenuItems = [
    {
      key: "password",
      icon: <LockOutlined />,
      label: "修改密码",
      onClick: () => {
        setForcePassword(false);
        setPasswordOpen(true);
      },
    },
    {
      key: "ai-key",
      icon: <KeyOutlined />,
      label: "AI Key 设置",
      onClick: () => setAiKeyOpen(true),
    },
    {
      key: "pushplus",
      icon: <BellOutlined />,
      label: "消息推送设置",
      onClick: () => setPushplusOpen(true),
    },
    // 飞书入口已上顶栏（飞书 logo 图标）：未绑定点击直跳飞书授权页，已绑定点击开
    // 管理弹窗（发送测试 / 解绑），此处不再放重复菜单项（两个入口两种行为只会困惑）
    {
      key: "member",
      icon: <CrownOutlined />,
      label: "会员续费",
      onClick: () => setMemberOpen(true),
    },
    {
      key: "referral",
      icon: <GiftOutlined />,
      label: "我的推广",
      onClick: () => setReferralOpen(true),
    },
    { type: "divider" as const },
    // 反向入口：手机上切到完整版后要能切回移动版（桌面设备不显示，避免无意义入口）
    ...(isTouchDevice()
      ? [
          {
            key: "mobile",
            icon: <MobileOutlined />,
            label: "切换到手机版",
            onClick: () => {
              // 与「切完整版」同理：整页跳转，让 App 重新挂载并按新的偏好分流
              setDeviceOverride("mobile");
              window.location.href = "/m/tasks";
            },
          },
        ]
      : []),
    {
      key: "logout",
      icon: <LogoutOutlined />,
      label: "退出登录",
      onClick: handleLogout,
    },
  ];

  // 换肤面板：主题色（4 色块）+ 明暗模式（亮/暗）两个正交维度
  const themePanel = (
    <div className="theme-panel">
      <div className="theme-panel-section">
        <span className="theme-panel-title">主题色</span>
        <div className="theme-color-row">
          {THEME_COLORS.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`theme-color-dot${theme.color === c.key ? " is-active" : ""}`}
              style={{ background: c.swatch }}
              title={c.label}
              onClick={() => onChangeTheme({ ...theme, color: c.key })}
            >
              {theme.color === c.key ? <CheckOutlined /> : null}
            </button>
          ))}
        </div>
      </div>
      <div className="theme-panel-section">
        <span className="theme-panel-title">外观</span>
        <div className="theme-mode-row">
          <button
            type="button"
            className={`theme-mode-btn${theme.mode === "light" ? " is-active" : ""}`}
            onClick={() => onChangeTheme({ ...theme, mode: "light" })}
          >
            <SunOutlined /> 亮色
          </button>
          <button
            type="button"
            className={`theme-mode-btn${theme.mode === "dark" ? " is-active" : ""}`}
            onClick={() => onChangeTheme({ ...theme, mode: "dark" })}
          >
            <MoonOutlined /> 暗色
          </button>
        </div>
      </div>
    </div>
  );

  // 叶子菜单项（二级项 / 独立项共用）
  const leafNode = (leaf: NavLeaf, nested: boolean) => {
    const link = (
      <NavLink
        key={leaf.to}
        to={leaf.to}
        data-onb={leaf.to}
        className={({ isActive }) => (isActive ? "active" : "")}
        title={navCollapsed ? leaf.label : undefined}
        onMouseEnter={() => prefetchPage(leaf.to)}
        onFocus={() => prefetchPage(leaf.to)}
        onClick={() => setMobileNavOpen(false)}
      >
        <span className="nav-icon" style={{ background: leaf.color + "1a", color: leaf.color }}>
          {leaf.icon}
        </span>
        <span className="nav-label">{leaf.label}</span>
        {!navCollapsed && leaf.badge ? <span className="nav-badge">{leaf.badge}</span> : null}
      </NavLink>
    );
    // 收缩态下补一个右侧提示（二级项始终在展开容器里，不需要）
    if (nested || !navCollapsed) return link;
    return (
      <Tooltip key={leaf.to} title={leaf.label} placement="right">
        {link}
      </Tooltip>
    );
  };

  // 一级分组项
  const groupNode = (group: NavGroup) => {
    // 收缩态：侧栏只有 68px，inline 展开没地方放 → 图标 hover 弹浮层
    if (navCollapsed) {
      return (
        <Popover
          key={group.id}
          placement="rightTop"
          trigger="hover"
          arrow={false}
          content={
            <div className="nav-pop">
              <div className="nav-pop-title">{group.label}</div>
              {group.children.map((child) => (
                <NavLink
                  key={child.to}
                  to={child.to}
                  data-onb={child.to}
                  className={({ isActive }) => "nav-pop-item" + (isActive ? " active" : "")}
                  onMouseEnter={() => prefetchPage(child.to)}
                  onFocus={() => prefetchPage(child.to)}
                  onClick={() => setMobileNavOpen(false)}
                >
                  <span className="nav-icon" style={{ background: child.color + "1a", color: child.color }}>
                    {child.icon}
                  </span>
                  <span>{child.label}</span>
                </NavLink>
              ))}
            </div>
          }
        >
          <button type="button" className="nav-group-title" aria-label={group.label}>
            <span className="nav-icon" style={{ background: group.color + "1a", color: group.color }}>
              {group.icon}
            </span>
          </button>
        </Popover>
      );
    }

    const open = isGroupOpen(group.id);
    return (
      <div className="nav-group" key={group.id}>
        <button
          type="button"
          className={"nav-group-title" + (open ? " is-open" : "")}
          aria-expanded={open}
          onClick={() => toggleGroup(group.id)}
        >
          <span className="nav-icon" style={{ background: group.color + "1a", color: group.color }}>
            {group.icon}
          </span>
          <span className="nav-label">{group.label}</span>
          {group.badge ? <span className="nav-badge">{group.badge}</span> : null}
          <span className="nav-caret" />
        </button>
        {open ? <div className="nav-sub">{group.children.map((c) => leafNode(c, true))}</div> : null}
      </div>
    );
  };

  return (
    <div className={"app-layout" + (mobileNavOpen ? " nav-open" : "")}>
      <div className="app-nav-mask" onClick={() => setMobileNavOpen(false)} />
      <aside className={`sidebar${navCollapsed ? " collapsed" : ""}${mobileNavOpen ? " nav-open" : ""}`}>
        <div className="sidebar-logo">
          <span className="logo-text">{BRAND.name}</span>
        </div>

        <nav className="sidebar-nav">
          {visibleNav.map((node) => ("children" in node ? groupNode(node) : leafNode(node, false)))}
        </nav>
      </aside>

      <div className="main-area">
        {/* 顶栏：右上角用户信息 */}
        <header className="topbar">
          <Button
            type="text"
            className="topbar-collapse"
            icon={navCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={toggleMenu}
          />
          <div className="topbar-right">
            {/* 飞书提醒常驻入口：任何页面可见。未绑定时红点提示，已绑定变绿 */}
            <Tooltip title={user.feishu_bound ? "飞书提醒已开启" : "开启飞书提醒"}>
              <Badge dot={!user.feishu_bound} color="#ef4444" offset={[-2, 3]}>
                <Button
                  type="text"
                  className={"topbar-feishu-btn" + (user.feishu_bound ? " is-on" : "")}
                  icon={<FeishuLogo />}
                  loading={feishuJumping}
                  onClick={openFeishuEntry}
                />
              </Badge>
            </Tooltip>
            {/* 帮助入口：重看新手指引 / 常见问题。data-onb 锚点保留给引导高亮 */}
            <Dropdown
              menu={{
                items: [
                  { key: "onboarding", icon: <PlayCircleOutlined />, label: "重看新手指引" },
                  { key: "help", icon: <QuestionCircleOutlined />, label: "常见问题" },
                ],
                onClick: ({ key }) => {
                  if (key === "onboarding") {
                    setOnbNonce((n) => n + 1);
                    setOnbOpen(true);
                  }
                  if (key === "help") navigate("/help");
                },
              }}
              placement="bottomRight"
              trigger={["click"]}
            >
              <Button
                type="text"
                data-onb="topbar-help"
                className="topbar-help-btn"
                icon={<QuestionCircleOutlined />}
              />
            </Dropdown>
            <Popover
              content={themePanel}
              placement="bottomRight"
              trigger="click"
              arrow={false}
            >
              <Button type="text" className="topbar-theme-btn" icon={<BgColorsOutlined />} title="切换风格" />
            </Popover>
            <Dropdown menu={{ items: userMenuItems }} placement="bottomRight" trigger={["click"]}>
              <div className="topbar-user-trigger" data-onb="topbar-user">
                <Avatar style={{ backgroundColor: user.role === "admin" ? "#f59e0b" : "var(--color-primary)" }}>
                  {user.name.charAt(0).toUpperCase()}
                </Avatar>
                <div className="topbar-user-info">
                  <div className="topbar-user-name">
                    {user.name}
                    <Tag color={user.role === "admin" ? "gold" : "blue"} style={{ marginLeft: 6, fontSize: 10 }}>
                      {ROLE_LABELS[user.role] || user.role}
                    </Tag>
                  </div>
                </div>
              </div>
            </Dropdown>
          </div>
        </header>

        {user.status === "frozen" && (
          <Alert
            type="warning"
            showIcon
            className="frozen-banner"
            message="账户已冻结，当前为只读模式"
            description={
              <span>
                会员已到期未续费，您可查看数据但无法新增或修改。续费后即刻恢复。
                <Button type="link" size="small" style={{ paddingInline: 4 }} onClick={() => setMemberOpen(true)}>
                  去续费
                </Button>
              </span>
            }
          />
        )}

        {/* 飞书引导横幅：未绑定用户可见（可关闭，按用户记忆；绑定后自动消失）。
            文案按「已配置 / 管理员未配置 / 成员未配置」分流，按钮共用统一入口。 */}
        {!user.feishu_bound && !feishuGuideDismissed && feishuConfigured !== null && (
          <Alert
            type="info"
            showIcon
            closable
            onClose={dismissFeishuGuide}
            className="feishu-guide-banner"
            message="开启飞书提醒"
            description={
              feishuConfigured ? (
                <span>
                  合同到期、面试安排、审批结果自动推送到你的飞书，手机上不错过任何节点。
                  <Button type="link" size="small" loading={feishuJumping} style={{ paddingInline: 4 }} onClick={openFeishuEntry}>
                    立即开启
                  </Button>
                </span>
              ) : user.role === "admin" ? (
                <span>
                  飞书集成还没有配置：配好应用后，成员点一下就能绑定，到期 / 面试 / 审批提醒直达飞书。
                  <Button type="link" size="small" style={{ paddingInline: 4 }} onClick={openFeishuEntry}>
                    去配置
                  </Button>
                </span>
              ) : (
                <span>管理员还没有开启飞书集成，开启后即可把合同到期、面试、审批提醒直接收到飞书。</span>
              )
            }
          />
        )}

        <main className="main-content">{children}</main>
      </div>

      {/* 弹窗统一按 open 门控：未打开时连 chunk 都不会请求。
          这里不需要 Suspense——lazyModal 是非挂起式的（自己管加载态），
          用 React.lazy 才会 suspend 并把加载失败抛给顶层 ErrorBoundary。 */}
      {onbOpen && (
        <Onboarding
          key={onbNonce}
          steps={onbSteps}
          open
          onClose={closeOnboarding}
          onNavigate={navigate}
        />
      )}

      {pushplusOpen && (
        <PushplusModal
          open
          configured={!!user.pushplus_configured}
          onClose={() => setPushplusOpen(false)}
          onConfiguredChange={(configured) => onUserChange({ ...user, pushplus_configured: configured })}
        />
      )}

      {feishuOpen && (
        <FeishuBindModal
          open
          bound={!!user.feishu_bound}
          onClose={() => setFeishuOpen(false)}
        />
      )}

      {passwordOpen && (
        <PasswordModal
          open
          forced={forcePassword}
          // 参数为 true 表示「加载失败被动关闭」：此时不能记「本次会话别再弹」，
          // 否则用户等于靠一次 chunk 404 绕过了强制改密码。
          onClose={(failed?: boolean) =>
            forcePassword && !failed ? dismissForcePassword() : setPasswordOpen(false)
          }
          onSuccess={() => {
            // 改完后清掉「必须改密码」标记，避免本次会话反复弹
            setForcePassword(false);
            onUserChange({ ...user, must_change_password: false });
          }}
        />
      )}

      {memberOpen && (
        <MembershipModal
          open
          user={user}
          onClose={() => setMemberOpen(false)}
        />
      )}

      {referralOpen && (
        <ReferralModal open onClose={() => setReferralOpen(false)} />
      )}

      {aiKeyOpen && <AiKeyModal open onClose={() => setAiKeyOpen(false)} />}
    </div>
  );
}
