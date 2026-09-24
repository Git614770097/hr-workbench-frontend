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
const NOTES_W = 112;   // 右侧注释列宽度（转化率 / 流失 / 停留）
const NOTES_GAP = 14;  // 漏斗右缘与注释列之间的呼吸空隙
const LABELS_W = 76;   // 左侧阶段名列宽度
const LABELS_GAP = 14; // 漏斗左缘与阶段名列之间的呼吸空隙

// ---- 配色：多色柔和（每层一个色相，统一明度/饱和度）----
// 每层色相不同（蓝/青/绿/琥珀/紫）以区分阶段，但都取同一档明度与中等饱和度，
// 所以既分得清层次，又不会像后端 STAGE_LABELS 的彩虹色那样跳。
// ⚠️ 段内只做**同色系**渐变（400→600）；跨色相渐变（如蓝→青）过渡会发脏。
type Level = { from: string; to: string; text: string };

/** 亮色：填充 400→600，文字用同色系 800（对比度均 ≥4.5:1） */
const LEVELS: Level[] = [
  { from: "#60a5fa", to: "#2563eb", text: "#1e40af" }, // 蓝 - 简历筛选
  { from: "#22d3ee", to: "#0891b2", text: "#155e75" }, // 青 - 初试
  { from: "#34d399", to: "#059669", text: "#065f46" }, // 绿 - 复试
  { from: "#fbbf24", to: "#d97706", text: "#92400e" }, // 琥珀 - Offer
  { from: "#a78bfa", to: "#7c3aed", text: "#5b21b6" }, // 紫 - 已入职
];
/** 暗色：整体压深（600/700→800），文字统一白色 */
const LEVELS_DARK: Level[] = [
  { from: "#2563eb", to: "#1e3a8a", text: "#ffffff" },
  { from: "#0e7490", to: "#164e63", text: "#ffffff" },
  { from: "#047857", to: "#064e3b", text: "#ffffff" },
  { from: "#b45309", to: "#78350f", text: "#ffffff" },
  { from: "#6d28d9", to: "#4c1d95", text: "#ffffff" },
];

/** 取第 i 层的配色（层级多于配色表时复用最后一档） */
const levelAt = (i: number, dark: boolean): Level => {
  const arr = dark ? LEVELS_DARK : LEVELS;
  return arr[Math.min(i, arr.length - 1)];
};

/** 供页面其他位置（右侧分析列表的色点/进度条）复用同一套配色，避免两处不一致 */
export const levelColor = (i: number, dark = false) => levelAt(i, dark).from;

/** 纵向同色系渐变（上浅下深，增加段内立体感） */
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

  // 阶段数：用于生成「形状值」序列（线性递减 → 倒三角形）
  const n = Math.max(1, stages.length);

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
            const real = d.realCount ?? d.value; // 用真实人数，不用形状值
            const lines = [
              `<b>${d.name}</b>`,
              `人数：<b>${real}</b> 人（占顶层 ${pct(real / topCount)}）`,
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
            left: LABELS_W + LABELS_GAP, // 左侧留白给阶段名列
            right: NOTES_W + NOTES_GAP, // 右侧留白给注释列
            top: TOP,
            bottom: BOTTOM,
            // ⚠️ 宽度现在是「形状值」而非人数：用线性递减的 shapeValue（n, n-1, ... 1），
            // 让每级梯形的斜边共线 → 整体是一个规整的倒三角形。
            // （若用真实人数 5/3/2/1/1 这种非线性数据，斜边是折线，形状不可能规整。）
            // 真实人数改由段内 label 与右侧注释列承载，不靠宽度编码。
            min: 0,
            max: n,              // 形状值域 = 阶段数
            minSize: "0%",       // 0 才能让末级下底收到 0，形成尖锐的三角形顶点
            maxSize: "65%",      // 最宽级占漏斗区 65%，控制宽高比不至于扁
            sort: "none",        // 保持阶段真实顺序（官方是 descending）
            gap: GAP,
            funnelAlign: "center",
            label: {
              show: true,
              position: "inside",
              // 段内只放大号人数：阶段名已移到左侧独立列，
              // 这样最窄的末级也不会文字溢出三角形（白字压到白底会看不见）
              fontSize: 17,
              fontWeight: 700,
              textShadowColor: "rgba(0,0,0,0.28)",
              textShadowBlur: 3,
              // 显示真实人数（p.value 是形状值，不能直接显示）
              formatter: (p: any) => `${p.data.realCount}`,
            },
            labelLine: { show: false },
            itemStyle: {
              borderColor: C.border,
              borderWidth: 2,
              borderRadius: 4, // 圆角，去掉生硬的直角
            },
            emphasis: {
              label: { fontSize: 16, fontWeight: 700 },
              itemStyle: { shadowBlur: 14, shadowColor: "rgba(0,0,0,0.18)" },
            },
            data: stages.map((s, i) => ({
              name: s.label,
              value: n - i, // 形状值：线性递减，使梯形斜边共线成倒三角形
              realCount: s.count, // 真实人数（label / tooltip 用）
              i,
              rate: s.rate,
              drop: s.drop,
              avgDays: stayMap[s.key]?.avg_days ?? null,
              itemStyle: { color: gradientOf(i, dark) },
              // 每级独立文字色：与该级同色系的深色（暗色模式为白色）
              label: { color: levelAt(i, dark).text },
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
      {/* 左侧阶段名列：等分 flex 行，与漏斗各级中心对齐 */}
      <div
        className="funnel-labels"
        style={{ top: TOP, bottom: BOTTOM, width: LABELS_W }}
        aria-hidden="true"
      >
        {stages.map((s) => (
          <div className="funnel-label" key={s.key}>
            {s.label}
          </div>
        ))}
      </div>
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
