import { Space, Tag, Typography } from "antd";
import type { AiResumeInsight } from "../types";

// AI 简历解读的渲染与文本化：人才详情页与导入核对弹窗共用，
// 避免两处各写一份导致展示不一致。
export default function AiInsightView({ data }: { data: AiResumeInsight }) {
  const fitColor = !data.jd_fit
    ? "default"
    : data.jd_fit.score >= 75
      ? "green"
      : data.jd_fit.score >= 50
        ? "orange"
        : "red";
  return (
    <div style={{ fontSize: 13 }}>
      {data.highlights?.length ? (
        <div style={{ marginBottom: 8 }}>
          <Typography.Text strong style={{ fontSize: 12, color: "#389e0d" }}>亮点</Typography.Text>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18, color: "#4b5563" }}>
            {data.highlights.map((x, i) => <li key={i}>{x}</li>)}
          </ul>
        </div>
      ) : null}
      {data.risks?.length ? (
        <div style={{ marginBottom: 8 }}>
          <Typography.Text strong style={{ fontSize: 12, color: "#d4380d" }}>风险 / 待验证</Typography.Text>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18, color: "#4b5563" }}>
            {data.risks.map((x, i) => <li key={i}>{x}</li>)}
          </ul>
        </div>
      ) : null}
      {data.jd_fit ? (
        <div style={{ marginBottom: 8 }}>
          <Space size={6}>
            <Typography.Text strong style={{ fontSize: 12 }}>与在招岗位匹配度</Typography.Text>
            <Tag color={fitColor} style={{ marginInlineEnd: 0 }}>{data.jd_fit.score} / 100</Tag>
          </Space>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18, color: "#4b5563" }}>
            {data.jd_fit.reasons.map((x, i) => <li key={i}>{x}</li>)}
          </ul>
        </div>
      ) : null}
      {data.suggestion ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>建议：{data.suggestion}</Typography.Text>
      ) : null}
    </div>
  );
}

/** 转纯文本，供「复制全部」使用 */
export function insightToText(data: AiResumeInsight): string {
  const lines: string[] = [];
  if (data.highlights?.length) lines.push(`亮点：\n${data.highlights.map((x) => `· ${x}`).join("\n")}`);
  if (data.risks?.length) lines.push(`风险/待验证：\n${data.risks.map((x) => `· ${x}`).join("\n")}`);
  if (data.jd_fit) lines.push(`匹配度：${data.jd_fit.score}/100\n${data.jd_fit.reasons.map((x) => `· ${x}`).join("\n")}`);
  if (data.suggestion) lines.push(`建议：${data.suggestion}`);
  return lines.join("\n\n");
}
