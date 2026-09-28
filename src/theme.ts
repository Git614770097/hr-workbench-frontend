// 全局换肤配置：主题色（4 选 1）× 明暗模式（亮/暗），两个维度正交，可任意组合。
// 切换后写入 localStorage，下次打开沿用；通过 CSS 变量 + antd ConfigProvider 联动。
//
// 说明：旧版把「暗黑」当成第五个主题色混在颜色列表里，导致暗色下主题色只能固定蓝、
// 且换肤不持久化（saveTheme 从未被调用）。本版拆成 color + mode 两个独立维度。

export type ThemeColor = "blue" | "green" | "orange" | "purple";
export type ThemeMode = "light" | "dark";

export interface ThemeColorDef {
  key: ThemeColor;
  label: string;
  // antd 主色
  colorPrimary: string;
  // 面板色块展示用（渐变色小圆点）
  swatch: string;
}

export interface ThemeState {
  color: ThemeColor;
  mode: ThemeMode;
}

export const THEME_COLORS: ThemeColorDef[] = [
  {
    key: "blue",
    label: "经典蓝",
    colorPrimary: "#3b82f6",
    swatch: "linear-gradient(135deg, #3b82f6, #8b5cf6)",
  },
  {
    key: "green",
    label: "翡翠绿",
    colorPrimary: "#10b981",
    swatch: "linear-gradient(135deg, #10b981, #3b82f6)",
  },
  {
    key: "orange",
    label: "珊瑚橙",
    colorPrimary: "#f97316",
    swatch: "linear-gradient(135deg, #f97316, #f43f5e)",
  },
  {
    key: "purple",
    label: "深紫罗兰",
    colorPrimary: "#8b5cf6",
    swatch: "linear-gradient(135deg, #8b5cf6, #ec4899)",
  },
];

const COLOR_KEY = "hr-theme-color";
const MODE_KEY = "hr-theme-mode";
// 旧版只用一个 key 存 "blue|green|orange|purple|dark"，读取时迁移、写入后清除
const LEGACY_KEY = "hr-theme";

export function getColorDef(color: ThemeColor): ThemeColorDef {
  return THEME_COLORS.find((c) => c.key === color) ?? THEME_COLORS[0];
}

export function getThemeState(): ThemeState {
  let color: ThemeColor = "blue";
  let mode: ThemeMode = "light";
  try {
    // 旧 key 迁移：dark → 暗色模式；颜色值 → 主题色
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy === "dark") mode = "dark";
    else if (THEME_COLORS.some((c) => c.key === legacy)) color = legacy as ThemeColor;

    const c = localStorage.getItem(COLOR_KEY);
    if (c && THEME_COLORS.some((x) => x.key === c)) color = c as ThemeColor;

    const m = localStorage.getItem(MODE_KEY);
    if (m === "dark" || m === "light") mode = m;
  } catch {}
  return { color, mode };
}

export function saveThemeState(s: ThemeState) {
  try {
    localStorage.setItem(COLOR_KEY, s.color);
    localStorage.setItem(MODE_KEY, s.mode);
    // 清旧 key，避免下次读取时又被旧值覆盖
    localStorage.removeItem(LEGACY_KEY);
  } catch {}
}

// 将主题写到 <html> 上，供 global.css 通过属性选择器 / CSS 变量读取。
export function applyTheme(s: ThemeState) {
  const def = getColorDef(s.color);
  const root = document.documentElement;
  root.setAttribute("data-theme-mode", s.mode);
  root.setAttribute("data-theme-color", s.color);
  root.style.setProperty("--color-primary", def.colorPrimary);
  root.style.setProperty("--theme-dark", s.mode === "dark" ? "1" : "0");
}
