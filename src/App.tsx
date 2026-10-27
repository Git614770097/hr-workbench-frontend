import { Routes, Route, Navigate, Link, useLocation, useNavigate } from "react-router-dom";
import { useState, useEffect, useCallback, Suspense } from "react";
import Spin from "antd/es/spin";
import Button from "antd/es/button";
import Alert from "antd/es/alert";
import message from "antd/es/message";
import type { User } from "./types";
import type { ThemeState } from "./theme";
import { api, hasSession } from "./api";
import { DictProvider } from "./dict";
// 落地页保持同步加载（未登录时的首屏，避免白屏闪烁）；
// 登录页是懒加载的：antd Form / Radio 与 rc-field-form 整棵树只有它用，
// 拆出去后落地页首屏不再背这部分。落地页空闲时会把 /login 预取回来，点「登录」仍是秒开。
import Landing from "./pages/Landing";
import Layout from "./components/Layout";
import FeishuBindConfirmModal from "./components/FeishuBindConfirmModal";
// 移动版（/m）：独立布局 + 页面，与桌面侧栏体系完全分开
import MobileLayout from "./mobile/MobileLayout";
import { mobileTabsFor } from "./mobile/tabs";
import { isMobileDevice } from "./utils/device";
import { firstAccessiblePath } from "./utils/routeAccess";
import { notifyIdentityChanged } from "./useIdentity";

/**
 * 是否属于移动版路由。
 * 必须是「/m」或「/m/…」，不能用 startsWith("/m")——
 * 那样 "/match"（人才AI匹配页）也会被当成移动版，渲染空白页（无路由匹配）。
 */
function isMobilePath(pathname: string): boolean {
  return pathname === "/m" || pathname.startsWith("/m/");
}

import ChangelogModal from "./components/ChangelogModal";
// 使用埋点：桌面与移动两棵树各挂一份，不渲染任何 UI
import UsageTracker from "./components/UsageTracker";

// 页面组件统一走 routePages（非挂起式懒加载）：react-router v7 的 navigate 包在
// startTransition 里，用 React.lazy 时 chunk 未就绪会 suspend → React 继续渲染旧页面
// （URL 已变、页面不动）。lazyPage 改为挂载即显示加载占位，旧页面立刻被替换。
// 预取（菜单 hover / 空闲批量）与渲染共用同一 loader，见 src/routePages.tsx。
import {
  Login,
  TalentList,
  TalentDetail,
  Match,
  Profiles,
  Pipeline,
  Interviews,
  Approvals,
  Onboarding,
  Funnel,
  Jobs,
  Requisitions,
  Tasks,
  Contracts,
  Social,
  Users,
  Roles,
  Settings,
  Logs,
  Team,
  MTasks,
  MInterviews,
  MPipeline,
  MTalents,
  MFunnel,
  TemplateLibrary,
  AiAssistant,
  Help,
} from "./routePages";
import { prefetchPage } from "./routePages";

