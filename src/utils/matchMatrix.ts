import { VERDICT_COLORS, PALETTE } from "../types";

/** 矩阵最多显示几列（1440 宽屏下每列约 200px，再多就读不清了） */
export const MATRIX_MAX_COLS = 6;

/** 单元格底色档位：达标 / 部分 / 未达标 / 纯文本 */
export type MatrixTone = "ok" | "warn" | "bad" | "neutral";

export interface MatrixCell {
  /** 主文本 */
  main: string;
  /** 副文本（小字，可省略） */
  sub?: string;
  tone: MatrixTone;
  /** 覆盖主文本颜色（匹配度行用结论色） */
  color?: string;
  /** 主文本是否大号字 */
  big?: boolean;
}

/** 一列 = 一位候选人 */
export interface MatrixCol {
  key: string;
  name: string;
  /** 公司 · 职位 */
  sub: string;
  score: number;
  verdict: string;
  skillHit: number;
  skillTotal: number;
  mustHit: string[];
  mustMiss: string[];
  niceHit: string[];
  edu: { ok: boolean | null; actual: string };
  years: { ok: boolean | null; actual: number | null; over?: boolean };
  city: { ok: boolean | null; actual: string };
  salary: string;
  reasons: string[];
  gaps: string[];
  risks: string[];
  questions: string[];
}

export interface MatrixRowDef {
  key: string;
  label: string;
  /** 有 sortValue 的行才可点标题排序 */
  sortValue?: (c: MatrixCol) => number;
  cell: (c: MatrixCol) => MatrixCell;
}

function toneOf(ok: boolean | null): MatrixTone {
  if (ok === true) return "ok";
  if (ok === false) return "bad";
  return "neutral";
}

/** 从「28-32K」「面议」这类自由文本里取一个可比较的数字；取不到返回 -1（排到最后） */
export function salaryValue(s: string): number {
  const m = /(\d+(?:\.\d+)?)/.exec(s || "");
  return m ? Number(m[1]) : -1;
}

/**
 * 矩阵的行定义：UI 渲染和长图导出**共用这一份**，否则两处各写一遍必然漂移。
 * 顺序刻意从「硬指标」到「软判断」——先看分数和硬性条件，再看 AI 的定性分析。
 */
export const MATRIX_ROWS: MatrixRowDef[] = [
  {
    key: "score",
    label: "匹配度",
    sortValue: (c) => c.score,
    cell: (c) => ({
      main: String(c.score),
      sub: c.verdict,
      tone: "neutral",
      color: VERDICT_COLORS[c.verdict] || PALETTE.blue,
      big: true,
    }),
  },
  {
    key: "must",
    label: "必备技能",
    sortValue: (c) => (c.skillTotal > 0 ? c.skillHit / c.skillTotal : -1),
    cell: (c) => {
      if (c.skillTotal === 0) return { main: "画像未设", tone: "neutral" };
      return {
        main: `${c.skillHit} / ${c.skillTotal}`,
        sub: c.mustMiss.length > 0 ? `缺 ${c.mustMiss.join("、")}` : c.mustHit.join("、"),
        tone: c.skillHit === c.skillTotal ? "ok" : c.skillHit === 0 ? "bad" : "warn",
      };
    },
  },
  {
    key: "nice",
    label: "加分技能",
    sortValue: (c) => c.niceHit.length,
    cell: (c) => ({
      main: c.niceHit.length > 0 ? `${c.niceHit.length} 项` : "无",
      sub: c.niceHit.length > 0 ? c.niceHit.join("、") : undefined,
      tone: c.niceHit.length > 0 ? "ok" : "neutral",
    }),
  },
  {
    key: "edu",
    label: "学历",
    cell: (c) => ({ main: c.edu.actual || "未填", tone: toneOf(c.edu.ok) }),
  },
  {
    key: "years",
    label: "经验",
    sortValue: (c) => c.years.actual ?? -1,
    cell: (c) => ({
      main: c.years.actual != null ? `${c.years.actual} 年` : "未填",
      // 资历偏高是「达标但不合适」，用 warn 而不是 ok，避免误导成加分项
      tone: c.years.ok === true && c.years.over ? "warn" : toneOf(c.years.ok),
      sub: c.years.over ? "资历偏高" : undefined,
    }),
  },
  {
    key: "city",
    label: "城市",
    cell: (c) => ({ main: c.city.actual || "未填", tone: toneOf(c.city.ok) }),
  },
  {
    key: "salary",
    label: "期望薪资",
    sortValue: (c) => salaryValue(c.salary),
    cell: (c) => ({ main: c.salary || "未填", tone: "neutral" }),
  },
  {
    key: "reasons",
    label: "核心优势",
    cell: (c) => ({ main: c.reasons.slice(0, 2).join("；") || "AI 未给出", tone: "neutral" }),
  },
  {
    key: "gaps",
    label: "主要短板",
    cell: (c) => ({
      main: [...c.gaps, ...c.risks].slice(0, 2).join("；") || "无明显短板",
      tone: "neutral",
    }),
  },
  {
    key: "questions",
    label: "待确认",
    cell: (c) => ({ main: c.questions.slice(0, 2).join("；") || "无", tone: "neutral" }),
  },
];
