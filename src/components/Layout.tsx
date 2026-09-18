import { NavLink, useNavigate } from "react-router-dom";
import type { User } from "../types";

interface Props {
  user: User;
  onLogout: () => void;
  children: React.ReactNode;
}

const navItems = [
  { to: "/talents", label: "人才库", icon: "👥" },
  { to: "/tags", label: "标签管理", icon: "🏷️" },
  { to: "/import", label: "批量导入", icon: "📥" },
];

export default function Layout({ user, onLogout, children }: Props) {
  const navigate = useNavigate();

  const handleLogout = async () => {
    onLogout();
    navigate("/login");
  };

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <span className="logo-icon">🎯</span>
          <span className="logo-text">HR 人才库</span>
        </div>

        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `nav-item ${isActive ? "active" : ""}`
              }
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="user-info">
            <div className="user-avatar">{user.name.charAt(0).toUpperCase()}</div>
            <div className="user-detail">
              <div className="user-name">{user.name}</div>
              <div className="user-email">{user.email}</div>
            </div>
          </div>
          <button className="btn-logout" onClick={handleLogout}>
            退出
          </button>
        </div>
      </aside>

      <main className="main-content">{children}</main>
    </div>
  );
}
