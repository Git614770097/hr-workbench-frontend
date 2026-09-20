import { useState, useEffect } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { Avatar, Button, Tag } from "antd";
import { LogoutOutlined } from "@ant-design/icons";
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

  const navItems: { to: string; label: string; icon: string; badge?: number }[] = [
    { to: "/talents", label: "人才库", icon: "👥" },
    { to: "/risks", label: "风险预警", icon: "⚠️", badge: urgentCount },
    { to: "/templates", label: "文件模板库", icon: "📄" },
    { to: "/tags", label: "标签管理", icon: "🏷️" },
    ...(user.role === "admin" ? [{ to: "/users", label: "用户管理", icon: "👤" }] : []),
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
          <span>HR 人才库</span>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
              {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.8rem" }}>
            <Avatar style={{ backgroundColor: user.role === "admin" ? "#f59e0b" : "#3b82f6" }}>
              {user.name.charAt(0).toUpperCase()}
            </Avatar>
            <div>
              <div style={{ fontSize: "0.85rem", fontWeight: 600 }}>
                {user.name} <Tag color={user.role === "admin" ? "gold" : "blue"} style={{ marginLeft: 4, fontSize: 10 }}>{ROLE_LABELS[user.role] || user.role}</Tag>
              </div>
              <div style={{ fontSize: "0.75rem", color: "rgba(255,255,255,0.45)" }}>{user.phone}</div>
            </div>
          </div>
          <Button
            block
            size="small"
            type="text"
            icon={<LogoutOutlined />}
            onClick={handleLogout}
            style={{ color: "rgba(255,255,255,0.65)" }}
          >
            退出登录
          </Button>
        </div>
      </aside>

      <main className="main-content">{children}</main>
    </div>
  );
}
