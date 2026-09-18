import { Routes, Route, Navigate } from "react-router-dom";
import { useState, useEffect, useCallback } from "react";
import type { User } from "./types";
import { api } from "./api";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Layout from "./components/Layout";
import TalentList from "./pages/TalentList";
import TalentDetail from "./pages/TalentDetail";
import TalentForm from "./pages/TalentForm";
import Tags from "./pages/Tags";
import Import from "./pages/Import";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchUser = useCallback(async () => {
    const token = localStorage.getItem("token");
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const res = await api.get<User>("/auth/me");
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
    return <div style={{ textAlign: "center", padding: "3rem" }}>加载中…</div>;
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login onLogin={fetchUser} />} />
        <Route path="/register" element={<Register onLogin={fetchUser} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Layout user={user} onLogout={logout}>
      <Routes>
        <Route path="/" element={<Navigate to="/talents" replace />} />
        <Route path="/talents" element={<TalentList />} />
        <Route path="/talents/new" element={<TalentForm />} />
        <Route path="/talents/:id/edit" element={<TalentForm />} />
        <Route path="/talents/:id" element={<TalentDetail />} />
        <Route path="/tags" element={<Tags />} />
        <Route path="/import" element={<Import />} />
        <Route path="*" element={<Navigate to="/talents" replace />} />
      </Routes>
    </Layout>
  );
}
