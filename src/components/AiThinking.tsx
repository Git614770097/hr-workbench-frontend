import { useEffect, useState } from "react";
import { Spin } from "antd";

// AI 生成中的阶段提示：文案每 2 秒往后走一步，替代干转圈的 Spin，
// 让等待期间「AI 在干什么」可感知。配合结果区的打字机效果（TypeText）使用。
export default function AiThinking({ steps, style }: { steps: string[]; style?: React.CSSProperties }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    setI(0);
    const t = setInterval(() => setI((v) => Math.min(v + 1, steps.length - 1)), 2000);
    return () => clearInterval(t);
  }, [steps.length]);
  return (
    <div style={{ textAlign: "center", padding: "10px 0", color: "#8c8c8c", ...style }}>
      <Spin size="small" style={{ marginInlineEnd: 8 }} />
      {steps[i]}
    </div>
  );
}
