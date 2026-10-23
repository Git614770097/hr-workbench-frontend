import { useEffect, useRef, useMemo, type MutableRefObject } from "react";
import * as echarts from "echarts/core";
import { FunnelChart } from "echarts/charts";
import { TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { FunnelStageItem, FunnelStayItem } from "../types";
import { DEFAULT_FUNNEL_PALETTE, paletteLevels, type FunnelPaletteLevel } from "../funnelPalette";

echarts.use([FunnelChart, TooltipComponent, CanvasRenderer]);

interface Props {
  stages: FunnelStageItem[];
  stageStay?: FunnelStayItem[];
  /** 深色模式（跟随主题切换重绘） */
  dark?: boolean;
  height?: number;
  /** 配色预设 id，见 funnelPalette.ts */
  palette?: string;
  /** 暴露 ECharts 实例，供「下载 PNG」使用 */
  chartOut?: MutableRefObject<echarts.ECharts | null>;
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

// ---- 配色 ----
// 色板定义已抽到 funnelPalette.ts（含 5 套预设 + 用户切换 + 暗色自动推导）。
// 这里只负责「按 id + 明暗取到当阶颜色」，不再维护具体颜色值。
// 层级多于色板阶数时复用最后一阶（与用户手动选色时的预期一致：越到后面越深）。

/** 取第 i 阶的配色 */
const levelAt = (i: number, levels: FunnelPaletteLevel[]): FunnelPaletteLevel =>
  levels[Math.min(i, levels.length - 1)];

/** 纵向同色系渐变（上浅下深，增加段内立体感） */
const gradientOf = (i: number, levels: FunnelPaletteLevel[]) => {
  const l = levelAt(i, levels);
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
export default function FunnelChartView({ stages, stageStay = [], dark = false, height = 460, palette = DEFAULT_FUNNEL_PALETTE, chartOut }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  // 当前生效的层级配色（palette 切换 / 明暗切换时整体变化）
  const levels = useMemo(() => paletteLevels(palette, dark), [palette, dark]);

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
    if (!chartRef.current) {
      chartRef.current = echarts.init(boxRef.current);
      if (chartOut) chartOut.current = chartRef.current;
    }
    const chart = chartRef.current;

    chart.setOption(
      {
        animationDuration: 800,
        animationEasing: "cubicOut",
        // 错开入场：五层依次滑入（数据刷新/重新查询时因 notMerge 会重播）
        animationDelay: (idx: number) => idx * 110,
        animationDurationUpdate: 600,
        animationDelayUpdate: 0,
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
              // 伪 3D：每层向下的柔和投影 → 层叠「浮起」感（渐变管纵向立体，投影管层间分离）
              shadowBlur: dark ? 10 : 8,
              shadowOffsetY: dark ? 5 : 4,
              shadowColor: dark ? "rgba(0,0,0,0.5)" : "rgba(15,23,42,0.16)",
            },
            emphasis: {
              label: { fontSize: 19, fontWeight: 700 },
              itemStyle: {
                shadowBlur: 22,
                shadowOffsetY: 8,
                shadowColor: dark ? "rgba(0,0,0,0.65)" : "rgba(15,23,42,0.3)",
              },
            },
            data: stages.map((s, i) => ({
              name: s.label,
              value: n - i, // 形状值：线性递减，使梯形斜边共线成倒三角形
              realCount: s.count, // 真实人数（label / tooltip 用）
              i,
              rate: s.rate,
              drop: s.drop,
              avgDays: stayMap[s.key]?.avg_days ?? null,
              // 形状值仍是线性递减（保证倒三角），但 0 人的层级压暗——
              // 否则「0 人」还占着满格宽度，视觉上像有人（2026-10-22 修）
              itemStyle: { color: gradientOf(i, levels), opacity: s.count === 0 ? 0.35 : 1 },
              // 每级独立文字色：与该级同色系的深色（暗色模式为白色）
              label: { color: levelAt(i, levels).text },
            })),
          },
        ],
      },
      true
    );

    // 悬停联动：悬停漏斗某层 → 左侧阶段名 + 右侧注释对应行同步高亮
    //（ECharts 在 canvas 里，HTML 列 pointer-events:none，只能反向用事件驱动 DOM）
    const labEls = Array.from(boxRef.current.querySelectorAll<HTMLElement>(".funnel-label"));
    const noteEls = Array.from(boxRef.current.querySelectorAll<HTMLElement>(".funnel-note"));
    const onHover = (p: { dataIndex: number }) => {
      labEls[p.dataIndex]?.classList.add("is-active");
      noteEls[p.dataIndex]?.classList.add("is-active");
    };
    const onLeave = (p: { dataIndex: number }) => {
      labEls[p.dataIndex]?.classList.remove("is-active");
      noteEls[p.dataIndex]?.classList.remove("is-active");
    };
    chart.on("mouseover", onHover);
    chart.on("mouseout", onLeave);

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(boxRef.current);
    return () => {
      chart.off("mouseover", onHover);
      chart.off("mouseout", onLeave);
      ro.disconnect();
    };
  }, [stages, topCount, dark, palette, JSON.stringify(stageStay)]);

  useEffect(() => {
    return () => {
      if (chartOut) chartOut.current = null;
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, [chartOut]);

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

// ============================================================
// PNG 导出（带左右注释列）
// ============================================================
// 页面上的阶段名列与转化率列是 HTML 叠加层，不在 ECharts canvas 内。
// 直接 getDataURL 导出的图只有色块和人数，贴进汇报没人看得懂。
// 这里用离屏 canvas 把三部分合成一张：ECharts 图 + 左列阶段名 + 右列转化/流失/停留。
// 不引入 html2canvas：绘制逻辑完全可控，也不必为一张图加 50KB 依赖。
//
// 行中心与 ECharts 漏斗层中心的换算见文件头注释（等分 flex 的偏差 <1px）。
// 导出统一白底 + 深色字：给 PPT 用，与当前明暗主题无关。

const PNG_FONT = '"PingFang SC", "Microsoft YaHei", system-ui, -apple-system, sans-serif';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图表图片加载失败"));
    img.src = src;
  });
}