// 页面切换时的加载占位（Suspense 仍保留给 Layout 内的弹窗懒加载）
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
  // 飞书 OAuth 回调结果：/?feishu=bound 或 /?feishu=error&reason=... 或 /?feishu=confirm&ck=...
  // 必须在首次渲染时就取走——已登录时 "/" 会立即被 Navigate 替换成 /funnel，
  // 等 effect 跑完查询参数已从地址栏消失。回跳是整页加载，此时读一次即可。
  const [feishuResult] = useState<{ status: string; reason: string | null; ck: string | null } | null>(() => {
    if (typeof window === "undefined") return null;
    const p = new URLSearchParams(window.location.search);
    const s = p.get("feishu");
    return s ? { status: s, reason: p.get("reason"), ck: p.get("ck") } : null;
  });
  // 绑定确认页（授权回来后确认飞书账号是本人）
  const [feishuConfirm, setFeishuConfirm] = useState<string | null>(null);
  // 有会话但首屏加载失败（典型：D1 冷启动导致 /api/auth/me 查询挂起超时），
  // 不进登录页、给「重试」入口，避免一直卡在 loading 出不来。
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchUser = useCallback(async () => {
    // 只查「有没有会话提示」，不读凭据——凭据在 httpOnly cookie 里。
    // 匿名访客（落地页）因此一次鉴权请求都不发。
    if (!hasSession()) {
      setLoading(false);
      return;
    }
    setLoadError(null);
    // 首屏关键路径。实测服务端 /auth/me 已优化到 ~1s，真正的敌人是网络/TLS 层抖动
    // （同机实测 TLS 握手 0.5~10.8s 不等）。策略：**快速失败 + 渐进超时 + 降级进入**，
    // 让一次抖动不再把用户挡在「加载失败」页外面。
    // 超时 8s/12s/15s：抖一下通常第二次就过，持续抖动也只等到 35s 封顶。
    const attempts = [8000, 12000, 15000];
    try {
      for (let i = 0; i < attempts.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, i * 1000));
        try {
          const res = await api.me(attempts[i]);
          // 先写缓存再 setUser：Layout 首次挂载时会同步读 localStorage，
          // 顺序反了会读到旧值（品牌文案慢一拍）。
          try { localStorage.setItem("user", JSON.stringify(res)); } catch {}
          setUser(res);
          return;
        } catch {
          // request 内遇到 401 已经清会话提示并跳登录；其余（含超时）继续重试。
          if (!hasSession()) return;
        }
      }
      // 全部失败：降级用上次的用户信息进入，别把人挡在门外。
      // 后续真实接口若真不可用，会各自报错或 401 回登录页——不会因为这一次抖动就完全进不来。
      try {
        const cached = localStorage.getItem("user");
        if (cached) {
          setUser(JSON.parse(cached));
          message.warning("网络不稳定，已用缓存信息进入，数据可能不是最新");
          return;
        }
      } catch {}
      setLoadError("加载超时或网络异常，系统可能正在启动，请点击重试。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  // 飞书回调落地面提示（成功/失败各一条，随后清理 URL 防刷新重复弹）。
  // 未登录时静默忽略——那说明授权中途会话过期，用户回登录页重新走即可。
  const FEISHU_ERROR_TEXT: Record<string, string> = {
    access_denied: "你取消了飞书授权",
    missing_params: "飞书回调参数缺失",
    bad_state: "授权状态已失效，请重新发起绑定",
    no_app: "管理员尚未配置飞书应用",
    exchange: "与飞书交换凭证失败",
  };
  useEffect(() => {
    if (!feishuResult || !user) return;
    if (feishuResult.status === "confirm" && feishuResult.ck) {
      setFeishuConfirm(feishuResult.ck); // 弹绑定确认页，不直接弹 message
    } else if (feishuResult.status === "bound") {
      message.success("飞书绑定成功，之后的提醒会推送到你的飞书");
      fetchUser();
    } else {
      const reason = feishuResult.reason || "";
      const text = FEISHU_ERROR_TEXT[reason] || `绑定失败（${reason || "未知原因"}）`;
      message.error(`飞书${text}`);
    }
    const u = new URL(window.location.href);
    u.searchParams.delete("feishu");
    u.searchParams.delete("reason");
    u.searchParams.delete("ck");
    window.history.replaceState({}, "", u.pathname + u.search);
  }, [feishuResult, user, fetchUser]);

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
      if (!hasSession()) return;
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

  // 未登录时：空闲预取登录页 chunk。
  // 登录页是懒加载的（它独占 antd Form/Input/Radio，拆出去后落地页首屏少背 40KB+ gzip），
  // 代价是点「登录」时可能要多等一次下载——这里在空闲时段提前拉回来，把等待藏掉。
  // 只预取 /login：登录后的落地页是 /funnel，它会拉 echarts（186KB gzip），
  // 对还没登录的访客来说太重，等登录后由 Layout 的空闲批量预取接手。
  useEffect(() => {
    if (hasUser) return;
    const ric = (window as any).requestIdleCallback as ((cb: () => void, opts?: { timeout: number }) => number) | undefined;
    const handle = ric
      ? ric(() => prefetchPage("/login"), { timeout: 4000 })
      : (setTimeout(() => prefetchPage("/login"), 1500) as unknown as number);
    return () => {
      if (ric) (window as any).cancelIdleCallback?.(handle);
      else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    };
  }, [hasUser]);

  const location = useLocation();
  const navigate = useNavigate();

  // 设备分流：手机首次进入任意桌面路径时，直接带到移动版 /m。
  // 手动覆盖（移动版里的「切换到完整版」）优先于 UA，不会被反复跳回。
  //
  // ⚠️ 判定移动版必须用 isMobilePath()，不能写 pathname.startsWith("/m")：
  //    "/match"（人才AI匹配页）也以 /m 开头，会被误判成移动版而渲染成空白页。
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
    // 服务端登出（删 KV session + 删 cookie）是 fire-and-forget，见 api.logout 的注释；
    // 本地只清「用户信息缓存」，不涉及任何凭据。
    api.logout();
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

  // 有会话提示但首屏加载失败 → 错误提示 + 重试，不再无限转圈
  if (loadError && hasSession()) {
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
            {/* 面试：手机上最高频的场景（今天几场、谁来、几点），只读 + 轻操作 */}
            <Route path="interviews" element={<MGuard user={user} perm="interviews"><MInterviews /></MGuard>} />
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
          {/* 登录成功后直达待办日历（登录态下再访问 /login 也回这里）；无 tasks 权限者由 RequirePerm 兜底 */}
          <Route path="/login" element={<Navigate to="/tasks" replace />} />
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
          <Route path="/ai-assistant" element={<RequirePerm user={user} perm="tools"><AiAssistant /></RequirePerm>} />
          {user.role === "admin" && <Route path="/roles" element={<Roles />} />}
          {user.role === "admin" && <Route path="/users" element={<Users />} />}
          {(user.role === "admin" || user.role === "manager") && <Route path="/team" element={<Team />} />}
          {/* 系统设置：收款码/数据字典等全局配置，仅管理员；权限走 admin 硬放行，不占菜单权限 key */}
          {user.role === "admin" && <Route path="/settings" element={<Settings />} />}
          {/* 日志管理：上报明细 + 操作审计双列表，仅管理员；同上走 admin 硬放行 */}
          {user.role === "admin" && <Route path="/logs" element={<Logs />} />}
          {/* 旧地址 /audit 重定向到日志管理的操作审计 Tab，防止收藏/旧链接 404 */}
          {user.role === "admin" && <Route path="/audit" element={<Navigate to="/logs?tab=audit" replace />} />}
          {/* 帮助中心：所有登录用户可看，不做权限控制 */}
          <Route path="/help" element={<Help />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Layout>
    <FeishuBindConfirmModal
      ck={feishuConfirm}
      onDone={(bound) => {
        setFeishuConfirm(null);
        if (bound) { message.success("飞书绑定成功，之后的提醒会推送到你的飞书"); fetchUser(); }
      }}
    />
    </DictProvider>
  );
}
