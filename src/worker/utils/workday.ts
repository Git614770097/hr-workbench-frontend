// 工作日顺延工具：把落在周六/日的日期顺延到下一个周一。
// 仅按「周一~周五为工作日」判断，节假日表（方案 C）后续可在此扩展。

export interface WorkdayShift {
  /** 顺延后的日期（YYYY-MM-DD）；入参非法/为空则原样返回 */
  due: string | null;
  /** 原始日期；若发生顺延则与 due 不同，否则等于 due */
  original: string | null;
  /** 是否因落在周末而调整 */
  shifted: boolean;
}

function parseYmd(ymd: string): Date | null {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

function fmt(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/**
 * 把日期顺延到工作日。
 * - 入参为空/非法 → 原样返回，shifted=false
 * - 周六 → 顺延 +2 天（周一）；周日 → 顺延 +1 天（周一）
 * - 工作日 → 不变
 */
export function shiftToWorkday(ymd: string | null | undefined): WorkdayShift {
  if (!ymd) return { due: null, original: null, shifted: false };
  const d = parseYmd(ymd);
  if (!d) return { due: ymd, original: ymd, shifted: false };
  const day = d.getUTCDay(); // 0=周日 6=周六
  if (day === 0 || day === 6) {
    d.setUTCDate(d.getUTCDate() + (day === 6 ? 2 : 1));
    return { due: fmt(d), original: ymd, shifted: true };
  }
  return { due: ymd, original: ymd, shifted: false };
}