/**
 * 合成带注释列的漏斗 PNG。
 * @returns dataURL（调用方负责下载）；图表未就绪或合成失败时返回 null。
 */
export async function exportFunnelPng(
  inst: echarts.ECharts | null,
  stages: FunnelStageItem[],
  stageStay: FunnelStayItem[] = []
): Promise<string | null> {
  if (!inst || stages.length === 0) return null;
  const DPR = 2;
  // 白底 + 当前色板：暗色主题下导出的图仍然是白底深字，避免贴到白 PPT 上发黑
  const dataUrl = inst.getDataURL({ type: "png", pixelRatio: DPR, backgroundColor: "#ffffff" });
  const img = await loadImage(dataUrl);

  const cv = document.createElement("canvas");
  cv.width = img.width;
  cv.height = img.height;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);

  // 之后所有坐标都按 CSS 像素书写，由 scale 统一放大到导出分辨率
  ctx.scale(DPR, DPR);
  const W = img.width / DPR;
  const H = img.height / DPR;

  const n = stages.length;
  const rowH = (H - TOP - BOTTOM) / n;
  const centerY = (i: number) => TOP + rowH * (i + 0.5);
  const stayMap = Object.fromEntries(stageStay.map((x) => [x.key, x])) as Record<string, FunnelStayItem>;

  ctx.textBaseline = "middle";

  // ---- 左列：阶段名（与页面一致：13px / 500 / 右对齐，右侧留 10px） ----
  ctx.textAlign = "right";
  ctx.font = `500 13px ${PNG_FONT}`;
  ctx.fillStyle = "#374151";
  stages.forEach((s, i) => {
    ctx.fillText(s.label, LABELS_W - 10, centerY(i));
  });

  // ---- 右列：转化率 + 流失 + 平均停留（右对齐到画布右缘） ----
  const rightX = W - 4;
  stages.forEach((s, i) => {
    const st = stayMap[s.key];
    const hasSub = st && st.avg_days != null;
    const mainY = hasSub ? centerY(i) - 8 : centerY(i);

    if (i === 0) {
      ctx.textAlign = "right";
      ctx.font = `500 12px ${PNG_FONT}`;
      ctx.fillStyle = "#6b7280";
      ctx.fillText("漏斗顶层", rightX, mainY);
    } else {
      // 「流失 N」在右，转化率在其左（两段分色，与页面同一信息层级）
      const dropText = s.drop > 0 ? `流失 ${s.drop}` : "";
      let dropW = 0;
      if (dropText) {
        ctx.font = `400 11px ${PNG_FONT}`;
        dropW = ctx.measureText(dropText).width + 6;
      }
      ctx.textAlign = "right";
      ctx.font = `500 12px ${PNG_FONT}`;
      ctx.fillStyle = s.rate < 0.5 ? "#b45309" : "#374151";
      ctx.fillText(pct(s.rate), rightX - dropW, mainY);
      if (dropText) {
        ctx.font = `400 11px ${PNG_FONT}`;
        ctx.fillStyle = "#9ca3af";
        ctx.fillText(dropText, rightX, mainY);
      }
    }

    if (hasSub) {
      ctx.textAlign = "right";
      ctx.font = `400 11px ${PNG_FONT}`;
      ctx.fillStyle = (st.avg_days as number) >= 7 ? "#b45309" : "#9ca3af";
      ctx.fillText(`停留 ${st.avg_days} 天`, rightX, centerY(i) + 9);
    }
  });

  return cv.toDataURL("image/png");
}
