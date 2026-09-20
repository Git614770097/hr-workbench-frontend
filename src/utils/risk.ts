import type { RiskType } from "../types";

// 倒计时文案：逾期 / 今天 / 还有 N 天（看板与详情页共用同一套说法）
export function countdownText(days: number, type: RiskType): string {
  if (days < 0) return `已逾期 ${-days} 天`;
  if (days === 0) return type === "birthday" ? "就是今天 🎂" : "今天到期";
  return `还有 ${days} 天`;
}
