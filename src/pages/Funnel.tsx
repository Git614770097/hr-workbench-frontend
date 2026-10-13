import { useState, useEffect, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import {
  Card, Button, Select, Space, Row, Col, Empty, Spin, Tooltip, message, Table,
  Alert, Segmented, Skeleton,
} from "antd";
import {
  ReloadOutlined, SearchOutlined, FunnelPlotOutlined, DownloadOutlined,
  RiseOutlined, TeamOutlined,
  InfoCircleOutlined, AppstoreOutlined, CalendarOutlined, AimOutlined,
  UserAddOutlined, FileTextOutlined, LineChartOutlined, PictureOutlined,
  FileExcelOutlined, AlertOutlined,
} from "@ant-design/icons";
import * as echarts from "echarts/core";
import { api } from "../api";
import { downloadBlob, dateStamp, csvCell, exportXlsx } from "../utils/file";
import type {
  FunnelResponse, FunnelStayItem, Job, User, OverviewResponse, TrendResponse,
  WorkbenchModuleKey,
} from "../types";
import { INTERVIEW_ROUND_LABELS } from "../types";
import FunnelChartView from "../components/FunnelChart";
import OverviewPanel from "../components/OverviewPanel";
import WorkbenchTrendChart from "../components/WorkbenchTrendChart";
import WorkbenchModulesModal from "../components/WorkbenchModulesModal";
import AnimatedNumber from "../components/AnimatedNumber";
import { useIdentityProfile } from "../useIdentity";
import { termFor } from "../identityProfiles";
import { loadWorkbenchConfig, saveWorkbenchConfig } from "../workbenchPrefs";

// 周期指标的配色（与漏斗同一套柔和色系，暗色模式取亮档）
const KPI_COLORS_LIGHT = ["#2563eb", "#0891b2", "#d97706", "#059669"];
const KPI_COLORS_DARK = ["#60a5fa", "#22d3ee", "#fbbf24", "#34d399"];

// 周期表行（精简版：不再用 4 张大数值卡，改为紧凑表格）
const CYCLE_ROWS = [
  { key: "tti", title: "简历到首面" },
  { key: "to_offer", title: "面试到 Offer" },
  { key: "to_hire", title: "Offer 到入职" },
  { key: "total", title: "全流程周期" },
] as const;

// 构成条三段
const SEG_NAMES = ["入库→首面", "首面→Offer", "Offer→入职"];

const TIME_RANGES = [
  { label: "全部时间", value: 0 },
  { label: "近 30 天", value: 30 },
  { label: "近 90 天", value: 90 },
  { label: "近 180 天", value: 180 },
];

const pct = (v: number) => `${(v * 100).toFixed(v >= 0.1 || v === 0 ? 0 : 1)}%`;
const dayText = (v: number | null) => (v == null ? "—" : `${v}`);
const r1 = (v: number) => Math.round(v * 10) / 10;

/** 客户端中国时区今天 YYYY-MM-DD */
function todayCnStr(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/** 到期日 → 「今天 / 明天 / N 天后 / 已过期 x 天」 */
function dueLabel(dateStr: string, today: string): string {
  const a = Date.parse(dateStr + "T00:00:00Z");
  const b = Date.parse(today + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return dateStr;
  const d = Math.round((a - b) / 86400000);
  if (d < 0) return `已过期 ${-d} 天`;
  if (d === 0) return "今天";
  if (d === 1) return "明天";
  if (d === 2) return "后天";
  return `${d} 天后`;
}

export default function Funnel() {
  const profile = useIdentityProfile();
  const [data, setData] = useState<FunnelResponse | null>(null);
  const [jobs, setJobs] = useState<Pick<Job, "id" | "title" | "status">[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);

  // ---- 工作台：行动层数据 ----
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [ovLoading, setOvLoading] = useState(true);

  // ---- 工作台：趋势折线 ----
  const [trend, setTrend] = useState<TrendResponse | null>(null);
  const [trendGran, setTrendGran] = useState<"week" | "day">("week");
  const [trendLoading, setTrendLoading] = useState(true);

  // ---- 工作台：模块显隐 ----
  const [hidden, setHidden] = useState<WorkbenchModuleKey[]>([]);
  const [cfgOpen, setCfgOpen] = useState(false);

  // ---- 图表实例（供「下载 PNG」）----
  const funnelChartRef = useRef<echarts.ECharts | null>(null);
  const trendChartRef = useRef<echarts.ECharts | null>(null);

  // 已应用的条件（点「查询」才生效）
  const [jobFilter, setJobFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [daysFilter, setDaysFilter] = useState(0);
  // 草稿条件
  const [draftJob, setDraftJob] = useState("");
  const [draftOwner, setDraftOwner] = useState("");
  const [draftDays, setDraftDays] = useState(0);

  const currentUser: User | null = (() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  })();
  const isAdmin = currentUser?.role === "admin";

  const isHidden = (k: WorkbenchModuleKey) => hidden.includes(k);

  // 跟随全局主题（html[data-theme-mode]，配 ECharts 文字色/描边色）
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

  // ---- 漏斗数据（分析层）----
  const fetchFunnel = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getFunnel({
        job_id: jobFilter || undefined,
        owner_id: ownerFilter || undefined,
        days: daysFilter || undefined,
      });
      setData(res);
    } catch (err) {
      message.error((err as Error).message);
    }
    setLoading(false);
  }, [jobFilter, ownerFilter, daysFilter]);

  useEffect(() => { fetchFunnel(); }, [fetchFunnel]);

  // ---- 行动层数据（轻量，随首屏一起拉）----
  useEffect(() => {
    let alive = true;
    setOvLoading(true);
    api.getOverview()
      .then((r) => { if (alive) setOverview(r); })
      .catch(() => { /* 行动层失败不阻塞页面 */ })
      .finally(() => { if (alive) setOvLoading(false); });
    return () => { alive = false; };
  }, []);

  // ---- 趋势折线 ----
  useEffect(() => {
    let alive = true;
    setTrendLoading(true);
    api.getTrend(trendGran)
      .then((r) => { if (alive) setTrend(r); })
      .catch(() => { /* 趋势失败不阻塞 */ })
      .finally(() => { if (alive) setTrendLoading(false); });
    return () => { alive = false; };
  }, [trendGran]);

  // ---- 模块显隐配置（存后端用户设置）----
  useEffect(() => {
    let alive = true;
    loadWorkbenchConfig(currentUser).then((cfg) => {
      if (alive) setHidden(cfg.hidden);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateHidden = (h: WorkbenchModuleKey[]) => {
    setHidden(h);
    saveWorkbenchConfig({ hidden: h }).then((ok) => {
      if (!ok) message.warning("已更新，但同步到账号失败（下次登录可能还原）");
    });
  };

  useEffect(() => {
    api.getJobOptions().then(setJobs).catch(() => {});
    if (isAdmin) api.getUsers().then(setUsers).catch(() => {});
  }, [isAdmin]);

  const applySearch = () => {
    setJobFilter(draftJob);
    setOwnerFilter(draftOwner);
    setDaysFilter(draftDays);
  };

  const resetSearch = () => {
    setDraftJob(""); setDraftOwner(""); setDraftDays(0);
    setJobFilter(""); setOwnerFilter(""); setDaysFilter(0);
  };

  const filtered = !!(jobFilter || ownerFilter || daysFilter);

  const s = data?.summary;
  const stages = data?.stages || [];

  // 耗时构成三段
  const segRaw = data ? [data.cycles.segments.s1, data.cycles.segments.s2, data.cycles.segments.s3] : [];
  const segs: { name: string; days: number }[] =
    segRaw.length === 3 && segRaw.every((d): d is number => d != null)
      ? segRaw.map((d, i) => ({ name: SEG_NAMES[i], days: d }))
      : [];
  const segTotal = segs.length ? segs.reduce((a, b) => a + b.days, 0) : null;

  // 各阶段停留明细（表格用）
  const stayMap: Record<string, FunnelStayItem> = Object.fromEntries(
    (data?.stage_stay || []).map((x) => [x.key, x])
  );

  const today = todayCnStr();
  const overdue = overview?.tasks.overdue ?? 0;
  const dueSoon = overview?.dueSoonTasks ?? [];
  const todayIv = overview?.todayInterviews ?? [];

  // ---- 诊断提示（原「结论」卡精简为漏斗下方的一段提示）----
  const diagnosis: string[] = (() => {
    if (!data || !s || stages.length < 2) return [];
    const hints: string[] = [];
    const bottleneck = stages
      .slice(1)
      .reduce((min, cur) => (cur.rate < min.rate ? cur : min), stages[1]);
    if (bottleneck) {
      hints.push(
        `转化最弱一环「${stages[stages.indexOf(bottleneck) - 1]?.label} → ${bottleneck.label}」仅 ${pct(bottleneck.rate)}，流失 ${bottleneck.drop} 人`
      );
    }
    const tc = data.cycles.total;
    if (tc.avg != null && tc.avg > 35) hints.push(`全流程平均 ${tc.avg} 天偏慢（中位 ${dayText(tc.p50)} 天）`);
    if (tc.p50 != null && tc.p90 != null && tc.p50 > 0 && tc.p90 >= tc.p50 * 2) {
      hints.push(`周期长尾明显：P90 是中位的 ${(tc.p90 / tc.p50).toFixed(1)} 倍，少数人在拖慢整体`);
    }
    if (segTotal) {
      const worst = segs.reduce((m, x) => (x.days > m.days ? x : m), segs[0]);
      hints.push(`耗时主要花在「${worst.name}」${r1(worst.days)} 天`);
    }
    return hints.slice(0, 3);
  })();

  // ---- 图表 PNG 下载 ----
  const downloadPng = (inst: echarts.ECharts | null, name: string) => {
    if (!inst) { message.warning("图表尚未就绪，请稍后再试"); return; }
    const url = inst.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: "#ffffff" });
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}_${dateStamp()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  /** 导出招聘漏斗全量数据（CSV 五段，保留原有能力） */
  const exportFunnel = () => {
    if (!data || !s) return;
    const rows: string[] = [];
    const timeLabel = TIME_RANGES.find((t) => t.value === daysFilter)?.label || "全部时间";
    const jobLabel = jobs.find((j) => j.id === jobFilter)?.title || termFor(profile, "全部岗位");

    rows.push(termFor(profile, "招聘漏斗数据导出"));
    rows.push([termFor(profile, `岗位：${jobLabel}`), `时间范围：${timeLabel}`, `导出时间：${new Date().toLocaleString("zh-CN")}`].map(csvCell).join(","));
    rows.push("");

    rows.push("【漏斗概览】");
    rows.push("进入流程,进行中,已入职,已淘汰,已放弃,整体转化率");
    rows.push([s.total, s.in_progress, s.hired, s.rejected, s.withdrawn, pct(s.overall_rate)].map(csvCell).join(","));
    rows.push("");

    rows.push("【阶段漏斗】（人数按「曾到达」口径：到过该阶段即计入）");
    rows.push("阶段,人数,环比转化率,环比流失,累计转化率,平均停留天数");
    for (let i = 0; i < stages.length; i++) {
      const st = stages[i];
      const stay = stayMap[st.key];
      rows.push([
        st.label,
        st.count,
        i === 0 ? "—" : pct(st.rate),
        st.drop > 0 ? st.drop : "—",
        pct(st.overall_rate),
        stay?.avg_days != null ? `${stay.avg_days} 天` : "—",
      ].map(csvCell).join(","));
    }
    rows.push("");

    rows.push(termFor(profile, "【渠道效果】（人·岗位口径：同一人才多岗位分别计）"));
    rows.push("来源渠道,进入流程,进行中,已入职,已淘汰,已放弃,入职转化率,平均周期(天)");
    for (const src of data.sources || []) {
      rows.push([
        src.source, src.entered, src.in_progress, src.hired, src.rejected, src.withdrawn,
        pct(src.rate), src.avg_cycle_days != null ? src.avg_cycle_days : "—",
      ].map(csvCell).join(","));
    }
    rows.push("");

    rows.push("【淘汰原因分布】");
    rows.push("原因,人次");
    for (const r of data.reject_reasons || []) {
      rows.push([r.reason, r.count].map(csvCell).join(","));
    }
    rows.push("");

    rows.push("【周期指标】（天，均值易被长尾拉偏，请配合 p50/p90 解读）");
    rows.push("指标,均值,p50,p90,最长,最短,样本数");
    const cycles: [string, FunnelResponse["cycles"]["tti"]][] = [
      ["简历入库 → 首次面试", data.cycles.tti],
      ["首次面试 → Offer", data.cycles.to_offer],
      ["Offer → 入职", data.cycles.to_hire],
      ["入库 → 入职（全程）", data.cycles.total],
    ];
    for (const [name, c] of cycles) {
      rows.push([name, c.avg, c.p50, c.p90, c.max, c.min, c.n].map(csvCell).join(","));
    }

    const blob = new Blob(["\ufeff" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
    downloadBlob(blob, `${termFor(profile, "招聘漏斗")}_${dateStamp()}.csv`);
    message.success(termFor(profile, "已导出招聘漏斗数据"));
  };

  /** 导出「汇报 Excel」：KPI / 趋势 / 漏斗 / 渠道 / 周期 / 停留 / 淘汰 多 sheet */
  const exportWorkbook = async () => {
    if (!data || !s) { message.warning("暂无数据可导出"); return; }
    const sheets = [
      {
        name: "关键指标",
        columns: [{ header: "指标", key: "k", width: 20 }, { header: "数值", key: "v", width: 16 }],
        rows: [
          { k: "在招岗位", v: overview?.openJobs ?? 0 },
          { k: "人才库总数", v: overview?.totalTalents ?? 0 },
          { k: "待推进候选人", v: overview?.activeCandidates ?? 0 },
          { k: "本周新增人才", v: overview?.weeklyNewTalents ?? 0 },
          { k: "今日面试", v: overview?.todayInterviewCount ?? 0 },
          { k: "待办待处理", v: overview?.tasks.pending ?? 0 },
          { k: "待办已逾期", v: overview?.tasks.overdue ?? 0 },
          { k: "进入流程（累计）", v: s.total },
          { k: "已入职（累计）", v: s.hired },
          { k: "整体转化率", v: pct(s.overall_rate) },
          { k: "全流程平均周期(天)", v: data.cycles.total.avg ?? "—" },
        ],
      },
    ] as { name: string; columns: { header: string; key: string; width?: number }[]; rows: Record<string, string | number>[] }[];

    if (trend) {
      sheets.push({
        name: "趋势",
        columns: [
          { header: trend.granularity === "week" ? "周" : "日期", key: "x", width: 14 },
          ...trend.series.map((se) => ({ header: se.label, key: se.key, width: 12 })),
        ],
        rows: trend.labels.map((lb, i) => {
          const row: Record<string, string | number> = { x: lb };
          for (const se of trend.series) row[se.key] = se.data[i] ?? 0;
          return row;
        }),
      });
    }

    sheets.push({
      name: "阶段漏斗",
      columns: [
        { header: "阶段", key: "label", width: 14 },
        { header: "人数(曾到达)", key: "count", width: 12 },
        { header: "环比转化率", key: "rate", width: 12 },
        { header: "环比流失", key: "drop", width: 10 },
        { header: "累计转化率", key: "overall", width: 12 },
        { header: "平均停留(天)", key: "stay", width: 12 },
      ],
      rows: stages.map((st, i) => ({
        label: st.label,
        count: st.count,
        rate: i === 0 ? "—" : pct(st.rate),
        drop: st.drop,
        overall: pct(st.overall_rate),
        stay: stayMap[st.key]?.avg_days ?? "—",
      })),
    });

    if (data.sources.length) {
      sheets.push({
        name: "渠道效果",
        columns: [
          { header: "来源渠道", key: "source", width: 14 },
          { header: "进入", key: "entered", width: 10 },
          { header: "进行中", key: "in_progress", width: 10 },
          { header: "入职", key: "hired", width: 10 },
          { header: "转化率", key: "rate", width: 10 },
          { header: "平均周期(天)", key: "cycle", width: 12 },
        ],
        rows: data.sources.map((src) => ({
          source: src.source,
          entered: src.entered,
          in_progress: src.in_progress,
          hired: src.hired,
          rate: pct(src.rate),
          cycle: src.avg_cycle_days ?? "—",
        })),
      });
    }

    sheets.push({
      name: "周期指标",
      columns: [
        { header: "指标", key: "name", width: 22 },
        { header: "均值(天)", key: "avg", width: 10 },
        { header: "中位(天)", key: "p50", width: 10 },
        { header: "P90(天)", key: "p90", width: 10 },
        { header: "最长", key: "max", width: 8 },
        { header: "最短", key: "min", width: 8 },
        { header: "样本数", key: "n", width: 8 },
      ],
      rows: [
        { name: "简历入库 → 首次面试", ...data.cycles.tti },
        { name: "首次面试 → Offer", ...data.cycles.to_offer },
        { name: "Offer → 入职", ...data.cycles.to_hire },
        { name: "入库 → 入职（全程）", ...data.cycles.total },
      ].map((c) => ({
        name: c.name,
        avg: c.avg ?? "—", p50: c.p50 ?? "—", p90: c.p90 ?? "—",
        max: c.max ?? "—", min: c.min ?? "—", n: c.n,
      })),
    });

    if (data.reject_reasons.length) {
      sheets.push({
        name: "淘汰原因",
        columns: [
          { header: "原因", key: "reason", width: 18 },
          { header: "人次", key: "count", width: 10 },
        ],
        rows: data.reject_reasons.map((r) => ({ reason: r.reason, count: r.count })),
      });
    }

    try {
      await exportXlsx(`招聘汇报_${dateStamp()}.xlsx`, sheets);
      message.success("已导出汇报 Excel");
    } catch {
      message.error("导出失败，请重试");
    }
  };

  const analysisReady = !loading && !!s && s.total > 0;

  return (
    <div className="funnel-page workbench-page">
      {/* ===== 顶部操作行：快捷入口 + 调整模块 ===== */}
      <div className="wb-topbar">
        <div className="wb-quick">
          {!isHidden("quick_actions") && (
            <>
              <Link to="/talents" className="btn-as-link"><SearchOutlined />{termFor(profile, "搜人才")}</Link>
              <Link to="/pipeline" className="btn-as-link"><UserAddOutlined />{termFor(profile, "加候选人")}</Link>
              <Link to="/jobs" className="btn-as-link"><FileTextOutlined />发 JD</Link>
              <Link to="/interviews" className="btn-as-link"><CalendarOutlined />面试安排</Link>
            </>
          )}
        </div>
        <Button icon={<AppstoreOutlined />} onClick={() => setCfgOpen(true)}>调整模块</Button>
      </div>

      {/* ===== 行动层：左「今日重点」+ 右 KPI 快照（栅格与分析层同源：xl 14/10） ===== */}
      {(!isHidden("today_focus") || !isHidden("kpi_band")) && (
        <Row gutter={[16, 16]} className="wb-hero">
          {/* 左栏：今日重点（两栏：今日面试 / 近 3 天到期） */}
          {!isHidden("today_focus") && (
            <Col xs={24} xl={14}>
              {overview ? (
                <Card className="wb-focus-card" title="今日重点" styles={{ body: { padding: "14px 18px" } }}>
                <div className="wb-focus">
                  <div className="wb-focus-col">
                    <div className="wb-focus-head">
                      <span className="wb-focus-title"><CalendarOutlined /> 今日面试</span>
                      <span className="wb-focus-count">{overview.todayInterviewCount}</span>
                    </div>
                    {todayIv.length === 0 ? (
                      <div className="wb-focus-empty">今天没有安排面试</div>
                    ) : (
                      <div className="wb-focus-body">
                        {todayIv.slice(0, 6).map((iv) => (
                          <div className="wb-focus-item" key={iv.id}>
                            <span className="wb-focus-time">{(iv.scheduled_at || "").slice(11, 16)}</span>
                            <span className="wb-focus-main">
                              <b>{iv.talent_name}</b>
                              <span className="wb-focus-sub">
                                {INTERVIEW_ROUND_LABELS[iv.round as keyof typeof INTERVIEW_ROUND_LABELS] || iv.round}
                                {iv.job_title ? ` · ${iv.job_title}` : ""}
                              </span>
                            </span>
                          </div>
                        ))}
                        {todayIv.length > 6 && (
                          <Link to="/interviews" className="wb-focus-more">还有 {todayIv.length - 6} 场 →</Link>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="wb-focus-col">
                    <div className="wb-focus-head">
                      <span className="wb-focus-title"><AlertOutlined /> 近 3 天到期</span>
                      <span className="wb-focus-head-right">
                        {overdue > 0 && (
                          <Link to="/tasks" className="wb-focus-overdue" title={`${overdue} 项待办已逾期，建议优先清理`}>
                            {overdue} 项逾期
                          </Link>
                        )}
                        <span className="wb-focus-count is-warn">{dueSoon.length}</span>
                      </span>
                    </div>
                    {dueSoon.length === 0 ? (
                      <div className="wb-focus-empty">近 3 天没有到期待办</div>
                    ) : (
                      <div className="wb-focus-body">
                        {dueSoon.slice(0, 6).map((t) => (
                          <div className="wb-focus-item" key={t.id}>
                            <span className="wb-focus-time is-warn">{dueLabel(t.due_date, today)}</span>
                            <span className="wb-focus-main">
                              <b>{t.title}</b>
                              {t.talent_name && <span className="wb-focus-sub">{t.talent_name}</span>}
                            </span>
                          </div>
                        ))}
                        {dueSoon.length > 6 && (
                          <Link to="/tasks" className="wb-focus-more">还有 {dueSoon.length - 6} 项 →</Link>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            ) : (
              ovLoading ? <Card className="wb-hero-skel"><Skeleton active paragraph={{ rows: 3 }} /></Card> : null
            )}
            </Col>
          )}

          {/* 右栏：KPI 快照 2×2 */}
          {!isHidden("kpi_band") && (
            <Col xs={24} xl={10}>
              <div className="page-stats wb-kpi">
                <div className="stat">
                  <span className="stat-icon is-neutral"><AimOutlined /></span>
                  <span className="stat-body">
                    <span className="stat-num is-neutral"><AnimatedNumber value={overview?.openJobs ?? 0} format={(n) => Math.round(n).toLocaleString("zh-CN")} /></span>
                    <span className="stat-label">{termFor(profile, "在招岗位")}</span>
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-icon is-neutral"><TeamOutlined /></span>
                  <span className="stat-body">
                    <span className="stat-num"><AnimatedNumber value={overview?.activeCandidates ?? 0} format={(n) => Math.round(n).toLocaleString("zh-CN")} /></span>
                    <span className="stat-label">{termFor(profile, "待推进")}</span>
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-icon is-good"><RiseOutlined /></span>
                  <span className="stat-body">
                    <span className="stat-num is-good"><AnimatedNumber value={overview?.weeklyNewTalents ?? 0} format={(n) => Math.round(n).toLocaleString("zh-CN")} /></span>
                    <span className="stat-label">本周新增</span>
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-icon is-warn"><CalendarOutlined /></span>
                  <span className="stat-body">
                    <span className="stat-num is-warn"><AnimatedNumber value={overview?.todayInterviewCount ?? 0} format={(n) => Math.round(n).toLocaleString("zh-CN")} /></span>
                    <span className="stat-label">今日面试</span>
                  </span>
                </div>
              </div>
            </Col>
          )}
        </Row>
      )}

      {/* ===== 分析层：招聘概览 ===== */}
      <div className="wb-section-head">
        <span className="wb-section-title"><FunnelPlotOutlined /> {termFor(profile, "招聘概览")}</span>
        <Space wrap size={8}>
          {!isHidden("trend") && (
            <Segmented
              className="app-pill-seg"
              size="small"
              value={trendGran}
              onChange={(v) => setTrendGran(v as "week" | "day")}
              options={[{ label: "近 12 周", value: "week" }, { label: "近 30 天", value: "day" }]}
            />
          )}
          <Button size="small" icon={<FileExcelOutlined />} onClick={exportWorkbook} disabled={!data}>导出汇报 Excel</Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={exportFunnel} disabled={!data}>导出数据</Button>
        </Space>
      </div>

      {/* 筛选（作用于下方分析层） */}
      <Card className="search-card" style={{ marginBottom: 16 }} styles={{ body: { padding: 16 } }}>
        <div className="search-grid">
          <div className="search-field">
            <span className="search-label">{termFor(profile, "岗位")}</span>
            <div className="search-control">
            <Select
              style={{ width: "100%" }} allowClear placeholder={termFor(profile, "全部岗位")}
              value={draftJob || undefined}
              onChange={(v) => setDraftJob(v || "")}
              options={jobs.map((j) => ({
                label: j.status === "closed" ? `${j.title}（已关闭）` : j.title,
                value: j.id,
              }))}
              showSearch
              optionFilterProp="label"
            />
            </div>
          </div>
          <div className="search-field">
            <span className="search-label">时间范围</span>
            <div className="search-control">
            <Select
              style={{ width: "100%" }}
              value={draftDays}
              onChange={(v) => setDraftDays(v)}
              options={TIME_RANGES}
            />
            </div>
          </div>
          {isAdmin && (
            <div className="search-field">
              <span className="search-label">创建人</span>
              <div className="search-control">
              <Select
                style={{ width: "100%" }} allowClear placeholder="全部"
                value={draftOwner || undefined}
                onChange={(v) => setDraftOwner(v || "")}
                options={users.map((u) => ({ label: u.name, value: u.id }))}
                showSearch
                optionFilterProp="label"
              />
              </div>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
            <Button icon={<ReloadOutlined />} onClick={resetSearch}>重置</Button>
            <Button type="primary" icon={<SearchOutlined />} onClick={applySearch}>查询</Button>
          </div>
        </div>
      </Card>

      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem" }}><Spin size="large" /></div>
      ) : !analysisReady ? (
        <Card className="list-card">
          <Empty
            description={
              filtered
                ? termFor(profile, "当前筛选条件下没有数据，试试放宽岗位或时间范围")
                : termFor(profile, "还没有人才进入招聘看板，先去把人挂到岗位上，这里就会有数据了")
            }
          >
            <Link to="/pipeline" className="btn-as-primary">
              {termFor(profile, "去招聘看板录入")}
            </Link>
          </Empty>
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          {/* ===== 左：图表主区 ===== */}
          <Col xs={24} xl={14}>
            {/* 趋势折线 */}
            {!isHidden("trend") && (
              <Card
                title={<Space><LineChartOutlined />招聘趋势</Space>}
                styles={{ body: { padding: "12px 16px" } }}
                extra={
                  <Tooltip title="新增人才=talents 入库；进入面试=曾到达「初试」；入职=曾到达「已入职」。与漏斗同源。">
                    <Button
                      size="small" type="text" icon={<PictureOutlined />}
                      onClick={() => downloadPng(trendChartRef.current, "招聘趋势")}
                    >PNG</Button>
                  </Tooltip>
                }
              >
                {trendLoading && !trend ? (
                  <Skeleton active paragraph={{ rows: 4 }} />
                ) : (
                  <WorkbenchTrendChart data={trend} dark={isDark} height={260} chartOut={trendChartRef} />
                )}
              </Card>
            )}

            {/* 转化漏斗 */}
            {!isHidden("funnel") && (
              <Card
                title={<Space><FunnelPlotOutlined />转化漏斗</Space>}
                style={{ marginTop: isHidden("trend") ? 0 : 16 }}
                styles={{ body: { padding: "20px 24px" } }}
                extra={
                  <Space size={12}>
                    <Tooltip title="阶段人数按「曾到达」统计：只要候选人到过该阶段就计入，因此漏斗逐级递减，不会因为后期淘汰而回退">
                      <span style={{ fontSize: 12, color: "#8c8c8c" }}>统计口径说明</span>
                    </Tooltip>
                    <Tooltip title="下载高清 PNG（白底，可直接贴进汇报 PPT）">
                      <Button
                        size="small" type="text" icon={<PictureOutlined />}
                        onClick={() => downloadPng(funnelChartRef.current, "转化漏斗")}
                      >PNG</Button>
                    </Tooltip>
                  </Space>
                }
              >
                <FunnelChartView
                  stages={stages}
                  stageStay={data!.stage_stay}
                  dark={isDark}
                  height={stages.length * 100 + 56}
                  chartOut={funnelChartRef}
                />

                <div className="funnel-branches">
                  <div className="funnel-branch">
                    <span className="funnel-dot" style={{ background: "#ef4444" }} />
                    已淘汰
                    <b style={{ color: "#ef4444", marginLeft: 6 }}>{s!.rejected}</b> 人
                  </div>
                  <div className="funnel-branch">
                    <span className="funnel-dot" style={{ background: "#94a3b8" }} />
                    已放弃
                    <b style={{ color: "#94a3b8", marginLeft: 6 }}>{s!.withdrawn}</b> 人
                  </div>
                  <span className="funnel-branch-tip">
                    {termFor(profile, "（终态分支不计入漏斗主线，人才可能在任何一级进入终态）")}
                  </span>
                </div>

                {/* 诊断提示（原「结论」卡精简而来） */}
                {diagnosis.length > 0 && (
                  <div className="wb-diagnosis">
                    {diagnosis.map((h, i) => (
                      <div className="wb-diagnosis-line" key={i}>· {h}</div>
                    ))}
                  </div>
                )}

                <div className="funnel-caliber">
                  <InfoCircleOutlined /> 统计口径：各阶段人数按「<b>曾到达</b>」统计 —— 候选人只要到过该阶段就计入，因此漏斗逐级递减、不会因后期淘汰而回退；已淘汰 / 已放弃属于终态分支，单独计列，不计入主线。
                </div>
              </Card>
            )}

            {/* 渠道效果 */}
            {!isHidden("sources") && data!.sources.length > 0 && (
              <Card
                title={<Space><TeamOutlined />渠道效果</Space>}
                style={{ marginTop: 16 }}
                styles={{ body: { padding: "16px 18px" } }}
                extra={
                  <Tooltip title={termFor(profile, "按人才来源统计各阶段分布与入职转化、平均招聘周期；同一人才投多个岗位按投递记录分别计入，与漏斗口径一致。来源在人才库「来源渠道」字段或导入简历时维护。")}>
                    <span style={{ fontSize: 12, color: "#8c8c8c" }}>口径说明</span>
                  </Tooltip>
                }
              >
                {(() => {
                  const unknown = data!.sources.find((x) => x.source === "未记录");
                  const total = data!.sources.reduce((a, x) => a + x.entered, 0);
                  if (!unknown || total === 0 || unknown.entered / total <= 0.4) return null;
                  return (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message={termFor(profile, `有 ${unknown.entered} 条候选人未记录来源（占 ${pct(unknown.entered / total)}），统计可能失真。新导入可在「导入简历」时选择本批来源，存量可在人才库编辑补录`)}
                    />
                  );
                })()}
                <Table
                  size="small"
                  pagination={false}
                  rowKey="source"
                  dataSource={data!.sources}
                  columns={[
                    {
                      title: "来源渠道", dataIndex: "source",
                      render: (v: string) => <span style={{ fontWeight: 600 }}>{v}</span>,
                    },
                    { title: "进入", dataIndex: "entered", align: "right" },
                    { title: "进行中", dataIndex: "in_progress", align: "right" },
                    {
                      title: "入职", dataIndex: "hired", align: "right",
                      render: (v: number) => <b style={{ color: "#10b981" }}>{v}</b>,
                    },
                    {
                      title: "转化率", dataIndex: "rate", align: "right",
                      render: (v: number) => (
                        <b style={{ color: v >= 0.3 ? "#10b981" : v > 0 ? "#d48806" : "#8c8c8c" }}>{pct(v)}</b>
                      ),
                    },
                    {
                      title: "平均周期", dataIndex: "avg_cycle_days", align: "right",
                      render: (v: number | null) => (v == null ? "—" : `${v} 天`),
                    },
                  ]}
                />
              </Card>
            )}
          </Col>

          {/* ===== 右：分析窄栏（精简后）===== */}
          <Col xs={24} xl={10}>
            {/* 招聘周期（精简版：一行构成 + 紧凑表格） */}
            {!isHidden("cycles") && (
              <Card
                title="招聘周期"
                styles={{ body: { padding: "14px 18px" } }}
                extra={
                  <Tooltip title="平均值易被个别拖很久的候选人拉高，故同时给出中位数（典型水平）与 P90（长尾）">
                    <span style={{ fontSize: 12, color: "#8c8c8c" }}>指标说明</span>
                  </Tooltip>
                }
              >
                {segTotal != null && (
                  <div className="wb-cycle-line">
                    耗时构成：{segs.map((sg, i) => (
                      <span key={sg.name}>
                        {i > 0 && <span className="wb-cycle-sep"> · </span>}
                        {sg.name} <b>{r1(sg.days)}</b> 天
                      </span>
                    ))}
                    <span className="wb-cycle-note">（{data!.cycles.segments.n} 名入职者）</span>
                  </div>
                )}
                <table className="wb-table">
                  <thead>
                    <tr><th>环节</th><th>均值</th><th>中位</th><th>P90</th><th>样本</th></tr>
                  </thead>
                  <tbody>
                    {CYCLE_ROWS.map((cr) => {
                      const st = data!.cycles[cr.key];
                      return (
                        <tr key={cr.key}>
                          <td>{cr.title}</td>
                          <td><b>{dayText(st.avg)}</b> 天</td>
                          <td>{dayText(st.p50)} 天</td>
                          <td>{dayText(st.p90)} 天</td>
                          <td className="is-muted">{st.n > 0 ? `${st.n} 人` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Card>
            )}

            {/* 各阶段当前停留 */}
            {!isHidden("stay") && <OverviewPanel />}

            {/* 淘汰原因分布（精简版：紧凑条） */}
            {!isHidden("reject") && data!.reject_reasons.length > 0 && (
              <Card
                title="淘汰原因分布"
                style={{ marginTop: 16 }}
                styles={{ body: { padding: "14px 18px" } }}
                extra={
                  <Tooltip title="看板把候选人拖入「已淘汰」时选择的标准原因，自动按流转日志汇总；高频原因可用于修正 JD 与画像">
                    <span style={{ fontSize: 12, color: "#8c8c8c" }}>说明</span>
                  </Tooltip>
                }
              >
                {data!.reject_reasons.slice(0, 8).map((r, i) => (
                  <div className="wb-reject-row" key={r.reason}>
                    <div className="wb-reject-top">
                      <span>{r.reason}</span>
                      <b>{r.count} 人</b>
                    </div>
                    <div className="funnel-analysis-bar">
                      <div
                        className="funnel-analysis-fill"
                        style={{
                          width: `${Math.max(3, (r.count / data!.reject_reasons[0].count) * 100)}%`,
                          background: "#ef4444",
                        }}
                      />
                    </div>
                    {i === 7 && data!.reject_reasons.length > 8 && (
                      <div className="wb-reject-more">另有 {data!.reject_reasons.length - 8} 类原因（见导出）</div>
                    )}
                  </div>
                ))}
              </Card>
            )}
          </Col>
        </Row>
      )}

      <WorkbenchModulesModal
        open={cfgOpen}
        onClose={() => setCfgOpen(false)}
        hidden={hidden}
        onChange={updateHidden}
      />
    </div>
  );
}
