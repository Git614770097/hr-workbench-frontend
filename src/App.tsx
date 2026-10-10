import { Routes, Route, Navigate, Link, useLocation, useNavigate } from "react-router-dom";
import { useState, useEffect, useCallback, lazy, Suspense } from "react";
import { Spin, Button, Alert } from "antd";
import type { User } from "./types";
import type { ThemeState } from "./theme";
import { api } from "./api";
import { DictProvider } from "./dict";
// 登录页与落地页保持同步加载（未登录时的首屏，避免白屏闪烁）
import Login from "./pages/Login";
import Landing from "./pages/Landing";
import Layout from "./components/Layout";
// 移动版（/m）：独立布局 + 页面，与桌面侧栏体系完全分开
import MobileLayout from "./mobile/MobileLayout";
import { mobileTabsFor } from "./mobile/tabs";
import { isMobileDevice } from "./utils/device";
import { firstAccessiblePath } from "./utils/routeAccess";

/**
 * 是否属于移动版路由。
 * 必须是「/m」或「/m/…」，不能用 startsWith("/m")——
 * 那样 "/match"（智能匹配页）也会被当成移动版，渲染空白页（无路由匹配）。
 */
function isMobilePath(pathname: string): boolean {
  return pathname === "/m" || pathname.startsWith("/m/");
}
import { notifyIdentityChanged } from "./useIdentity";
import ChangelogModal from "./components/ChangelogModal";
// 使用埋点：桌面与移动两棵树各挂一份，不渲染任何 UI
import UsageTracker from "./components/UsageTracker";

// 其余页面按路由懒加载：把 Quill 富文本编辑器、pdfjs 等重依赖
// 推迟到真正访问对应页面时才下载，降低首屏体积。
const TalentList = lazy(() => import("./pages/TalentList"));
const TalentDetail = lazy(() => import("./pages/TalentDetail"));
// 智能匹配：从人才库工具栏进入，页面内含 pdfjs/mammoth 等重依赖，按需加载
const Match = lazy(() => import("./pages/Match"));
// 人才画像：独立的画像分级管理页
const Profiles = lazy(() => import("./pages/Profiles"));
const Pipeline = lazy(() => import("./pages/Pipeline"));
const Interviews = lazy(() => import("./pages/Interviews"));
const Approvals = lazy(() => import("./pages/Approvals"));
const Onboarding = lazy(() => import("./pages/Onboarding"));
const Funnel = lazy(() => import("./pages/Funnel"));
const Jobs = lazy(() => import("./pages/Jobs"));
const Requisitions = lazy(() => import("./pages/Requisitions"));
const Tasks = lazy(() => import("./pages/Tasks"));
// 合同管理：人才档案的合同/试用期字段集中视图，复用 talents 权限
const Contracts = lazy(() => import("./pages/Contracts"));
// 社保公积金台账：参保状态/基数/比例 + 增减员待办联动，复用 talents 权限
const Social = lazy(() => import("./pages/Social"));
const Users = lazy(() => import("./pages/Users"));
const Roles = lazy(() => import("./pages/Roles"));
const Settings = lazy(() => import("./pages/Settings"));
// 日志管理：模块使用热度（管理员专属），含 ECharts，按需加载
const Logs = lazy(() => import("./pages/Logs"));
const MTasks = lazy(() => import("./mobile/MTasks"));
const MPipeline = lazy(() => import("./mobile/MPipeline"));
const MTalents = lazy(() => import("./mobile/MTalents"));
const MFunnel = lazy(() => import("./mobile/MFunnel"));
const TemplateLibrary = lazy(() => import("./pages/TemplateLibrary"));
// 帮助中心：轻量 FAQ 页，从顶栏问号进入，不占侧栏菜单
const Help = lazy(() => import("./pages/Help"));

// 页面切换时的加载占位
const pageFallback = (
  <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: 240 }}>
    <Spin size="large" />
  </div>
);

// 权限守卫：无权限访问某菜单时重定向到该用户第一个可访问的菜单；
// 一个都没有（未分配角色）时给出兜底提示——否则会反复重定向到无权页面形成死循环。
function RequirePerm({ user, perm, children }: { user: User; perm: string; children: React.ReactNode }) {
  if (user.role === "admin") return <>{children}</>;
  if ((user.permissions || []).includes(perm)) return <>{children}</>;
  const home = firstAccessiblePath(user);
  return home ? <Navigate to={home} replace /> : <NoAccess />;
}

// 移动端权限守卫：与桌面 RequirePerm 同一口径，但重定向目标不能是桌面 /talents，
// 而是该用户第一个可用的移动 Tab；一个都没有时给兜底提示（继续重定向会死循环）。
function MGuard({ user, perm, children }: { user: User; perm: string; children: React.ReactNode }) {
  if (user.role === "admin" || (user.permissions || []).includes(perm)) return <>{children}</>;
  const home = mobileTabsFor(user)[0]?.path;
  return home ? <Navigate to={home} replace /> : <NoAccess />;
}

