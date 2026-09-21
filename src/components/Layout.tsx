import { useState, useEffect } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { Avatar, Button, Tag, Dropdown, Tooltip } from "antd";
import {
  LogoutOutlined,
  TeamOutlined,
  AlertOutlined,
  FileTextOutlined,
  TagsOutlined,
  UserOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  BgColorsOutlined,
  CheckOutlined,
  SafetyOutlined,
  DeploymentUnitOutlined,
  SolutionOutlined,
  CarryOutOutlined,
} from "@ant-design/icons";
import type { User } from "../types";
import { ROLE_LABELS } from "../types";
import { api } from "../api";
import { THEMES, type ThemeKey } from "../theme";

interface Props {
  user: User;
  onLogout: () => void;
  themeKey: ThemeKey;
  onChangeTheme: (key: ThemeKey) => void;
  children: React.ReactNode;
}

export default function Layout({ user, onLogout, themeKey, onChangeTheme, children }: Props) {
  const navigate = useNavigate();
  // 侧栏紧急预警角标（红级风险数量），失败静默
  const [urgentCount, setUrgentCount] = useState(0);
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

  // canSee 需要先于 useEffect 使用，提前定义（函数声明有提升，但为可读性放前面）
  const canSee = (key: string) => {
    if (user.role === "admin") return true;
    return (user.permissions || []).includes(key);
  };

  useEffect(() => {
    if (canSee("risks")) {
      api.getRisks()
        .then((res) => setUrgentCount(res.summary.red))
        .catch(() => setUrgentCount(0));
    }
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
  // 同类里再按流程先后：先有人（人才库）→ 再有岗（岗位管理）→ 再看进度（招聘流程）→ 最后跟进（待办）。
  const navItems: { to: string; label: string; icon: React.ReactNode; color: string; badge?: number; perm: string }[] = [
    // —— 第一梯队：招聘日常主循环，使用频率最高 ——
    { to: "/talents", label: "人才库管理", icon: <TeamOutlined />, color: "#3b82f6", perm: "talents" },
    { to: "/jobs", label: "岗位管理", icon: <SolutionOutlined />, color: "#6366f1", perm: "jobs" },
    { to: "/pipeline", label: "招聘流程", icon: <DeploymentUnitOutlined />, color: "#0ea5e9", perm: "pipeline" },
    { to: "/tasks", label: "跟进待办", icon: <CarryOutOutlined />, color: "#f97316", badge: taskBadge, perm: "tasks" },
    // —— 第二梯队：按需查阅与产出 ——
    { to: "/templates", label: "模板库管理", icon: <FileTextOutlined />, color: "#8b5cf6", perm: "templates" },
    { to: "/risks", label: "风险预警", icon: <AlertOutlined />, color: "#f43f5e", badge: urgentCount, perm: "risks" },
    // —— 第三梯队：基础配置与系统管理，频率最低 ——
    { to: "/tags", label: "标签管理", icon: <TagsOutlined />, color: "#10b981", perm: "tags" },
    ...(user.role === "admin" ? [{ to: "/roles", label: "角色管理", icon: <SafetyOutlined />, color: "#f59e0b", perm: "roles" }] : []),
    ...(user.role === "admin" ? [{ to: "/users", label: "用户管理", icon: <UserOutlined />, color: "#f59e0b", perm: "users" }] : []),
  ].filter((item) => canSee(item.perm));

  const handleLogout = () => {
    onLogout();
    navigate("/login");
  };

  const userMenuItems = [
    {
      key: "logout",
      icon: <LogoutOutlined />,
      label: "退出登录",
      onClick: handleLogout,
    },
  ];

  // 换肤下拉：列出所有主题，当前项打勾
  const themeMenuItems = THEMES.map((t) => ({
    key: t.key,
    label: (
      <span className="theme-menu-item">
        <span className="theme-swatch" style={{ background: t.swatch }} />
        <span className="theme-menu-label">{t.label}</span>
        {t.key === themeKey ? <CheckOutlined className="theme-menu-check" /> : null}
      </span>
    ),
    onClick: () => onChangeTheme(t.key),
  }));

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
            <Dropdown
              menu={{ items: themeMenuItems, selectable: true, selectedKeys: [themeKey] }}
              placement="bottomRight"
              trigger={["click"]}
            >
              <Button type="text" className="topbar-theme-btn" icon={<BgColorsOutlined />} title="切换风格" />
            </Dropdown>
            <Dropdown menu={{ items: userMenuItems }} placement="bottomRight" trigger={["click"]}>
              <div className="topbar-user-trigger">
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
    </div>
  );
}
