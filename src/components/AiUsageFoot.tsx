import { Typography } from "antd";
import { aiUsageText } from "../utils/aiUsage";
import type { AiUsage } from "../types";

/**
 * AI 生成页脚：展示「本次燃烧了多少 token、约合多少钱」。
 * 出现在 AiResultCard 结果区底部与招聘概览 AI 复盘卡底部——
 * 让用户对每次 AI 生成的成本有感知，且感知到「很便宜，随便用」。
 * usage 为 null（老缓存/接口没回传）时不渲染。
 */
export default function AiUsageFoot({ usage }: { usage?: AiUsage | null }) {
  const text = aiUsageText(usage);
  if (!text) return null;
  return (
    <div style={{ marginTop: 12, textAlign: "center" }}>
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        {text}
      </Typography.Text>
    </div>
  );
}
