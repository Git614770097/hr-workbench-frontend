import { useEffect, useRef, useMemo } from "react";
import * as echarts from "echarts/core";
import { FunnelChart } from "echarts/charts";
import { TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { FunnelStageItem, FunnelStayItem } from "../types";

echarts.use([FunnelChart, TooltipComponent, CanvasRenderer]);

interface Props {
  stages: FunnelStageItem[];
  stageStay?: FunnelStayItem[];
  /** 深色模式（跟随主题切换重绘） */
  dark?: boolean;
  height?: number;
}

const pct = (v: number) => `${(v * 100).toFixed(v >= 0.1 || v === 0 ? 0 : 1)}%`;

// ---- 版式常量 ----
// 对齐官方 funnel 示例：gap 2（极小缝隙 → 轮廓连贯）、itemStyle 白色 1px 描边、
// label position inside、悬停放大。差异见文件头注释。
const TOP = 24;        // 漏斗上留白
const BOTTOM = 24;     // 漏斗下留白
const GAP = 2;         // 级间缝隙
const NOTES_W = 112;   // 右侧注释列宽度
const NOTES_GAP = 14;  // 漏斗右缘与注释列之间的呼吸空隙

/**
 * 招聘转化漏斗（ECharts）
 *
 * 参考官方示例 https://echarts.apache.org/examples/zh/editor.html?c=funnel：
 * 扁平纯色 + 白色 1px 描边 + gap 2 + label inside + 悬停放大。
 *
 * 三处刻意偏离官方示例（因为这是业务漏斗，不是演示图）：
 * 1. `sort: "none"` —— 官方是 descending。漏斗必须保持阶段真实顺序，
 *    否则「已入职」会因人数少被排到中间，形状就假了。
 * 2. `max: 顶层人数` + `minSize` —— 官方写死 max:100。我们用顶层人数归一，
 *    让宽度真实反映占比；再给最小宽度兜底，避免只有 1 人时细成一条线。
 * 3. 右侧注释列 —— 官方只有悬停 tooltip。转化率和流失人数是漏斗的核心结论，
 *    不能藏在悬停里，所以常驻在右侧，逐行与漏斗层级对齐。
 *
 * 右侧注释用 HTML 叠加层而非 echarts graphic：ECharts 漏斗的每级中心
 * 是 `i*(itemSize+gap)+itemSize/2`（itemSize=(viewHeight-gap*(n-1))/n），
 * 与等分 flex 行的中心最大偏差 <1px，肉眼不可辨；且文字样式交给 CSS，
 * 主题切换天然生效，也省掉一个 graphic 组件依赖。
 */
export default function FunnelChartView({ stages, stageStay = [], dark = false, height = 460 }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  const topCount = useMemo(
    () => Math.max(1, stages.length > 0 ? stages[0].count : 1),
    [stages]
  );

  const stayMap = useMemo(
    () => Object.fromEntries(stageStay.map((x) => [x.key, x])) as Record<string, FunnelStayItem>,
    [stageStay]
  );

  const C = dark
    ? { label: "#e5e7eb", tipBg: "#1f1f1f", tipBorder: "#3a3a3a", border: "#1f1f1f" }
    : { label: "#ffffff", tipBg: "#ffffff", tipBorder: "#eef0f3", border: "#ffffff" };

  useEffect(() => {
    if (!boxRef.current) return;
    if (!chartRef.current) chartRef.current = echarts.init(boxRef.current);
    const chart = chartRef.current;

    chart.setOption(
      {
        animationDuration: 700,
        animationEasing: "cubicOut",
        tooltip: {
          trigger: "item",
          backgroundColor: C.tipBg,
          borderColor: C.tipBorder,
          textStyle: { color: dark ? "#e5e7eb" : "#1f2937", fontSize: 12 },
          formatter: (p: any) => {
            const d = p.data as any;
            const lines = [
              `<b>${d.name}</b>`,
              `人数：<b>${d.value}</b> 人（占顶层 ${pct(d.value / topCount)}）`,
            ];
            lines.push(
              d.i === 0
                ? "漏斗顶层"
                : `较上一级：<b>${pct(d.rate)}</b>${d.drop > 0 ? `，流失 ${d.drop} 人` : ""}`
            );
            if (d.avgDays != null) lines.push(`当前停留均长：${d.avgDays} 天`);
            return lines.join("<br/>");
          },
        },
        series: [
          {
            type: "funnel",
            left: "6%",
            right: NOTES_W + NOTES_GAP, // 右侧留白给注释列
            top: TOP,
            bottom: BOTTOM,
            min: 0,
            max: topCount,       // 宽度按顶层人数归一，真实反映占比
            minSize: "16%",      // 保底宽度，避免单人时细成一条线
            maxSize: "100%",
            sort: "none",        // 保持阶段真实顺序（官方是 descending）
            gap: GAP,
            funnelAlign: "center",
            label: {
              show: true,
              position: "inside",
              color: C.label,
              fontSize: 13,
              fontWeight: 500,
              formatter: (p: any) => `${p.name}   ${p.value}`,
            },
            labelLine: { show: false },
            itemStyle: { borderColor: C.border, borderWidth: 1 },
            emphasis: {
              label: { fontSize: 16, fontWeight: 700 },
              itemStyle: { shadowBlur: 12, shadowColor: "rgba(0,0,0,0.18)" },
            },
            data: stages.map((s, i) => ({
              name: s.label,
              value: s.count,
              i,
              rate: s.rate,
              drop: s.drop,
              avgDays: stayMap[s.key]?.avg_days ?? null,
              itemStyle: { color: s.color },
            })),
          },
        ],
      },
      true
    );

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, [stages, topCount, dark, JSON.stringify(stageStay)]);

  useEffect(() => {
    return () => {
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  return (
    <div className="funnel-canvas" style={{ height }}>
      <div ref={boxRef} style={{ width: "100%", height: "100%" }} />
      {/* 右侧注释列：逐行与漏斗层级对齐（pointer-events:none，不挡悬停） */}
      <div
        className="funnel-notes"
        style={{ top: TOP, bottom: BOTTOM, width: NOTES_W }}
        aria-hidden="true"
      >
        {stages.map((s, i) => {
          const st = stayMap[s.key];
          return (
            <div className="funnel-note" key={s.key}>
              <div className="funnel-note-main">
                {i === 0 ? (
                  <span className="funnel-note-base">漏斗顶层</span>
                ) : (
                  <>
                    <span className={s.rate < 0.5 ? "funnel-note-rate is-low" : "funnel-note-rate"}>
                      {pct(s.rate)}
                    </span>
                    {s.drop > 0 && <span className="funnel-note-drop">流失 {s.drop}</span>}
                  </>
                )}
              </div>
              {st && st.avg_days != null && (
                <div className={st.avg_days >= 7 ? "funnel-note-sub is-slow" : "funnel-note-sub"}>
                  停留 {st.avg_days} 天
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
