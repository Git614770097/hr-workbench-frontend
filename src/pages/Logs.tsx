import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Card, Select, Space, Button, Table, Empty, Spin, Tag, Tooltip, message } from "antd";
import {
  ReloadOutlined, SearchOutlined, BarChartOutlined, LineChartOutlined,
  AppstoreOutlined, TeamOutlined, ThunderboltOutlined, ProfileOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { api } from "../api";
import type { UsageOverview, UsageEventRow } from "../types";
import { MENU_COLORS, MENU_LABELS, menuLabel } from "../usageMeta";
import AnimatedNumber from "../components/AnimatedNumber";

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

/**
 * 日志管理 —— 各模块的点击率（使用热度）。
 *
 * 数据来自前端埋点（components/UsageTracker）：用户在会话内按菜单聚合，
 * 每 30 秒批量上报一次，后端 UPSERT 进 usage_daily。因此这里的「访问次数」
 * 是合并后的 PV，不是逐次点击流水；「明细」是按上报批次落的一条记录。
 *
 * 口径说明（页面上也要显示，避免误读）：
 * - 访问次数（PV）：同一菜单被打开的累计次数，来回切会重复计。
 * - 使用人数（UV）：去重后的账号数。
 * - 停留时长：前台可见状态下的累计时间，切到后台不计。
 */

const TIME_RANGES = [
  { label: "近 7 天", value: 7 },
  { label: "近 30 天", value: 30 },
  { label: "近 90 天", value: 90 },
];

const ROLE_LABELS: Record<string, string> = {
  admin: "管理员",
  user: "普通用户",
  hr: "HR",
  headhunter: "猎头",
};

/** 秒级可读的停留时长 */
function dwellText(ms: number): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 把明细里的 JSON 摘要渲染成人话 */
function detailText(raw: string | null): string {
  if (!raw) return "—";
  try {
    const d = JSON.parse(raw) as { views?: number; dwell_ms?: number };
    const parts: string[] = [];
    if (d.views) parts.push(`访问 ${d.views} 次`);
    if (d.dwell_ms) parts.push(`停留 ${dwellText(d.dwell_ms)}`);
    return parts.length ? parts.join(" · ") : "—";
  } catch {
    return raw;
  }
}

/** ECharts 通用容器：只在 option 变化时重绘，卸载时释放实例 */
function Chart({ option, height }: { option: any; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    inst.current = echarts.init(ref.current);
    const onResize = () => inst.current?.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      inst.current?.dispose();
      inst.current = null;
    };
  }, []);

  useEffect(() => {
    if (inst.current && option) inst.current.setOption(option, true);
  }, [option]);

  return <div ref={ref} style={{ width: "100%", height }} />;
}

