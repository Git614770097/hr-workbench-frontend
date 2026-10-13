import { api } from "./api";

/**
 * 漏斗配色预设（单一来源）。
 * 新增/调整色板 → 只改这里，FunnelChart 不再散落硬编码。
 *
 * 设计约束（沿用原「柔和多色」的验证过的规范）：
 * - from=400 档浅色，to=600 档深色 → 段内纵向渐变上浅下深，有立体感
 * - text=同色系 800 档深字（深层改用浅字）→ 压在同色系上有对比
 * - 暗色不另写一套：由 `paletteLevels(id, true)` 统一推导（见文件末），
 *   避免每加一套色板都要维护两份颜色
 */

export interface FunnelPaletteLevel {
  from: string;
  to: string;
  text: string;
}

export interface FunnelPalette {
  id: string;
  name: string;
  desc: string;
  levels: FunnelPaletteLevel[];
}

export const FUNNEL_PALETTES: FunnelPalette[] = [
  {
    id: "soft",
    name: "柔和多色",
    desc: "每阶段一个色相，层次最清楚",
    levels: [
      { from: "#60a5fa", to: "#2563eb", text: "#1e40af" }, // 蓝
      { from: "#22d3ee", to: "#0891b2", text: "#155e75" }, // 青
      { from: "#34d399", to: "#059669", text: "#065f46" }, // 绿
      { from: "#fbbf24", to: "#d97706", text: "#92400e" }, // 琥珀
      { from: "#a78bfa", to: "#7c3aed", text: "#5b21b6" }, // 紫
    ],
  },
  {
    id: "ocean",
    name: "商务蓝",
    desc: "同色系由浅入深，适合正式汇报",
    levels: [
      { from: "#e0f2fe", to: "#7dd3fc", text: "#075985" },
      { from: "#bae6fd", to: "#38bdf8", text: "#075985" },
      { from: "#7dd3fc", to: "#0ea5e9", text: "#0c4a6e" },
      { from: "#38bdf8", to: "#0284c7", text: "#e0f2fe" },
      { from: "#0ea5e9", to: "#0369a1", text: "#e0f2fe" },
    ],
  },
  {
    id: "teal",
    name: "青碧",
    desc: "青绿渐变，清爽不抢眼",
    levels: [
      { from: "#ccfbf1", to: "#5eead4", text: "#115e59" },
      { from: "#99f6e4", to: "#2dd4bf", text: "#115e59" },
      { from: "#5eead4", to: "#14b8a6", text: "#134e4a" },
      { from: "#2dd4bf", to: "#0d9488", text: "#ccfbf1" },
      { from: "#14b8a6", to: "#0f766e", text: "#ccfbf1" },
    ],
  },
  {
    id: "sunset",
    name: "暖阳",
    desc: "琥珀到玫红，强调转化热度",
    levels: [
      { from: "#fef3c7", to: "#fcd34d", text: "#92400e" },
      { from: "#fde68a", to: "#fbbf24", text: "#92400e" },
      { from: "#fcd34d", to: "#f59e0b", text: "#78350f" },
      { from: "#fbbf24", to: "#ea580c", text: "#fff7ed" },
      { from: "#fb923c", to: "#dc2626", text: "#fff7ed" },
    ],
  },
  {
    id: "rainbow",
    name: "彩虹",
    desc: "高饱和分色，内部分析用",
    levels: [
      { from: "#818cf8", to: "#4f46e5", text: "#eef2ff" }, // 靛蓝
      { from: "#38bdf8", to: "#0284c7", text: "#f0f9ff" }, // 天蓝
      { from: "#4ade80", to: "#16a34a", text: "#f0fdf4" }, // 绿
      { from: "#facc15", to: "#ca8a04", text: "#fefce8" }, // 黄
      { from: "#fb7185", to: "#e11d48", text: "#fff1f2" }, // 玫红
    ],
  },
];

/** 存 user_settings 的 key */
export const FUNNEL_PALETTE_KEY = "funnel_palette";
export const DEFAULT_FUNNEL_PALETTE = "soft";

const IDS = FUNNEL_PALETTES.map((p) => p.id);

function sanitizeId(id: unknown): string {
  return typeof id === "string" && IDS.includes(id) ? id : DEFAULT_FUNNEL_PALETTE;
}

export function paletteById(id: string): FunnelPalette {
  const safe = sanitizeId(id);
  return FUNNEL_PALETTES.find((p) => p.id === safe) ?? FUNNEL_PALETTES[0];
}

// ---- 暗色推导：不维护第二套色板，统一由亮色压深 ----
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const m = (x: number, y: number) => Math.round(x + (y - x) * t);
  const to2 = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to2(m(r1, r2))}${to2(m(g1, g2))}${to2(m(b1, b2))}`;
}

/**
 * 取某套色板的层级配色。
 * 层级多于色板阶数时复用最后一阶（与原实现一致）。
 * 暗色：from 取亮色的 to（深端），to 再压深 34%，文字统一白色。
 */
export function paletteLevels(id: string, dark: boolean): FunnelPaletteLevel[] {
  const p = paletteById(id);
  if (!dark) return p.levels;
  return p.levels.map((l) => ({
    from: l.to,
    to: mix(l.to, "#000000", 0.34),
    text: "#ffffff",
  }));
}

/** 读取用户保存的漏斗配色；失败回退默认（不阻塞页面） */
export async function loadFunnelPalette(): Promise<string> {
  try {
    const r = await api.getMySetting(FUNNEL_PALETTE_KEY);
    if (r.value) return sanitizeId(r.value);
  } catch {
    // 未登录/网络异常 → 用默认
  }
  return DEFAULT_FUNNEL_PALETTE;
}

/** 保存漏斗配色（失败静默：不打断用户操作） */
export async function saveFunnelPalette(id: string): Promise<boolean> {
  try {
    await api.setMySetting(FUNNEL_PALETTE_KEY, sanitizeId(id));
    return true;
  } catch {
    return false;
  }
}
