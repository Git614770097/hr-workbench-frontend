import { useEffect, useRef, useMemo } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { FunnelStageItem, FunnelStayItem } from "../types";

echarts.use([BarChart, LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

interface Props {
  stages: FunnelStageItem[];
  stageStay?: FunnelStayItem[];
  /** 深色模式（跟随主题切换重绘） */
  dark?: boolean;
  height?: number;
}

const pct = (v: number) => `${(v * 100).toFixed(v >= 0.1 || v === 0 ? 0 : 1)}%`;

// ---- 配色：多色柔和（每层一个色相，统一明度/饱和度）----
// 每根柱色相不同（蓝/青/绿/琥珀/紫）以区分阶段，段内只做同色系纵向渐变（400→600）。
type Level = { from: string; to: string; text: string };

/** 亮色：填充 400→600 */
const LEVELS: Level[] = [
  { from: "#60a5fa", to: "#2563eb", text: "#1e40af" }, // 蓝
  { from: "#22d3ee", to: "#0891b2", text: "#155e75" }, // 青
  { from: "#34d399", to: "#059669", text: "#065f46" }, // 绿
  { from: "#fbbf24", to: "#d97706", text: "#92400e" }, // 琥珀
  { from: "#a78bfa", to: "#7c3aed", text: "#5b21b6" }, // 紫
];
/** 暗色：整体压深（600/700→800） */
const LEVELS_DARK: Level[] = [
  { from: "#2563eb", to: "#1e3a8a", text: "#ffffff" },
  { from: "#0e7490", to: "#164e63", text: "#ffffff" },
  { from: "#047857", to: "#064e3b", text: "#ffffff" },
  { from: "#b45309", to: "#78350f", text: "#ffffff" },
  { from: "#6d28d9", to: "#4c1d95", text: "#ffffff" },
];

/** 取第 i 层的配色（阶段多于配色表时复用最后一档） */
const levelAt = (i: number, dark: boolean): Level => {
  const arr = dark ? LEVELS_DARK : LEVELS;
  return arr[Math.min(i, arr.length - 1)];
};

/** 纵向同色系渐变（上浅下深，柱体立体感） */
const gradientOf = (i: number, dark: boolean) => {
  const l = levelAt(i, dark);
  return {
    type: "linear" as const,
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: l.from },
      { offset: 1, color: l.to },
    ],
  };
};

/**
 * 阶段转化组合图（柱 + 折线，替代原漏斗图）
 *
 * 为什么从漏斗换成柱形：原漏斗为保持「规整倒三角」，宽度编码的是线性递减的
 * 形状值而非真实人数——形状优势实际不存在。柱形图高度 = 真实人数，信息保真：
 * - 柱体：各阶段「曾到达」人数（真实值，柱顶标环比转化率与流失）
 * - 折线（右轴）：累计转化率 overall_rate，末点即端到端转化率
 * - x 轴第二行常驻当前停留均长（原右侧注释列的信息全部收编进图内）
 * 动效保留：柱体错开升起（animationDelay idx*110）、悬停阴影增强；
 * 原悬停联动 HTML 注释行的逻辑随注释列一并移除。
 */
