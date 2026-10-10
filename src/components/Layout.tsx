import { useState, useEffect, useCallback, useMemo } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Avatar, Button, Tag, Dropdown, Tooltip, Popover, Alert } from "antd";
import {
  LogoutOutlined,
  MobileOutlined,
  TeamOutlined,
  FileTextOutlined,
  UserOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  BgColorsOutlined,
  CheckOutlined,
  SafetyOutlined,
  DeploymentUnitOutlined,
  FunnelPlotOutlined,
  SolutionOutlined,
  FileAddOutlined,
  CarryOutOutlined,
  CalendarOutlined,
  AuditOutlined,
  UserSwitchOutlined,
  FileProtectOutlined,
  SafetyCertificateOutlined,
  SunOutlined,
  MoonOutlined,
  BellOutlined,
  LockOutlined,
  CrownOutlined,
  GiftOutlined,
  SettingOutlined,
  RocketOutlined,
  AppstoreOutlined,
  ProfileOutlined,
  BarChartOutlined,
} from "@ant-design/icons";
import { QuestionCircleOutlined, PlayCircleOutlined } from "@ant-design/icons";
import type { User } from "../types";
import { ROLE_LABELS } from "../types";
import { api } from "../api";
import { THEME_COLORS, type ThemeState } from "../theme";
import Onboarding from "./Onboarding";
import { onboardingStepsFor } from "./onboardingSteps";
import PushplusModal from "./PushplusModal";
import PasswordModal from "./PasswordModal";
import MembershipModal from "./MembershipModal";
import ReferralModal from "./ReferralModal";
import { isTouchDevice, setDeviceOverride } from "../utils/device";
import { useIdentityProfile, notifyIdentityChanged } from "../useIdentity";
import { navLabelFor } from "../identityProfiles";

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
  /** 动态角标（待办数），运行时注入 */
  badge?: number;
}

interface NavGroup {
  /** 分组 id：仅作展开状态的 key，不参与路由 */
  id: string;
  /** 身份化显示名的查找键（不是路由）。写进 identityProfiles.navLabels 即可按身份改名 */
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
      { to: "/talents", label: "人才库管理", icon: <TeamOutlined />, color: "#3b82f6", perm: "talents" },
      { to: "/profiles", label: "人才画像", icon: <UserSwitchOutlined />, color: "#10b981", perm: "profiles" },
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

  // —— 分析复盘：独立页，不折叠 ——
  { to: "/funnel", label: "招聘概览", icon: <FunnelPlotOutlined />, color: "#14b8a6", perm: "funnel" },

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
      { to: "/settings", label: "系统设置", icon: <SettingOutlined />, color: "#64748b", perm: "settings", adminOnly: true },
      // 日志管理：模块使用热度（埋点数据），同为管理员专属，同样不占菜单权限 key
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
  // 品牌档案：按当前用户身份取（猎头/团队版会换品牌名与部分菜单名）
  const brand = useIdentityProfile();
  // 新手指引按身份 + 实际权限生成（文案过 termFor，并按权限剔除无权访问的步骤），
  // 用 useMemo 固定引用，避免每次 render 生成新数组导致引导弹窗重置。
  // 依赖用「权限指纹」字符串而非 user 对象：静默刷新会换 user 引用，
  // 直接依赖 user 会在用户切回窗口时把引导重置回第一步。
  const permFingerprint = `${user.role}|${(user.permissions || []).join(",")}`;
  const onbSteps = useMemo(() => onboardingStepsFor(brand, user), [brand.key, permFingerprint]);
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
  // 修改自己的密码弹窗；forced=true 表示管理员重置过密码、本次登录必须先改掉
  const [passwordOpen, setPasswordOpen] = useState(false);
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
      label: navLabelFor(brand, leaf.to, leaf.label),
      badge: leaf.to === "/tasks" ? taskBadge : undefined,
    });
    const out: (NavGroup | NavLeaf)[] = [];
    for (const node of NAV_TREE) {
      if ("children" in node) {
        const kids = node.children
          .filter((c) => (c.adminOnly ? user.role === "admin" : canSee(c.perm)))
          .map(decorate);
        // 组内一项都看不到 → 整组不渲染，避免出现「打开是空的」分组
        if (kids.length === 0) continue;
        out.push({
          ...node,
          // 一级标题也走身份化：labelKey 不是路由，只作 navLabels 的查找键，
          // 两档身份都未收录时回落到原 label（显示与改造前一致）
          label: navLabelFor(brand, node.labelKey, node.label),
          badge: kids.reduce((n, k) => n + (k.badge || 0), 0) || undefined,
          children: kids,
        });
      } else {
        if (node.adminOnly ? user.role !== "admin" : !canSee(node.perm)) continue;
        out.push(decorate(node));
      }
    }
    return out;
    // permFingerprint 已含 role + permissions 指纹，等价于依赖 canSee 的结果
  }, [brand.key, permFingerprint, taskBadge]);

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
    document.title = `${brand.name} · ${brand.tagline}`;
  }, [brand.name, brand.tagline]);

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
      key: "pushplus",
      icon: <BellOutlined />,
      label: "消息推送设置",
      onClick: () => setPushplusOpen(true),
    },
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
          <span className="logo-text">{brand.name}</span>
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
                <Avatar style={{ backgroundColor: user.role === "admin" ? "#f59e0b" : "#3b82f6" }}>
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

        <main className="main-content">{children}</main>
      </div>

      {onbOpen && (
        <Onboarding
          key={onbNonce}
          steps={onbSteps}
          open
          onClose={closeOnboarding}
          onNavigate={navigate}
        />
      )}

      <PushplusModal
        open={pushplusOpen}
        configured={!!user.pushplus_configured}
        onClose={() => setPushplusOpen(false)}
        onConfiguredChange={(configured) => onUserChange({ ...user, pushplus_configured: configured })}
      />

      <PasswordModal
        open={passwordOpen}
        forced={forcePassword}
        onClose={() => (forcePassword ? dismissForcePassword() : setPasswordOpen(false))}
        onSuccess={() => {
          // 改完后清掉「必须改密码」标记，避免本次会话反复弹
          setForcePassword(false);
          onUserChange({ ...user, must_change_password: false });
        }}
      />

      <MembershipModal
        open={memberOpen}
        user={user}
        onClose={() => setMemberOpen(false)}
      />

      <ReferralModal open={referralOpen} onClose={() => setReferralOpen(false)} />
    </div>
  );
}
