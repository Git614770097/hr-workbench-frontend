import { useEffect, useRef, useState } from "react";

// AI 输出逐字显示（伪打字机）：rAF 约 18ms 推进一个字，文本变化（重新生成）自动重放。
// 点击文本可跳过当前段动画（点哪段哪段立即完成），配合 AiThinking 阶段提示使用。
// 注意：本文件含 JSX（TypeText），必须是 .tsx 扩展名。
export function useTypewriter(text: string, msPerChar = 18) {
  const [len, setLen] = useState(0);
  const rafRef = useRef(0);

  useEffect(() => {
    setLen(0);
    if (!text) return;
    let start: number | null = null;
    const step = (ts: number) => {
      if (start == null) start = ts;
      const chars = Math.floor((ts - start) / msPerChar);
      setLen(Math.min(chars, text.length));
      if (chars < text.length) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [text, msPerChar]);

  const skip = () => setLen(text.length);
  return { shown: text.slice(0, len), done: len >= text.length, skip };
}

// TypeText：一段 AI 文本的打字机渲染。列表多条各渲染一个实例，点击跳过该段。
export function TypeText({
  text,
  style,
  className,
}: {
  text: string;
  style?: React.CSSProperties;
  className?: string;
}) {
  const { shown, done, skip } = useTypewriter(text);
  return (
    <span className={className} style={style} onClick={skip} title={done ? undefined : "点击跳过动画"}>
      {shown}
      {!done && <span style={{ opacity: 0.45 }}>▍</span>}
    </span>
  );
}