export default function Logs() {
  const [data, setData] = useState<UsageOverview | null>(null);
  const [loading, setLoading] = useState(true);

  // 已应用条件 / 草稿条件（点「查询」才生效）
  const [days, setDays] = useState(7);
  const [menuFilter, setMenuFilter] = useState("");
  const [draftDays, setDraftDays] = useState(7);
  const [draftMenu, setDraftMenu] = useState("");

  const [events, setEvents] = useState<UsageEventRow[]>([]);
  const [eventTotal, setEventTotal] = useState(0);
  const [eventPage, setEventPage] = useState(1);
  const [eventLoading, setEventLoading] = useState(false);

  // 跟随全局主题（ECharts 的文字/网格色需要显式给，否则暗色下看不清）
  const [isDark, setIsDark] = useState(
    () => document.documentElement.getAttribute("data-theme-mode") === "dark"
  );
  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setIsDark(el.getAttribute("data-theme-mode") === "dark");
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(el, { attributes: true, attributeFilter: ["data-theme-mode"] });
    return () => mo.disconnect();
  }, []);

  const axisColor = isDark ? "#9ca3af" : "#6b7280";
  const splitColor = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)";

  const fetchOverview = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getUsageOverview({ days, menu: menuFilter || undefined });
      setData(res);
    } catch (err) {
      message.error((err as Error).message);
    }
    setLoading(false);
  }, [days, menuFilter]);

  const fetchEvents = useCallback(
    async (page: number) => {
      setEventLoading(true);
      try {
        const res = await api.getUsageEvents({
          days,
          menu: menuFilter || undefined,
          page,
          page_size: 10,
        });
        setEvents(res.items);
        setEventTotal(res.total);
      } catch (err) {
        message.error((err as Error).message);
      }
      setEventLoading(false);
    },
    [days, menuFilter]
  );

  useEffect(() => { fetchOverview(); }, [fetchOverview]);
  useEffect(() => {
    setEventPage(1);
    fetchEvents(1);
  }, [fetchEvents]);

  const handleSearch = () => {
    setDays(draftDays);
    setMenuFilter(draftMenu);
  };
  const handleReset = () => {
    setDraftDays(7);
    setDraftMenu("");
    setDays(7);
    setMenuFilter("");
  };

  // ---- 热度排行：横向条形，最大的排最上（ECharts 横向条第一个在最下方，故倒序） ----
  const rankOption = useMemo(() => {
    const rows = [...(data?.ranking || [])].slice(0, 12).reverse();
    return {
      grid: { left: 8, right: 48, top: 8, bottom: 8, containLabel: true },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (ps: any[]) => {
          const p = ps[0];
          const row = rows[p.dataIndex];
          return `${p.name}<br/>访问 ${row?.views || 0} 次 · ${row?.uv || 0} 人`;
        },
      },
      xAxis: {
        type: "value",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: axisColor, fontSize: 11 },
        splitLine: { lineStyle: { color: splitColor } },
      },
      yAxis: {
        type: "category",
        data: rows.map((r) => menuLabel(r.menu)),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: axisColor, fontSize: 12 },
      },
      series: [
        {
          type: "bar",
          data: rows.map((r) => ({
            value: r.views,
            itemStyle: {
              color: MENU_COLORS[r.menu] || "#64748b",
              borderRadius: [0, 4, 4, 0],
            },
          })),
          barMaxWidth: 18,
          label: {
            show: true,
            position: "right",
            color: axisColor,
            fontSize: 11,
            formatter: "{c}",
          },
        },
      ],
    };
  }, [data?.ranking, axisColor, splitColor]);

  // ---- 趋势：按天补齐（后端只返回有数据的天，缺的天要补 0 否则折线会跳） ----
  const trendOption = useMemo(() => {
    if (!data) return null;
    const map = new Map(data.trend.map((t) => [t.day, t]));
    const xs: string[] = [];
    const views: number[] = [];
    const uv: number[] = [];
    let cur = dayjs(data.range.from);
    const end = dayjs(data.range.to);
    // 防御：范围异常时直接退出，避免死循环
    for (let i = 0; i < 400 && !cur.isAfter(end); i += 1) {
      const key = cur.format("YYYY-MM-DD");
      const hit = map.get(key);
      xs.push(cur.format("MM-DD"));
      views.push(hit?.views || 0);
      uv.push(hit?.uv || 0);
      cur = cur.add(1, "day");
    }
    return {
      grid: { left: 8, right: 16, top: 32, bottom: 8, containLabel: true },
      legend: { show: true, top: 0, textStyle: { color: axisColor, fontSize: 11 } },
      tooltip: { trigger: "axis" },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: xs,
        axisLine: { lineStyle: { color: splitColor } },
        axisTick: { show: false },
        axisLabel: { color: axisColor, fontSize: 11 },
      },
      yAxis: {
        type: "value",
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: axisColor, fontSize: 11 },
        splitLine: { lineStyle: { color: splitColor } },
      },
      series: [
        {
          name: "访问次数",
          type: "line",
          smooth: true,
          showSymbol: false,
          data: views,
          lineStyle: { width: 2, color: "#3b82f6" },
          itemStyle: { color: "#3b82f6" },
          areaStyle: { color: isDark ? "rgba(59,130,246,0.18)" : "rgba(59,130,246,0.10)" },
        },
        {
          name: "使用人数",
          type: "line",
          smooth: true,
          showSymbol: false,
          data: uv,
          lineStyle: { width: 2, color: "#10b981" },
          itemStyle: { color: "#10b981" },
        },
      ],
    };
  }, [data, axisColor, splitColor, isDark]);

  // ---- 用户 × 模块矩阵 ----
  const matrixMax = useMemo(() => {
    let max = 0;
    for (const u of data?.users || []) {
      for (const v of Object.values(u.menus)) if (v > max) max = v;
    }
    return max || 1;
  }, [data?.users]);

  const matrixColumns = useMemo(() => {
    const menus = (data?.menus || []).slice(0, 12);
    return [
      {
        title: "用户",
        key: "user",
        fixed: "left" as const,
        width: 160,
        render: (_: unknown, r: UsageOverview["users"][number]) => (
          <Space size={6}>
            <span>{r.name}</span>
            <Tag style={{ marginInlineEnd: 0 }}>{ROLE_LABELS[r.role] || r.role}</Tag>
          </Space>
        ),
      },
      ...menus.map((m) => ({
        title: <Tooltip title={menuLabel(m)}>{menuLabel(m)}</Tooltip>,
        key: m,
        width: 96,
        align: "center" as const,
        render: (_: unknown, r: UsageOverview["users"][number]) => {
          const v = r.menus[m] || 0;
          if (!v) return <span style={{ color: isDark ? "#4b5563" : "#d1d5db" }}>—</span>;
          // 色深按相对热度线性映射（0.10~0.75），既看得出深浅又不至于糊成一片
          const alpha = 0.1 + 0.65 * (v / matrixMax);
          return (
            <span
              style={{
                display: "inline-block",
                minWidth: 40,
                padding: "1px 6px",
                borderRadius: 4,
                background: `rgba(59, 130, 246, ${alpha.toFixed(2)})`,
                color: alpha > 0.45 ? "#fff" : undefined,
              }}
            >
              {v}
            </span>
          );
        },
      })),
      {
        title: "合计",
        key: "total",
        fixed: "right" as const,
        width: 80,
        align: "center" as const,
        sorter: (a: UsageOverview["users"][number], b: UsageOverview["users"][number]) => a.total - b.total,
        defaultSortOrder: "descend" as const,
        render: (_: unknown, r: UsageOverview["users"][number]) => <b>{r.total}</b>,
      },
    ];
  }, [data?.menus, matrixMax, isDark]);

  const eventColumns = [
    {
      title: "时间",
      dataIndex: "ts",
      width: 150,
      render: (v: string) => dayjs(v).format("MM-DD HH:mm"),
    },
    {
      title: "用户",
      dataIndex: "user_name",
      width: 140,
      render: (v: string, r: UsageEventRow) => (
        <Space size={6}>
          <span>{v}</span>
          <Tag style={{ marginInlineEnd: 0 }}>{ROLE_LABELS[r.role || ""] || r.role || "—"}</Tag>
        </Space>
      ),
    },
    { title: "模块", dataIndex: "menu", width: 120, render: (v: string) => menuLabel(v) },
    {
      title: "终端",
      dataIndex: "platform",
      width: 80,
      render: (v: string | null) => (v === "mobile" ? "手机" : "电脑"),
    },
    { title: "动态", dataIndex: "detail", render: (v: string | null) => detailText(v) },
  ];

  const cards = data?.cards;
  const hasData = !!data && (data.ranking.length > 0 || data.users.some((u) => u.total > 0));

  return (
    <div className="page-fill logs-page">
      {/* 统计区：只能用 page-stats / stat / stat-icon / stat-num / stat-label 这套既定结构 */}
      <div className="page-stats" style={{ marginBottom: 16 }}>
        <div className="stat">
          <span className="stat-icon is-neutral"><TeamOutlined /></span>
          <span className="stat-body">
            <span className="stat-num is-neutral">
              <AnimatedNumber value={cards?.activeUsers || 0} format={(n) => Math.round(n).toLocaleString("zh-CN")} />
            </span>
            <span className="stat-label">今日活跃账号</span>
          </span>
        </div>
        <div className="stat">
          <span className="stat-icon is-warn"><ThunderboltOutlined /></span>
          <span className="stat-body">
            <span className="stat-num is-warn">
              <AnimatedNumber value={cards?.totalViews || 0} format={(n) => Math.round(n).toLocaleString("zh-CN")} />
            </span>
            <span className="stat-label">今日总访问</span>
          </span>
        </div>
        <div className="stat">
          <span className="stat-icon is-good"><BarChartOutlined /></span>
          <span className="stat-body">
            {/* 模块名是文字不能做数字滚动，直接渲染 */}
            <span className="stat-num is-good" style={{ fontSize: 22 }}>
              {cards?.topMenu ? menuLabel(cards.topMenu) : "—"}
            </span>
            <span className="stat-label">今日最热模块</span>
          </span>
        </div>
        <div className="stat">
          <span className="stat-icon is-neutral"><AppstoreOutlined /></span>
          <span className="stat-body">
            <span className="stat-num is-neutral">
              <AnimatedNumber value={cards?.avgMenus || 0} format={(n) => n.toFixed(1)} />
            </span>
            <span className="stat-label">今日人均模块数</span>
          </span>
        </div>
      </div>

      {/* 搜索区（约定：只放搜索字段） */}
      <Card className="search-card" style={{ marginBottom: 16 }}>
        <div className="search-grid">
          <div className="search-field">
            <span className="search-label">统计周期</span>
            <div className="search-control">
              <Select
                value={draftDays}
                onChange={setDraftDays}
                options={TIME_RANGES}
              />
            </div>
          </div>
          <div className="search-field">
            <span className="search-label">模块</span>
            <div className="search-control">
              <Select
                allowClear
                placeholder="全部模块"
                value={draftMenu || undefined}
                onChange={(v) => setDraftMenu(v || "")}
                options={Object.entries(MENU_LABELS).map(([value, label]) => ({ value, label }))}
              />
            </div>
          </div>
        </div>
      </Card>

      <Card className="list-card">
        {/* 工具行：左说明，右侧重置 / 查询（查询最右） */}
        <div className="toolbar">
          <Space size={4} wrap>
            <BarChartOutlined />
            <span style={{ fontSize: 13 }}>模块点击率</span>
            <Tooltip title="访问次数=同一模块被打开的累计次数（来回切会重复计）；使用人数为去重账号数；停留时长只计页面在前台的时间。数据由前端每 30 秒批量上报一次，最新一次操作最长延迟 30 秒可见">
              <span className="logs-sec-tip">统计口径</span>
            </Tooltip>
          </Space>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={handleReset}>重置</Button>
            <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>查询</Button>
          </Space>
        </div>

        {loading ? (
          <div style={{ textAlign: "center", padding: "4rem" }}><Spin size="large" /></div>
        ) : !hasData ? (
          <Empty
            description={
              days > 7
                ? "该周期内还没有使用记录，或所选模块无人访问"
                : "还没有采集到使用数据。打开几个菜单后，最长 30 秒就会出现记录"
            }
          />
        ) : (
          <>
            {/* 模块热度排行 */}
            <div className="logs-section">
              <div className="logs-sec-head">
                <span className="logs-sec-title">模块热度排行</span>
                <span className="logs-sec-tip">近 {days} 天访问次数（含未启用模块则不计）</span>
              </div>
              {(data?.ranking.length || 0) > 0 ? (
                <Chart option={rankOption} height={Math.max(200, Math.min(data!.ranking.length, 12) * 34 + 24)} />
              ) : (
                <Empty description="该周期内没有模块访问" />
              )}
            </div>

            {/* 活跃趋势 */}
            <div className="logs-section">
              <div className="logs-sec-head">
                <span className="logs-sec-title">
                  <LineChartOutlined /> 活跃趋势
                </span>
                <span className="logs-sec-tip">近 {days} 天每日访问次数与使用人数</span>
              </div>
              {trendOption ? <Chart option={trendOption} height={240} /> : <Empty />}
            </div>

            {/* 用户 × 模块矩阵 */}
            <div className="logs-section">
              <div className="logs-sec-head">
                <span className="logs-sec-title">
                  <ProfileOutlined /> 用户使用分布
                </span>
                <span className="logs-sec-tip">颜色越深用得越多；「—」表示该周期内没打开过该模块</span>
              </div>
              <Table
                rowKey="id"
                size="small"
                columns={matrixColumns as any}
                dataSource={data?.users || []}
                pagination={false}
                scroll={{ x: 160 + Math.min(data?.menus.length || 0, 12) * 96 + 80 }}
              />
            </div>

            {/* 行为明细 */}
            <div className="logs-section">
              <div className="logs-sec-head">
                <span className="logs-sec-title">上报明细</span>
                <span className="logs-sec-tip">按上报批次记录，保留 30 天</span>
              </div>
              <Table<UsageEventRow>
                rowKey="id"
                size="small"
                loading={eventLoading}
                columns={eventColumns}
                dataSource={events}
                pagination={{
                  current: eventPage,
                  total: eventTotal,
                  pageSize: 10,
                  showSizeChanger: false,
                  onChange: (p) => { setEventPage(p); fetchEvents(p); },
                }}
                scroll={{ x: 760 }}
              />
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
