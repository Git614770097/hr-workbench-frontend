import { useCallback, useState } from "react";

/**
 * 可关闭提示条：关闭状态持久化到 localStorage（键名 `wb.dismiss.<key>`），
 * 用户关掉后刷新页面仍保持隐藏，直到手动「恢复显示」。
 */
export function useDismissible(key: string) {
  const storageKey = `wb.dismiss.${key}`;
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      /* localStorage 不可用时仅当前会话生效 */
    }
  }, [storageKey]);

  const restore = useCallback(() => {
    setDismissed(false);
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }, [storageKey]);

  return { dismissed, dismiss, restore };
}
