/**
 * 当前身份档案（品牌配置）的读取入口。
 *
 * 数据源是 localStorage 里的 `user`（登录时和 /auth/me 后都会写入），
 * 与 api.ts 的 token 同一套存储约定。用 storage 事件 + 自定义事件做同步，
 * 保证「管理员改了某人身份」或「换账号登录」后界面立刻跟上。
 */
import { useEffect, useState } from "react";
import type { User } from "./types";
import { profileOf, type IdentityProfile } from "./identityProfiles";

/** 读取当前登录用户（与 api.ts 保持同一 key） */
function readUser(): User | null {
  try {
    const raw = localStorage.getItem("user");
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function useIdentityProfile(): IdentityProfile {
  const [profile, setProfile] = useState<IdentityProfile>(() => profileOf(readUser()));

  useEffect(() => {
    const sync = () => setProfile(profileOf(readUser()));
    sync();
    // storage：其它标签页改了 user；身份变更由 App 派发自定义事件
    window.addEventListener("storage", sync);
    window.addEventListener("wb:identity-changed", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("wb:identity-changed", sync);
    };
  }, []);

  return profile;
}

/** 代码里改了 user（如切换身份）后通知界面刷新品牌文案 */
export function notifyIdentityChanged() {
  window.dispatchEvent(new Event("wb:identity-changed"));
}

/**
 * 当前登录用户（与 useIdentityProfile 同源：localStorage.user + storage/身份变更事件）。
 * 供「不与 Route 同层的独立页面/组件」按权限做就地判断使用
 * （例如帮助中心按权限隐藏无权访问模块的 FAQ）。
 */
export function useCurrentUser(): User | null {
  const [user, setUser] = useState<User | null>(() => readUser());

  useEffect(() => {
    const sync = () => setUser(readUser());
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener("wb:identity-changed", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("wb:identity-changed", sync);
    };
  }, []);

  return user;
}
