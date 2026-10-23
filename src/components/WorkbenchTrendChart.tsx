import { useEffect, useRef, type MutableRefObject } from "react";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { TooltipComponent, LegendComponent, GridComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { TrendResponse } from "../types";

echarts.use([LineChart, TooltipComponent, LegendComponent, GridComponent, CanvasRenderer]);

interface Props {
  data: TrendResponse | null;
  /** 深色模式（跟随主题切换重绘） */
  dark?: boolean;
  height?: number;
  /** 暴露 ECharts 实例，供「下载 PNG」使用 */
  chartOut?: MutableRefObject<echarts.ECharts | null>;
}

/**
 * 工作台趋势折线：新增人才 / 进入面试 / 入职（周 / 天）。
 * 数据源 GET /api/overview/trend，口径与漏斗同源（job_stage_logs）。
 */
export default function WorkbenchTrendChart({ data, dark = false, height = 280, chartOut }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  const textColor = dark ? "#b0b6c0" : "#8c8c8c";
  const axisColor = dark ? "#3a3a3a" : "#eef0f3";

  useEffect(() => {
    if (!boxRef.current) return;
    if (!chartRef.current) {
      chartRef.current = echarts.init(boxRef.current);
      if (chartOut) chartOut.current = chartRef.current;
    }
    const chart = chartRef.current;
    if (!data) {
      // 数据被清空时只清画面、不卸载组件：否则 div 被移除后 echarts 实例会绑在
      // 已脱离文档的节点上，下次挂载就画不出来（黑图）
      chart.clear();
      return;
    }

    const series = data.series.map((s) => ({
      name: s.label,
      type: "line" as const,
      smooth: true,
      symbol: "circle",
      symbolSize: 6,
      showSymbol: data.labels.length <= 14,
      lineStyle: { width: 2.5, color: s.color },
      itemStyle: { color: s.color },
      areaStyle: {
        opacity: 0.12,
        color: s.color,
      },
      emphasis: { focus: "series" as const },
      data: s.data,
    }));

    chart.setOption(
      {
        animationDuration: 700,
        animationEasing: "cubicOut",
        grid: { left: 8, right: 16, top: 40, bottom: 4, containLabel: true },
        legend: {
          top: 4,
          right: 0,
          icon: "roundRect",
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { color: textColor, fontSize: 12 },
        },
        tooltip: {
          trigger: "axis",
          backgroundColor: dark ? "#1f1f1f" : "#ffffff",
          borderColor: dark ? "#3a3a3a" : "#eef0f3",
          textStyle: { color: dark ? "#e5e7eb" : "#1f2937", fontSize: 12 },
        },
        xAxis: {
          type: "category",
          boundaryGap: false,
          data: data.labels,
          axisLine: { lineStyle: { color: axisColor } },
          axisTick: { show: false },
          axisLabel: { color: textColor, fontSize: 11 },
        },
        yAxis: {
          type: "value",
          minInterval: 1,
          splitLine: { lineStyle: { color: axisColor, type: "dashed" } },
          axisLabel: { color: textColor, fontSize: 11 },
        },
        series,
      },
      true
    );

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, [data, dark, textColor, axisColor, chartOut]);

  useEffect(() => {
    return () => {
      if (chartOut) chartOut.current = null;
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, [chartOut]);

  // 始终渲染容器：图表的挂载/卸载会导致 echarts 实例与 DOM 脱钩（见上）
  return <div ref={boxRef} style={{ width: "100%", height }} />;
}
