// 中国法定节假日与调休安排（用于日历标记）
//
// 数据来源：国务院办公厅《关于 2026 年部分节假日安排的通知》（2025-11-04 发布）。
// 中国的放假特点是「调休」——法定假期前后常有周末需要补班，只按周六周日判断会标错，
// 所以这里同时记录「放假区间」和「调休上班日」，两者都是硬数据，不能靠推算。
//
// 维护方式：每年国务院公布次年安排后，在 HOLIDAY_YEARS 里追加一年的数据即可。
// 未内置的年份会自动降级为「按周六周日判断」，并在页面给出提示，不会标错成节假日。

export type DayType = "holiday" | "makeup" | "weekend" | "workday";

export interface DayInfo {
  type: DayType;
  /** 是否休息（法定节假日与周末为 true，调休补班为 false） */
  rest: boolean;
  /** 节日名称，仅 type = holiday 时有值 */
  name?: string;
  /** 该年是否有内置数据（false 表示退化为按周末判断） */
  known: boolean;
}

interface HolidayRange {
  name: string;
  start: string; // YYYY-MM-DD（含）
  end: string;   // YYYY-MM-DD（含）
}

interface HolidayYear {
  year: number;
  holidays: HolidayRange[];
  /** 调休上班日：虽是周末但要上班 */
  workdays: string[];
}

const HOLIDAY_YEARS: HolidayYear[] = [
  {
    year: 2026,
    holidays: [
      { name: "元旦", start: "2026-01-01", end: "2026-01-03" },
      { name: "春节", start: "2026-02-15", end: "2026-02-23" },
      { name: "清明", start: "2026-04-04", end: "2026-04-06" },
      { name: "劳动节", start: "2026-05-01", end: "2026-05-05" },
      { name: "端午", start: "2026-06-19", end: "2026-06-21" },
      { name: "中秋", start: "2026-09-25", end: "2026-09-27" },
      { name: "国庆", start: "2026-10-01", end: "2026-10-07" },
    ],
    workdays: [
      "2026-01-04", // 元旦调休
      "2026-02-14", "2026-02-28", // 春节调休
      "2026-05-09", // 劳动节调休
      "2026-09-20", // 国庆调休
      "2026-10-10", // 国庆调休
    ],
  },
];

// 展开成两张查找表，避免每次判断都遍历区间
const HOLIDAY_MAP = new Map<string, string>();
const MAKEUP_SET = new Set<string>();
const KNOWN_YEARS = new Set<number>();

function eachDay(start: string, end: string, fn: (ymd: string) => void): void {
  const s = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10));
  const e = Date.UTC(+end.slice(0, 4), +end.slice(5, 7) - 1, +end.slice(8, 10));
  for (let t = s; t <= e; t += 86400000) {
    fn(new Date(t).toISOString().slice(0, 10));
  }
}

for (const y of HOLIDAY_YEARS) {
  KNOWN_YEARS.add(y.year);
  for (const h of y.holidays) {
    eachDay(h.start, h.end, (d) => {
      // 区间重叠时保留先声明的节日名（国务院安排本身不重叠，这里只是兜底）
      if (!HOLIDAY_MAP.has(d)) HOLIDAY_MAP.set(d, h.name);
    });
  }
  for (const w of y.workdays) MAKEUP_SET.add(w);
}

/** 判断某一天是节假日 / 调休补班 / 周末 / 工作日 */
export function dayInfo(ymd: string): DayInfo {
  const year = +ymd.slice(0, 4);
  const known = KNOWN_YEARS.has(year);

  const holidayName = HOLIDAY_MAP.get(ymd);
  if (holidayName) return { type: "holiday", rest: true, name: holidayName, known };

  if (MAKEUP_SET.has(ymd)) return { type: "makeup", rest: false, known };

  // ymd 按 UTC 解析，getUTCDay 即该日期在日历上的真实星期
  const wd = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  if (wd === 0 || wd === 6) return { type: "weekend", rest: true, known };

  return { type: "workday", rest: false, known };
}

/** 日历格子上显示的小标记文案（工作日不显示，保持格子干净） */
export const DAY_TYPE_LABEL: Record<DayType, string> = {
  holiday: "休",
  makeup: "班",
  weekend: "休",
  workday: "",
};

/** 该年是否内置了节假日安排（未内置时页面会提示数据缺失） */
export function hasHolidayData(year: number): boolean {
  return KNOWN_YEARS.has(year);
}

/** 内置数据覆盖的年份（用于提示文案） */
export function knownYears(): number[] {
  return [...KNOWN_YEARS].sort((a, b) => a - b);
}
