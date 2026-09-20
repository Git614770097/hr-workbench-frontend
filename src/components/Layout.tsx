import { useState, useEffect } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { Avatar, Button, Tag } from "antd";
import {
  LogoutOutlined,
  TeamOutlined,
  AlertOutlined,
  FileTextOutlined,
  TagsOutlined,
  UserOutlined,
} from "@ant-design/icons";
import type { User } from "../types";
import { ROLE_LABELS } from "../types";
import { api } from "../api";

interface Props {
  user: User;
  onLogout: () => void;
  children: React.ReactNode;
}

export default function Layout({ user, onLogout, children }: Props) {
  const navigate = useNavigate();
  // 侧栏紧急预警角标（红级风险数量），失败静默
  const [urgentCount, setUrgentCount] = useState(0);

  useEffect(() => {
    api.getRisks()
      .then((res) => setUrgentCount(res.summary.red))
      .catch(() => setUrgentCount(0));
  }, []);

  const navItems: { to: string; label: string; icon: React.ReactNode; color: string; badge?: number }[] = [
    { to: "/talents", label: "人才库", icon: <TeamOutlined />, color: "#3b82f6" },
    { to: "/risks", label: "风险预警", icon: <AlertOutlined />, color: "#f43f5e", badge: urgentCount },
    { to: "/templates", label: "文件模板库", icon: <FileTextOutlined />, color: "#8b5cf6" },
    { to: "/tags", label: "标签管理", icon: <TagsOutlined />, color: "#10b981" },
    ...(user.role === "admin" ? [{ to: "/users", label: "用户管理", icon: <UserOutlined />, color: "#f59e0b" }] : []),
  ];

  const handleLogout = () => {
    onLogout();
    navigate("/login");
  };

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <span className="logo-icon">🎯</span>
          <span className="logo-text">HR 工作台</span>
        </div>

        <div className="sidebar-group-label">工作区</div>
        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              <span className="nav-icon" style={{ background: item.color + "1a", color: item.color }}>
                {item.icon}
              </span>
              <span className="nav-label">{item.label}</span>
              {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.8rem" }}>
            <Avatar style={{ backgroundColor: user.role === "admin" ? "#f59e0b" : "#3b82f6" }}>
              {user.name.charAt(0).toUpperCase()}
            </Avatar>
            <div className="sidebar-user">
              <div className="sidebar-user-name">
                {user.name} <Tag color={user.role === "admin" ? "gold" : "blue"} style={{ marginLeft: 4, fontSize: 10 }}>{ROLE_LABELS[user.role] || user.role}</Tag>
              </div>
              <div className="sidebar-user-phone">{user.phone}</div>
            </div>
          </div>
          <Button
            block
            size="small"
            type="text"
            icon={<LogoutOutlined />}
            onClick={handleLogout}
            className="sidebar-logout"
          >
            退出登录
          </Button>
        </div>
      </aside>

      <main className="main-content">{children}</main>
    </div>
  );
}
