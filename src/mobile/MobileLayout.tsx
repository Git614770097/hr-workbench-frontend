import { Suspense, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Drawer, Button, Typography, message, Spin } from "antd";
import { EllipsisOutlined, DesktopOutlined, LogoutOutlined } from "@ant-design/icons";
import type { User } from "../types";
import { setDeviceOverride } from "../utils/device";
import { profileOf, navLabelFor, termFor } from "../identityProfiles";
import { mobileTabsFor } from "./tabs";
import { firstAccessiblePath } from "../utils/routeAccess";

interface Props {
  user: User;
  onLogout: () => void;
}

export default function MobileLayout({ user, onLogout }: Props) {
  const nav = useNavigate();
  const loc = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  // Tab 可见性 = 权限（与桌面菜单同一口径）；显示名走 navLabels（与桌面同一真源，
  // 例如猎头版「人才库」→「候选人库」），不再各自维护一份文案映射。
  const profile = profileOf(user);
  const TABS = mobileTabsFor(user).map((t) => ({
    ...t,
    label: navLabelFor(profile, t.navPath, t.label),
  }));

  const active = TABS.find((t) => loc.pathname.startsWith(t.path));
  const title = active?.label || "移动版";

  // 整页跳转而不是 SPA 导航：让 App 重新挂载并按新的设备偏好重新分流，
  // 否则 isMobileDevice() 的结果不会变，会被立刻跳回 /m。
  const switchToDesktop = () => {
    setDeviceOverride("desktop");
    // 不要写死 /talents：无 talents 权限的账号会被权限守卫反复弹回，等于切不过去。
    // 落到该用户第一个可访问的桌面菜单。
    window.location.href = firstAccessiblePath(user) || "/funnel";
  };

  return (
    <div className="m-root">
      <div className="m-topbar">
        <span className="m-title">{title}</span>
        <button className="m-topbar-btn" onClick={() => setMoreOpen(true)} aria-label="更多">
          <EllipsisOutlined />
        </button>
      </div>

      {/* Suspense 放在这里而不是整页：切 Tab 时顶栏和底部 TabBar 不跟着消失 */}
      <div className="m-body">
        <Suspense
          fallback={
            <div style={{ display: "flex", justifyContent: "center", padding: "40px 0" }}>
              <Spin />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </div>

      <div className="m-tabbar">
        {TABS.map((t) => (
          <button
            key={t.path}
            className={`m-tab${active?.path === t.path ? " active" : ""}`}
            onClick={() => nav(t.path)}
          >
            <span className="m-tab-icon">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      <Drawer
        rootClassName="m-drawer"
        placement="bottom"
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        height="auto"
        styles={{ body: { paddingBottom: 20 } }}
      >
        <div className="m-sheet-title">{user.name}</div>
        <div className="m-sheet-sub">
          {user.role === "admin" ? "管理员" : ""}
          {user.phone ? ` · ${user.phone.replace(/^(\d{3})\d{4}(\d{4})$/, "$1****$2")}` : ""}
        </div>
        <div className="m-actions">
          <Button block icon={<DesktopOutlined />} onClick={switchToDesktop}>
            切换到完整版（电脑版）
          </Button>
          <Button
            block
            danger
            icon={<LogoutOutlined />}
            onClick={async () => {
              try {
                await onLogout();
              } catch {
                message.error("退出失败，请重试");
              }
            }}
          >
            退出登录
          </Button>
        </div>
        <div style={{ marginTop: 14, textAlign: "center" }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {termFor(profile, "岗位、合同、模板库等模块仍用完整版操作")}
          </Typography.Text>
        </div>
      </Drawer>
    </div>
  );
}
