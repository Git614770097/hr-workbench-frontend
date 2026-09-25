import { useState, useEffect, useRef } from "react";

/**
 * 数字滚动计数：值变化后从 0 平滑滚到目标值（easeOutCubic，避免生硬跳变）。
 * 用于统计卡片、个税计算器等需要数字过渡的场景。
 */
export default function AnimatedNumber({
  value,
  duration = 700,
  format,
}: {
  value: number;
  duration?: number;
  format: (n: number) => string;
}) {
  const [display, setDisplay] = useState(0);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const start = performance.now();
    const to = value;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      setDisplay(to * eased);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [value, duration]);

  return <>{format(display)}</>;
}
