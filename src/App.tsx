import { Routes, Route, Navigate } from "react-router-dom";
import { useState, useEffect, useCallback, lazy, Suspense } from "react";
import { Spin } from "antd";
import type { User } from "./types";
import type { ThemeKey } from "./theme";
import { api } from "./api";
// 登录页保持同步加载（未登录时的首屏，避免白屏闪烁）
import Login from "./pages/Login";
import Layout from "./components/Layout";

// 其余页面按路由懒加载：把 Quill 富文本编辑器、pdfjs 等重依赖
// 推迟到真正访问对应页面时才下载，降低首屏体积。
const TalentList = lazy(() => import("./pages/TalentList"));
const TalentDetail = lazy(() => import("./pages/TalentDetail"));
const Pipeline = lazy(() => import("./pages/Pipeline"));
const Jobs = lazy(() => import("./pages/Jobs"));
const Tasks = lazy(() => import("./pages/Tasks"));
const Users = lazy(() => import("./pages/Users"));
const Roles = lazy(() => import("./pages/Roles"));
const TemplateLibrary = lazy(() => import("./pages/TemplateLibrary"));

// 页面切换时的加载占位
const pageFallback = (
  <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: 240 }}>
    <Spin size="large" />
  </div>
);

// 权限守卫：无权限访问某菜单时重定向到人才库（admin 永远放行）
function RequirePerm({ user, perm, children }: { user: User; perm: string; children: React.ReactNode }) {
  if (user.role === "admin") return <>{children}</>;
  if ((user.permissions || []).includes(perm)) return <>{children}</>;
  return <Navigate to="/talents" replace />;
}

interface AppProps {
  themeKey: ThemeKey;
  onChangeTheme: (key: ThemeKey) => void;
}

export default function App({ themeKey, onChangeTheme }: AppProps) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchUser = useCallback(async () => {
    const token = localStorage.getItem("token");
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const res = await api.me();
      setUser(res);
    } catch {
      localStorage.removeItem("token");
      setUser(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const logout = () => {
    localStorage.removeItem("token");
    setUser(null);
  };

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login onLogin={fetchUser} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Layout user={user} onLogout={logout} themeKey={themeKey} onChangeTheme={onChangeTheme}>
      <Suspense fallback={pageFallback}>
        <Routes>
          <Route path="/" element={<Navigate to="/talents" replace />} />
          <Route path="/talents" element={<RequirePerm user={user} perm="talents"><TalentList /></RequirePerm>} />
          <Route path="/talents/:id" element={<RequirePerm user={user} perm="talents"><TalentDetail /></RequirePerm>} />
          <Route path="/pipeline" element={<RequirePerm user={user} perm="pipeline"><Pipeline /></RequirePerm>} />
          <Route path="/jobs" element={<RequirePerm user={user} perm="jobs"><Jobs /></RequirePerm>} />
          <Route path="/tasks" element={<RequirePerm user={user} perm="tasks"><Tasks /></RequirePerm>} />
          <Route path="/templates" element={<RequirePerm user={user} perm="templates"><TemplateLibrary /></RequirePerm>} />
          {user.role === "admin" && <Route path="/roles" element={<Roles />} />}
          {user.role === "admin" && <Route path="/users" element={<Users />} />}
          <Route path="*" element={<Navigate to="/talents" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