function NoAccess() {
  return (
    <div style={{ padding: "40px 16px" }}>
      <Alert
        type="warning"
        showIcon
        message="当前账号尚未分配功能权限"
        description="请联系管理员为你分配角色；分配后重新登录即可使用。"
      />
    </div>
  );
}

interface AppProps {
  theme: ThemeState;
  onChangeTheme: (s: ThemeState) => void;
}

export default function App({ theme, onChangeTheme }: AppProps) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  // 有 token 但首屏加载失败（典型：D1 冷启动导致 /api/auth/me 查询挂起超时），
  // 不进登录页、给「重试」入口，避免一直卡在 loading 出不来。
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchUser = useCallback(async () => {
    const token = localStorage.getItem("token");
    if (!token) {
      setLoading(false);
      return;
    }
    setLoadError(null);
    try {
      const res = await api.me();
      // 先写缓存再 setUser：Layout 首次挂载时 useIdentityProfile 会同步读 localStorage，
      // 顺序反了会读到旧值（品牌文案慢一拍）。
      try { localStorage.setItem("user", JSON.stringify(res)); } catch {}
      setUser(res);
    } catch {
      // request 内遇到 401 已经清 token 并跳登录；其余（含超时）说明有 token 但请求失败，
      // 多为 D1 冷启动，留「重试」入口。
      if (localStorage.getItem("token")) {
        setLoadError("加载超时或网络异常，系统可能正在启动，请点击重试。");
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  // 静默刷新用户信息：管理员改了某人的身份 / 权限 / 会员状态后，对方把页面切回前台
  // 即可自动跟上，不必重新登录。（没有推送通道，只能靠这个 + 下次登录兜底。）
  // 节流 60s；失败静默 —— 绝不写 loadError，避免打断正在操作的用户。
  const hasUser = !!user;
  useEffect(() => {
    if (!hasUser) return;
    let last = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - last < 60_000) return;
      last = Date.now();
      if (!localStorage.getItem("token")) return;
      api.me()
        .then((res) => {
          try { localStorage.setItem("user", JSON.stringify(res)); } catch {}
          setUser(res);
          // 同标签页写 localStorage 不触发 storage 事件，必须手动通知身份档案重算品牌
          notifyIdentityChanged();
        })
        .catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [hasUser]);

  const location = useLocation();
  const navigate = useNavigate();

  // 设备分流：手机首次进入任意桌面路径时，直接带到移动版 /m。
  // 手动覆盖（移动版里的「切换到完整版」）优先于 UA，不会被反复跳回。
  //
  // ⚠️ 判定移动版必须用 isMobilePath()，不能写 pathname.startsWith("/m")：
  //    "/match"（智能匹配页）也以 /m 开头，会被误判成移动版而渲染成空白页。
  useEffect(() => {
    if (!user) return;
    if (isMobilePath(location.pathname)) return;
    if (isMobileDevice()) navigate("/m/tasks", { replace: true });
  }, [user, location.pathname, navigate]);

  // 退出登录：清掉本地凭证后整页跳 /login。
  //
  // 两个坑都不能踩：
  // ① 不能用 SPA 的 navigate("/login")：它与「清空用户态」是两条独立更新，存在竞态——
  //    路由可能先跳到 /login 而 user 仍非空，命中已登录路由块的 `*`（重定向回 /talents），
  //    等 user 置空后又命中匿名路由块的 `*`（→ /），最终被丢到营销落地页而非登录页。
  // ② 也不能在这里 setUser(null)：它会立刻触发一次重渲染，当前路径（如 /talents）
  //    落到匿名路由块的 `*` → `<Navigate to="/" />`，于是**先闪一帧营销落地页**，
  //    浏览器随后才执行整页跳转。整页跳转本身会重置整个应用状态，
  //    这里不需要（也不应该）再动 React 状态。
  const logout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    window.location.replace("/login");
  };

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh" }}>
        <Spin size="large" />
      </div>
    );
  }

  // 有 token 但首屏加载失败 → 错误提示 + 重试，不再无限转圈
  if (loadError && localStorage.getItem("token")) {
    return (
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", height: "100vh", gap: 16, padding: 24 }}>
        <Alert type="warning" showIcon message="加载失败" description={loadError} style={{ maxWidth: 440 }} />
        <Button type="primary" onClick={() => { setLoading(true); fetchUser(); }}>重试</Button>
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login onLogin={fetchUser} />} />
        <Route path="/" element={<Landing />} />
        {/* 帮助中心未登录也开放：登录页顶部「帮助中心」直达，潜在用户可先看 FAQ */}
        <Route
          path="/help"
          element={
            <div>
              <div style={{ maxWidth: 900, margin: "0 auto", padding: "16px 16px 0" }}>
                <Link to="/login">← 返回登录</Link>
              </div>
              <Help />
            </div>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  // —— 移动版：独立渲染，不套桌面 Layout，否则会多出左侧栏 ——
  // 注意 isMobilePath："/match" 不是移动版路由，见上面 useEffect 的说明。
  if (isMobilePath(location.pathname)) {
    // 落地页与兜底同样按权限走：无权限不要停在原地，也不要去 /m/tasks 形成死循环
    const home = mobileTabsFor(user)[0]?.path;
    const fallback = home ? <Navigate to={home} replace /> : <NoAccess />;
    return (
      <DictProvider>
        <ChangelogModal />
        <UsageTracker />
        <Routes>
          <Route path="/m" element={<MobileLayout user={user} onLogout={logout} />}>
            <Route index element={fallback} />
            <Route path="tasks" element={<MGuard user={user} perm="tasks"><MTasks /></MGuard>} />
            <Route path="pipeline" element={<MGuard user={user} perm="pipeline"><MPipeline /></MGuard>} />
            <Route path="talents" element={<MGuard user={user} perm="talents"><MTalents /></MGuard>} />
            <Route path="funnel" element={<MGuard user={user} perm="funnel"><MFunnel /></MGuard>} />
            <Route path="*" element={fallback} />
          </Route>
        </Routes>
      </DictProvider>
    );
  }

  return (
    <DictProvider>
    <ChangelogModal />
    <UsageTracker />
    <Layout user={user} onLogout={logout} theme={theme} onChangeTheme={onChangeTheme} onUserChange={setUser}>
      <Suspense fallback={pageFallback}>
        <Routes>
          {/* 首页 = 招聘漏斗（已并入概览速览）。无 funnel 权限者由 RequirePerm 自动落到 /talents */}
          <Route path="/" element={<Navigate to="/funnel" replace />} />
          <Route path="/talents" element={<RequirePerm user={user} perm="talents"><TalentList /></RequirePerm>} />
          <Route path="/talents/:id" element={<RequirePerm user={user} perm="talents"><TalentDetail /></RequirePerm>} />
          <Route path="/match" element={<RequirePerm user={user} perm="profiles"><Match /></RequirePerm>} />
          <Route path="/profiles" element={<RequirePerm user={user} perm="profiles"><Profiles /></RequirePerm>} />
          <Route path="/pipeline" element={<RequirePerm user={user} perm="pipeline"><Pipeline /></RequirePerm>} />
          <Route path="/interviews" element={<RequirePerm user={user} perm="interviews"><Interviews /></RequirePerm>} />
          {/* 审批中心 / 入职办理：权限跟随招聘看板 */}
          <Route path="/approvals" element={<RequirePerm user={user} perm="pipeline"><Approvals /></RequirePerm>} />
          <Route path="/onboarding" element={<RequirePerm user={user} perm="pipeline"><Onboarding /></RequirePerm>} />
          <Route path="/funnel" element={<RequirePerm user={user} perm="funnel"><Funnel /></RequirePerm>} />
          <Route path="/jobs" element={<RequirePerm user={user} perm="jobs"><Jobs /></RequirePerm>} />
          <Route path="/requisitions" element={<RequirePerm user={user} perm="jobs"><Requisitions /></RequirePerm>} />
          <Route path="/tasks" element={<RequirePerm user={user} perm="tasks"><Tasks /></RequirePerm>} />
          <Route path="/contracts" element={<RequirePerm user={user} perm="contracts"><Contracts /></RequirePerm>} />
          <Route path="/social" element={<RequirePerm user={user} perm="social"><Social /></RequirePerm>} />
          <Route path="/templates" element={<RequirePerm user={user} perm="templates"><TemplateLibrary /></RequirePerm>} />
          {user.role === "admin" && <Route path="/roles" element={<Roles />} />}
          {user.role === "admin" && <Route path="/users" element={<Users />} />}
          {/* 系统设置：收款码/数据字典等全局配置，仅管理员；权限走 admin 硬放行，不占菜单权限 key */}
          {user.role === "admin" && <Route path="/settings" element={<Settings />} />}
          {/* 日志管理：模块点击率统计，仅管理员；同上走 admin 硬放行 */}
          {user.role === "admin" && <Route path="/logs" element={<Logs />} />}
          {/* 帮助中心：所有登录用户可看，不做权限控制 */}
          <Route path="/help" element={<Help />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Layout>
    </DictProvider>
  );
}
