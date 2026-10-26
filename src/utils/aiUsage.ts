import type { AiUsage } from "../types";

// DeepSeek（deepseek-chat 别名，现路由至 V4-Flash 非思考模式）官方标价：
// 输入 ¥1 / 百万 tokens（缓存未命中，估算按最坏情况）、输出 ¥2 / 百万 tokens。
// 缓存命中只要 ¥0.02/M，所以这里的估价是「上限」，实际只会更便宜。
const PRICE_INPUT_PER_M = 1;
const PRICE_OUTPUT_PER_M = 2;

/** 估算本次生成的费用（元）。无 usage 时返回 null。智谱 GLM 免费档成本为 0 */
export function estimateCostYuan(usage: AiUsage | null | undefined): number | null {
  if (!usage || !Number.isFinite(usage.total_tokens)) return null;
  // 智谱 GLM-4.7-Flash 走的是免费档，不产生费用——不能再按 DeepSeek 价「假装」烧钱
  if (usage.provider === "zhipu") return 0;
  const cost =
    (usage.prompt_tokens * PRICE_INPUT_PER_M + usage.completion_tokens * PRICE_OUTPUT_PER_M) / 1_000_000;
  return cost;
}

/** 金额格式化：>=1 分钱显示 2 位小数，否则按量级显示 3-4 位 */
export function formatYuan(cost: number): string {
  if (cost >= 0.01) return cost.toFixed(2);
  if (cost >= 0.001) return cost.toFixed(3);
  if (cost > 0) return cost.toFixed(4);
  return "0";
}

/**
 * 「燃烧提示」文案：把 token 用量翻译成用户有感知的成本。
 * 目标是「还不错」的感觉——一次生成只要几分之一分钱，随便用。
 * 智谱免费档明说不花钱，别让用户误以为每次点一下都在扣钱。
 */
export function aiUsageText(usage: AiUsage | null | undefined): string | null {
  if (!usage || !Number.isFinite(usage.total_tokens) || usage.total_tokens <= 0) return null;
  const tokens = usage.total_tokens.toLocaleString("zh-CN");
  if (usage.provider === "zhipu") {
    return `本次燃烧 ${tokens} tokens（智谱 GLM 免费档，¥0）`;
  }
  const cost = estimateCostYuan(usage);
  if (cost == null) return `本次燃烧 ${tokens} tokens`;
  if (cost < 0.0001) {
    return `本次燃烧 ${tokens} tokens，几乎不花钱，随便用`;
  }
  const yuan = formatYuan(cost);
  if (cost < 0.01) {
    return `本次燃烧 ${tokens} tokens ≈ ¥${yuan}，一次不到 1 分钱，随便用`;
  }
  const fen = Math.max(1, Math.round(cost * 100));
  return `本次燃烧 ${tokens} tokens ≈ ¥${yuan}，也就 ${fen} 分钱`;
}
