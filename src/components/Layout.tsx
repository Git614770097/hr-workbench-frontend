import { useState, useEffect, useCallback } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { Avatar, Button, Tag, Dropdown, Tooltip, Popover } from "antd";
import {
  LogoutOutlined,
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
  CarryOutOutlined,
  UserSwitchOutlined,
  FileProtectOutlined,
  SafetyCertificateOutlined,
  SunOutlined,
  MoonOutlined,
  BellOutlined,
  LockOutlined,
} from "@ant-design/icons";
import { QuestionCircleOutlined, PlayCircleOutlined } from "@ant-design/icons";
import type { User } from "../types";
import { ROLE_LABELS } from "../types";
import { api } from "../api";
import { THEME_COLORS, type ThemeState } from "../theme";
import Onboarding from "./Onboarding";
import { ONBOARDING_STEPS } from "./onboardingSteps";
import PushplusModal from "./PushplusModal";
import PasswordModal from "./PasswordModal";

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
  // 个人消息推送设置弹窗
  const [pushplusOpen, setPushplusOpen] = useState(false);
  // 修改自己的密码弹窗；forced=true 表示管理员重置过密码、本次登录必须先改掉
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [forcePassword, setForcePassword] = useState(false);
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
      setOnbOpen(true);
      return;
    }
    let seen = false;
    try {
      seen = localStorage.getItem(seenKeyFor(user.id)) === "1";
    } catch {}
    if (seen) return;
    // 延迟一点，等首屏接口与布局稳定再弹，避免高亮位置算歪
    const timer = window.setTimeout(() => setOnbOpen(true), 900);
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

  // 判断某菜单是否可见（admin 全可见；普通用户看 permissions）
  // 见上方提前定义的 canSee

  // 菜单顺序按「日常使用频率」排列：
  //   高频业务（每天要用）→ 中频管理（每周/按需）→ 低频配置（仅管理员）。
  // 同类里以「岗位为中心」的招聘动线排序：先建岗（岗位管理）→ 再找人（人才库）
  // → 再推进（招聘看板）→ 日常跟进（待办）→ 复盘（漏斗/画像）→ 支撑（模板库）。
  const navItems: { to: string; label: string; icon: React.ReactNode; color: string; badge?: number; perm: string }[] = [
    // —— 每日待办优先，其后是招聘主循环（岗位 → 流程 → 漏斗）——
    { to: "/tasks", label: "待办日历", icon: <CarryOutOutlined />, color: "#f97316", badge: taskBadge, perm: "tasks" },
    { to: "/jobs", label: "岗位管理", icon: <SolutionOutlined />, color: "#6366f1", perm: "jobs" },
    { to: "/pipeline", label: "招聘看板", icon: <DeploymentUnitOutlined />, color: "#0ea5e9", perm: "pipeline" },
    { to: "/funnel", label: "招聘漏斗", icon: <FunnelPlotOutlined />, color: "#14b8a6", perm: "funnel" },
    // 合同管理与人才库同源数据（talents 表的合同/试用期字段），复用 talents 权限，不新增菜单 key
    { to: "/contracts", label: "合同管理", icon: <FileProtectOutlined />, color: "#d97706", perm: "talents" },
    // 社保公积金台账同样复用 talents 权限
    { to: "/social", label: "社保公积金", icon: <SafetyCertificateOutlined />, color: "#0d9488", perm: "talents" },
    // —— 按需查阅与产出 ——
    { to: "/profiles", label: "人才画像", icon: <UserSwitchOutlined />, color: "#10b981", perm: "profiles" },
    { to: "/talents", label: "人才库管理", icon: <TeamOutlined />, color: "#3b82f6", perm: "talents" },
    { to: "/templates", label: "模板库管理", icon: <FileTextOutlined />, color: "#8b5cf6", perm: "templates" },
    // —— 基础配置与系统管理，频率最低 ——
    ...(user.role === "admin" ? [{ to: "/roles", label: "角色管理", icon: <SafetyOutlined />, color: "#f59e0b", perm: "roles" }] : []),
    ...(user.role === "admin" ? [{ to: "/users", label: "用户管理", icon: <UserOutlined />, color: "#f59e0b", perm: "users" }] : []),
  ].filter((item) => canSee(item.perm));

  const handleLogout = () => {
    onLogout();
    navigate("/login");
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
    { type: "divider" as const },
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

  return (
    <div className="app-layout">
      <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
        <div className="sidebar-logo">
          <span className="logo-text">人力资源管理系统</span>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => {
            const link = (
              <NavLink
                key={item.to}
                to={item.to}
                data-onb={item.to}
                className={({ isActive }) => (isActive ? "active" : "")}
                title={collapsed ? item.label : undefined}
              >
                <span className="nav-icon" style={{ background: item.color + "1a", color: item.color }}>
                  {item.icon}
                </span>
                <span className="nav-label">{item.label}</span>
                {!collapsed && item.badge ? <span className="nav-badge">{item.badge}</span> : null}
              </NavLink>
            );
            return collapsed ? (
              <Tooltip key={item.to} title={item.label} placement="right">
                {link}
              </Tooltip>
            ) : (
              link
            );
          })}
        </nav>
      </aside>

      <div className="main-area">
        {/* 顶栏：右上角用户信息 */}
        <header className="topbar">
          <Button
            type="text"
            className="topbar-collapse"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={toggleCollapsed}
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
                  if (key === "onboarding") setOnbOpen(true);
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

        <main className="main-content">{children}</main>
      </div>

      <Onboarding
        steps={ONBOARDING_STEPS}
        open={onbOpen}
        onClose={closeOnboarding}
        onNavigate={navigate}
      />

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
    </div>
  );
}
