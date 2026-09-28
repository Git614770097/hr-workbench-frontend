import { useLayoutEffect, useRef, useState } from "react";

/**
 * 列表表格高度自适应视口：表头固定、只有表体滚动，分页条常驻可见。
 *
 * 为什么不用固定 px（如 y: 380）：同一份代码在 13 寸笔记本和 27 寸大屏上的
 * 可用高度能差一倍，写死要么大面积留白、要么把表格压成一条缝。
 *
 * 算法：可视高度 - 表格顶部到内容区顶端的距离 - 底部预留（分页条 + 内边距）。
 * 关键点是「顶部距离」用 rect.top + 容器 scrollTop 换算，抵消页面滚动的影响，
 * 否则用户一滚动页面表格就跟着缩，高度会抖。
 *
 * 用法：
 *   const { ref, y } = useTableScrollY();
 *   <div ref={ref}><Table scroll={{ x: 1500, y }} /></div>
 *
 * @param min     最小高度，视口太矮时兜底（宁可页面滚动，也不要表格只剩表头）
 * @param reserve 表格底部预留：分页条 + 卡片/内容区内边距
 */
export function useTableScrollY(min = 240, reserve = 88) {
  const ref = useRef<HTMLDivElement>(null);
  const [y, setY] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    let raf = 0;

    const calc = () => {
      const el = ref.current;
      if (!el) return;
      const main = el.closest(".main-content") as HTMLElement | null;
      // 用内容区可视高度（不含浏览器滚动条），并抵消当前滚动量 → 结果只跟布局有关
      const viewport = main ? main.clientHeight : window.innerHeight;
      const top = el.getBoundingClientRect().top + (main ? main.scrollTop : 0);
      const next = Math.max(min, Math.round(viewport - top - reserve));
      // 1px 级抖动不更新，避免 ResizeObserver 与表格重排互相触发
      setY((prev) => (prev !== undefined && Math.abs(prev - next) < 2 ? prev : next));
    };

    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(calc);
    };

    calc();
    window.addEventListener("resize", schedule);

    // 搜索区展开/收起、统计卡增删、提示条关闭都会改变表格上方高度，
    // 观察页面根容器即可覆盖这些变化（表格自身高度变化不改变 top，收敛）
    const root = ref.current?.closest(".main-content")?.firstElementChild ?? null;
    const ro = root ? new ResizeObserver(schedule) : null;
    if (root && ro) ro.observe(root);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      ro?.disconnect();
    };
  }, [min, reserve]);

  return { ref, y };
}