export default function FunnelChartView({ stages, stageStay = [], dark = false, height = 420 }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  const topCount = useMemo(
    () => Math.max(1, stages.length > 0 ? stages[0].count : 1),
    [stages]
  );
  const maxCount = useMemo(
    () => Math.max(1, ...stages.map((s) => s.count)),
    [stages]
  );

  const stayMap = useMemo(
    () => Object.fromEntries(stageStay.map((x) => [x.key, x])) as Record<string, FunnelStayItem>,
    [stageStay]
  );

  const C = dark
    ? { axis: "#a1a1aa", split: "rgba(255,255,255,0.08)", line: "#60a5fa", lineLabel: "#93c5fd",
        cnt: "#f3f4f6", meta: "#9ca3af", legend: "#cbd5e1", tipBg: "#1f1f1f", tipBorder: "#3a3a3a", tipText: "#e5e7eb" }
    : { axis: "#6b7280", split: "rgba(15,23,42,0.06)", line: "#2563eb", lineLabel: "#3b82f6",
        cnt: "#111827", meta: "#6b7280", legend: "#4b5563", tipBg: "#ffffff", tipBorder: "#eef0f3", tipText: "#1f2937" };

  useEffect(() => {
    if (!boxRef.current) return;
    if (!chartRef.current) chartRef.current = echarts.init(boxRef.current);
    const chart = chartRef.current;

    chart.setOption(
      {
        animationDuration: 800,
        animationEasing: "cubicOut",
        // 错开入场：柱体依次升起（数据刷新/重新查询时因 notMerge 会重播）
        animationDelay: (idx: number) => idx * 110,
        animationDurationUpdate: 600,
        animationDelayUpdate: 0,
        legend: {
          top: 0,
          right: 0,
          itemWidth: 12,
          itemHeight: 8,
          textStyle: { color: C.legend, fontSize: 11 },
          data: ["人数", "累计转化率"],
        },
        grid: { left: 8, right: 8, top: 56, bottom: 4, containLabel: true },
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "shadow" },
          backgroundColor: C.tipBg,
          borderColor: C.tipBorder,
          textStyle: { color: C.tipText, fontSize: 12 },
          formatter: (ps: any[]) => {
            const i = ps[0]?.dataIndex ?? 0;
            const s = stages[i];
            if (!s) return "";
            const st = stayMap[s.key];
            const lines = [
              `<b>${s.label}</b>`,
              `人数：<b>${s.count}</b> 人（占顶层 ${pct(s.count / topCount)}）`,
            ];
            lines.push(
              i === 0
                ? "漏斗顶层"
                : `较上一级：<b>${pct(s.rate)}</b>${s.drop > 0 ? `，流失 ${s.drop} 人` : ""}`
            );
            lines.push(`累计转化：<b>${pct(s.overall_rate)}</b>`);
            if (st?.avg_days != null) lines.push(`当前停留均长：${st.avg_days} 天`);
            return lines.join("<br/>");
          },
        },
        xAxis: {
          type: "category",
          data: stages.map((s) => s.label),
          axisTick: { show: false },
          axisLine: { lineStyle: { color: C.split } },
          axisLabel: {
            interval: 0,
            margin: 12,
            // 第二行常驻停留均长（≥7 天橙色警示），替代原右侧注释列
            formatter: (label: string, idx: number) => {
              const st = stayMap[stages[idx]?.key];
              if (st?.avg_days == null) return label;
              return st.avg_days >= 7
                ? `{name|${label}}\n{slow|停留 ${st.avg_days} 天}`
                : `{name|${label}}\n{stay|停留 ${st.avg_days} 天}`;
            },
            rich: {
              name: { color: dark ? "#e5e7eb" : "#374151", fontSize: 12, fontWeight: 600, lineHeight: 18, align: "center" },
              stay: { color: "#9ca3af", fontSize: 10, lineHeight: 14, align: "center" },
              slow: { color: "#fa541c", fontSize: 10, lineHeight: 14, align: "center" },
            },
          },
        },
        yAxis: [
          {
            type: "value",
            max: Math.ceil(maxCount * 1.35), // 顶部留柱顶两行标注的空间
            splitLine: { lineStyle: { color: C.split } },
            axisLabel: { color: C.axis, fontSize: 11 },
          },
          {
            type: "value",
            min: 0,
            max: 100,
            splitLine: { show: false },
            axisLine: { show: false },
            axisTick: { show: false },
            axisLabel: {
              color: C.axis, fontSize: 10,
              formatter: (v: number) => (v === 0 || v === 50 || v === 100 ? `${v}%` : ""),
            },
          },
        ],
        series: [
          {
            name: "人数",
            type: "bar",
            barWidth: "46%",
            data: stages.map((s, i) => ({
              value: s.count,
              rate: s.rate,
              drop: s.drop,
              itemStyle: {
                color: gradientOf(i, dark),
                borderRadius: [4, 4, 0, 0],
                // 伪 3D：柱体向下柔和投影（暗色更深）
                shadowBlur: dark ? 10 : 8,
                shadowOffsetY: dark ? 5 : 4,
                shadowColor: dark ? "rgba(0,0,0,0.5)" : "rgba(15,23,42,0.14)",
              },
            })),
            label: {
              show: true,
              position: "top",
              align: "center",
              formatter: (p: any) =>
                p.dataIndex === 0
                  ? `{cnt|${p.value}}\n{base|漏斗顶层}`
                  : `{cnt|${p.value}}\n{meta|转化 ${pct(p.data.rate)}${p.data.drop > 0 ? ` · 流失 ${p.data.drop}` : ""}}`,
              rich: {
                cnt: { fontSize: 15, fontWeight: 700, color: C.cnt, lineHeight: 20, align: "center" },
                base: { fontSize: 10, color: "#9ca3af", lineHeight: 13, align: "center" },
                meta: { fontSize: 10, color: C.meta, lineHeight: 13, align: "center" },
              },
            },
            emphasis: {
              itemStyle: {
                shadowBlur: 20,
                shadowOffsetY: 8,
                shadowColor: dark ? "rgba(0,0,0,0.65)" : "rgba(15,23,42,0.3)",
              },
            },
          },
          {
            name: "累计转化率",
            type: "line",
            yAxisIndex: 1,
            z: 3,
            data: stages.map((s) => Math.round(s.overall_rate * 1000) / 10),
            symbol: "circle",
            symbolSize: 7,
            lineStyle: { color: C.line, width: 2 },
            itemStyle: { color: C.line, borderColor: C.tipBg, borderWidth: 2 },
            emphasis: { scale: 1.6 },
            // 只在末点常驻显示端到端转化率（最关键结论），其余读 tooltip
            label: {
              show: true,
              position: "top",
              fontSize: 11,
              fontWeight: 700,
              color: C.lineLabel,
              formatter: (p: any) => (p.dataIndex === stages.length - 1 ? `${p.value}%` : ""),
            },
          },
        ],
      },
      true
    );

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, [stages, topCount, maxCount, dark, JSON.stringify(stageStay)]);

  useEffect(() => {
    return () => {
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  return (
    <div className="funnel-canvas" style={{ height }}>
      <div ref={boxRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
