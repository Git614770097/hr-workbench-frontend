/**
 * 设备判定：决定展示移动版（/m）还是完整版。
 *
 * 手动覆盖优先于 UA —— 用户在移动版里点「切换到完整版」后，
 * 即使 UA 是手机也不再自动跳回 /m，否则会被锁死。
 */
const OVERRIDE_KEY = "wb.device.override";

export type DeviceOverride = "mobile" | "desktop" | null;

export function getDeviceOverride(): DeviceOverride {
  try {
    const v = localStorage.getItem(OVERRIDE_KEY);
    return v === "mobile" || v === "desktop" ? v : null;
  } catch {
    return null;
  }
}

export function setDeviceOverride(v: DeviceOverride): void {
  try {
    if (v) localStorage.setItem(OVERRIDE_KEY, v);
    else localStorage.removeItem(OVERRIDE_KEY);
  } catch {
    // 隐私模式下 localStorage 不可写，忽略即可（退化成纯 UA 判定）
  }
}

/**
 * 物理设备判定（忽略手动覆盖）：UA 或触控点识别为手机/平板即 true。
 * 「切换到手机版」的入口只在该函数为真时出现 —— 桌面用户不需要这个入口，
 * 而手机用户即使手动切到完整版，也要能切回去。
 */
export function isTouchDevice(): boolean {
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPod|Windows Phone|webOS|BlackBerry|Mobile/i.test(ua)) return true;
  // iPadOS 13+ 的 Safari / Chrome 把 UA 伪装成 Macintosh，只能靠多点触控识别
  if (/Macintosh/i.test(ua) && (navigator.maxTouchPoints || 0) > 1) return true;
  return false;
}

/** 是否按移动版展示（手动覆盖优先于物理设备） */
export function isMobileDevice(): boolean {
  const override = getDeviceOverride();
  if (override) return override === "mobile";
  return isTouchDevice();
}
