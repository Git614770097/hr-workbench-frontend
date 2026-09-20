// 全局换肤配置：预设主题色 + 明暗模式，通过 CSS 变量 + antd ConfigProvider 联动。
// 切换后写入 localStorage，下次打开沿用。

export type ThemeKey = "blue" | "green" | "orange" | "purple" | "dark";

export interface ThemeDef {
  key: ThemeKey;
  label: string;
  // antd 主色
  colorPrimary: string;
  // 深色模式标记（影响自定义布局 + antd algorithm）
  dark: boolean;
  // 主题色块展示用（渐变色小圆点）
  swatch: string;
}

export const THEMES: ThemeDef[] = [
  {
    key: "blue",
    label: "经典蓝",
    colorPrimary: "#3b82f6",
    dark: false,
    swatch: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
  },
  {
    key: "green",
    label: "翡翠绿",
    colorPrimary: "#10b981",
    dark: false,
    swatch: "linear-gradient(135deg, #10b981, #3b82f6)",
  },
  {
    key: "orange",
    label: "珊瑚橙",
    colorPrimary: "#f97316",
    dark: false,
    swatch: "linear-gradient(135deg, #f97316, #f43f5e)",
  },
  {
    key: "purple",
    label: "深紫罗兰",
    colorPrimary: "#8b5cf6",
    dark: false,
    swatch: "linear-gradient(135deg, #8b5cf6, #ec4899)",
  },
  {
    key: "dark",
    label: "暗黑模式",
    colorPrimary: "#3b82f6",
    dark: true,
    swatch: "linear-gradient(135deg, #1f2937, #111827)",
  },
];

const STORAGE_KEY = "hr-theme";

export function getThemeKey(): ThemeKey {
  try {
    const v = localStorage.getItem(STORAGE_KEY) as ThemeKey | null;
    if (v && THEMES.some((t) => t.key === v)) return v;
  } catch {}
  return "blue";
}

export function getTheme(key: ThemeKey = getThemeKey()): ThemeDef {
  return THEMES.find((t) => t.key === key) ?? THEMES[0];
}

export function saveTheme(key: ThemeKey) {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {}
}

// 将主题写到 <html> 上，供 global.css 通过 CSS 变量读取。
export function applyTheme(key: ThemeKey) {
  const theme = getTheme(key);
  const root = document.documentElement;
  root.setAttribute("data-theme", key);
  root.style.setProperty("--color-primary", theme.colorPrimary);
  root.style.setProperty("--theme-dark", theme.dark ? "1" : "0");
}
