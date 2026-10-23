import { useState, useEffect, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Card, Button, Select, Space, Empty, Spin, Tooltip, message, Table,
  Alert, Segmented, Skeleton, Popover, Dropdown, Typography,
} from "antd";
import {
  ReloadOutlined, SearchOutlined, FunnelPlotOutlined, DownloadOutlined,
  RiseOutlined, TeamOutlined,
  InfoCircleOutlined, AppstoreOutlined, CalendarOutlined, AimOutlined,
  LineChartOutlined, PictureOutlined,
  FileExcelOutlined, AlertOutlined, BgColorsOutlined,
  RobotOutlined, CopyOutlined, CloseOutlined,
} from "@ant-design/icons";
import * as echarts from "echarts/core";
import { api } from "../api";
import AiThinking from "../components/AiThinking";
import { TypeText } from "../utils/useTypewriter";
import { downloadBlob, dateStamp, csvCell, exportXlsx } from "../utils/file";
import { copyText as copyToClipboard } from "../utils/clipboard";
import type {
  FunnelResponse, FunnelStayItem, Job, User, OverviewResponse, TrendResponse,
  WorkbenchModuleKey, AiRecapReport,
} from "../types";
import FunnelChartView, { exportFunnelPng } from "../components/FunnelChart";
import OverviewPanel from "../components/OverviewPanel";
import AiUsageFoot from "../components/AiUsageFoot";
import WorkbenchTrendChart from "../components/WorkbenchTrendChart";
import WorkbenchModulesModal from "../components/WorkbenchModulesModal";
import AnimatedNumber from "../components/AnimatedNumber";
import { useIdentityProfile } from "../useIdentity";
import { termFor } from "../identityProfiles";
import { loadWorkbenchConfig, saveWorkbenchConfig } from "../workbenchPrefs";
import { FUNNEL_PALETTES, DEFAULT_FUNNEL_PALETTE, loadFunnelPalette, saveFunnelPalette } from "../funnelPalette";

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

// 「全流程周期偏慢」的判定线（天）。放在这里而不是散在提示逻辑里，便于按行业调整。
const SLOW_CYCLE_DAYS = 35;

/** 环比文案：curr vs prev。上升绿、下降橙、持平灰；prev=0 时用「新增」避免除零 */
function wowText(curr: number, prev: number): { text: string; tone: "up" | "down" | "flat" } {
  if (prev === 0) {
    if (curr === 0) return { text: "持平", tone: "flat" };
    return { text: "新增", tone: "up" };
  }
  const p = ((curr - prev) / prev) * 100;
  if (Math.abs(p) < 0.5) return { text: "持平", tone: "flat" };
  const sign = p > 0 ? "+" : "";
  return { text: `${sign}${p.toFixed(0)}%`, tone: p > 0 ? "up" : "down" };
}

/** 客户端中国时区今天 YYYY-MM-DD */

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
  const [trendRange, setTrendRange] = useState<"4w" | "12w" | "24w">("12w");
  const [trendLoading, setTrendLoading] = useState(true);

  // ---- 工作台：模块显隐 ----
  const [hidden, setHidden] = useState<WorkbenchModuleKey[]>([]);
  const [cfgOpen, setCfgOpen] = useState(false);

  // ---- 工作台：漏斗配色（存 user_settings，跨设备同步）----
  const [palette, setPalette] = useState<string>(DEFAULT_FUNNEL_PALETTE);

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
  // reloadToken：点「查询」时自增，即使筛选条件没变也强制重拉一次。
  // （只 setState 相同值会被 React 跳过，用户点查询会毫无反应——2026-10-22 修）
  const [reloadToken, setReloadToken] = useState(0);

  // 竞态保护：快速切换筛选时只认最后一次请求，避免旧响应覆盖新响应
  const funnelReqRef = useRef(0);
  const fetchFunnel = useCallback(async (bust = false) => {
    const seq = ++funnelReqRef.current;
    setLoading(true);
    try {
      const res = await api.getFunnel({
        job_id: jobFilter || undefined,
        owner_id: ownerFilter || undefined,
        days: daysFilter || undefined,
        // 主动刷新时带时间戳 → 后端绕过 30s Edge Cache
        t: bust ? Date.now() : undefined,
      });
      if (seq === funnelReqRef.current) setData(res);
    } catch (err) {
      if (seq === funnelReqRef.current) message.error((err as Error).message);
    } finally {
      if (seq === funnelReqRef.current) setLoading(false);
    }
  }, [jobFilter, ownerFilter, daysFilter]);

  // 手动查询标记：条件没变时 React 会跳过 setState，光靠 reloadToken 也能触发 effect，
  // 但「是否要绕过缓存」必须由用户动作决定 —— 用 ref 传递，比比较条件签名更直接。
  const forceBustRef = useRef(false);
  useEffect(() => {
    const force = forceBustRef.current;
    forceBustRef.current = false;
    fetchFunnel(force);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchFunnel, reloadToken]);

  // ---- 行动层数据（轻量，随首屏一起拉）----
  const [ovToken, setOvToken] = useState(0);
  const [ovErr, setOvErr] = useState(false);
  useEffect(() => {
    let alive = true;
    setOvLoading(true);
    setOvErr(false);
    api.getOverview()
      .then((r) => { if (alive) setOverview(r); })
      .catch(() => { if (alive) setOvErr(true); }) // 行动层失败不阻塞页面，但要让用户知道
      .finally(() => { if (alive) setOvLoading(false); });
    return () => { alive = false; };
  }, [ovToken]);

  // ---- 趋势折线 ----
  useEffect(() => {
    let alive = true;
    setTrendLoading(true);
    api.getTrend(trendRange)
      .then((r) => { if (alive) setTrend(r); })
      .catch(() => { /* 趋势失败不阻塞 */ })
      .finally(() => { if (alive) setTrendLoading(false); });
    return () => { alive = false; };
  }, [trendRange]);

  // ---- 模块显隐配置（存后端用户设置）----
  useEffect(() => {
    let alive = true;
    loadWorkbenchConfig(currentUser).then((cfg) => {
      if (alive) setHidden(cfg.hidden);
    });
    loadFunnelPalette().then((id) => {
      if (alive) setPalette(id);
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

  /** 切换漏斗配色：立即生效 + 异步同步到账号 */
  const updatePalette = (id: string) => {
    setPalette(id);
    saveFunnelPalette(id).then((ok) => {
      if (!ok) message.warning("已应用，但同步到账号失败（下次登录可能还原）");
    });
  };

  useEffect(() => {
    api.getJobOptions().then(setJobs).catch(() => {});
    if (isAdmin) api.getUsers().then(setUsers).catch(() => {});
  }, [isAdmin]);

  // 应用筛选：条件未变也要重拉（用户点「查询」的语义就是「给我最新数」）
  const applySearch = () => {
    forceBustRef.current = true;
    setJobFilter(draftJob);
    setOwnerFilter(draftOwner);
    setDaysFilter(draftDays);
    setReloadToken((n) => n + 1);
  };

  const resetSearch = () => {
    forceBustRef.current = true;
    setDraftJob(""); setDraftOwner(""); setDraftDays(0);
    setJobFilter(""); setOwnerFilter(""); setDaysFilter(0);
    setReloadToken((n) => n + 1);
  };

  const filtered = !!(jobFilter || ownerFilter || daysFilter);

  const s = data?.summary;
  const stages = data?.stages || [];

  // 岗位名兜底：选了已删除的岗位时不能悄悄显示成「全部岗位」——那会让导出报告的口径撒谎
  const jobLabelOf = () =>
    jobFilter
      ? jobs.find((j) => j.id === jobFilter)?.title ?? termFor(profile, "已删除岗位")
      : termFor(profile, "全部岗位");

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

  const overdue = overview?.tasks.overdue ?? 0;
  const dueSoon = overview?.dueSoonTasks ?? [];
  // KPI 用后端 COUNT（dueSoonTasks 有 LIMIT 20，团队/管理员超 20 条会被截断成 20）
  const dueSoonCount = overview?.dueSoonCount ?? dueSoon.length;

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
    if (tc.avg != null && tc.avg > SLOW_CYCLE_DAYS) hints.push(`全流程平均 ${tc.avg} 天偏慢（中位 ${dayText(tc.p50)} 天）`);
    if (tc.p50 != null && tc.p90 != null && tc.p50 > 0 && tc.p90 >= tc.p50 * 2) {
      hints.push(`周期长尾明显：P90 是中位的 ${(tc.p90 / tc.p50).toFixed(1)} 倍，少数人在拖慢整体`);
    }
    if (segTotal) {
      const worst = segs.reduce((m, x) => (x.days > m.days ? x : m), segs[0]);
      hints.push(`耗时主要花在「${worst.name}」${r1(worst.days)} 天`);
    }
    return hints.slice(0, 3);
  })();

  // ---- AI 招聘复盘：把当前筛选口径的聚合数据交给 AI 生成叙述性复盘 ----
  // 纯聚合数字（无个人 PII），60s 超时；失败降级为规则诊断文本，不让功能挂死
  const [recap, setRecap] = useState<AiRecapReport | null>(null);
  const [recapLoading, setRecapLoading] = useState(false);
  const [recapErr, setRecapErr] = useState("");
  const recapScope = `${jobFilter || "all"}:${daysFilter || "all"}:${ownerFilter || "all"}`;

  // 筛选一变，上一轮复盘就属于「旧口径」——直接作废，
  // 否则用户会把旧结论当成新筛选的结果拿去汇报（2026-10-22 修）。
  useEffect(() => {
    setRecap(null);
    setRecapErr("");
  }, [jobFilter, ownerFilter, daysFilter]);
  const genRecap = async () => {
    if (!data || !s) return;
    setRecapLoading(true);
    setRecapErr("");
    try {
      const jobLabel = jobLabelOf();
      const timeLabel = TIME_RANGES.find((t) => t.value === daysFilter)?.label || "全部时间";
      const ownerLabel = isAdmin && ownerFilter ? users.find((u) => u.id === ownerFilter)?.name || ownerFilter : "";
      const r = await api.aiRecapReport({
        scope: recapScope,
        report: {
          统计范围: [jobLabel, timeLabel, ownerLabel].filter(Boolean).join(" · "),
          总体: {
            进入流程: s.total, 进行中: s.in_progress, 已入职: s.hired,
            已淘汰: s.rejected, 已放弃: s.withdrawn, 整体转化率: pct(s.overall_rate),
          },
          漏斗各阶段: stages.map((st) => ({
            阶段: st.label, 人数: st.count, 较上一级转化率: pct(st.rate), 流失人数: st.drop,
          })),
          各阶段当前停留: data.stage_stay.map((x) => ({
            阶段: x.label, 人数: x.count, 平均停留天数: x.avg_days,
          })),
          招聘周期天数: {
            入库到首面: data.cycles.tti, 首面到Offer: data.cycles.to_offer,
            Offer到入职: data.cycles.to_hire, 全流程: data.cycles.total,
          },
          渠道效果: data.sources.map((x) => ({
            渠道: x.source, 进入: x.entered, 入职: x.hired,
            转化率: pct(x.rate), 平均周期天数: x.avg_cycle_days,
          })),
          淘汰原因分布: data.reject_reasons.map((x) => ({ 原因: x.reason, 人数: x.count })),
          规则诊断: diagnosis,
        },
      });
      setRecap(r);
    } catch (err) {
      setRecap(null);
      setRecapErr((err as Error).message || "生成失败，请稍后重试");
    }
    setRecapLoading(false);
  };

  const copyRecap = async () => {
    if (!recap) return;
    const text = [
      recap.summary,
      "",
      ...recap.bottlenecks.map((b) => `· 瓶颈：${b}`),
      ...recap.suggestions.map((sg) => `· 建议：${sg}`),
    ].join("\n");
    const ok = await copyToClipboard(text);
    if (ok) message.success("已复制复盘全文");
    else message.error("复制失败，请手动选择文本复制");
  };

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

  /**
   * 漏斗 PNG：阶段名与转化率是 HTML 叠加层，不在 ECharts canvas 里，
   * 直接 getDataURL 会导出「没有阶段名的色块」。改走 FunnelChart 的合成导出。
   */
  const downloadFunnelPng = async () => {
    if (!data) return;
    try {
      const url = await exportFunnelPng(funnelChartRef.current, stages, data.stage_stay);
      if (!url) { message.warning("图表尚未就绪，请稍后再试"); return; }
      const a = document.createElement("a");
      a.href = url;
      a.download = `${termFor(profile, "招聘漏斗")}_${dateStamp()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      message.success("已导出 PNG（含阶段名与转化率）");
    } catch {
      message.error("导出失败，请稍后再试");
    }
  };

  /** 导出招聘漏斗全量数据（CSV 五段，保留原有能力） */
  const exportFunnel = () => {
    if (!data || !s) return;
    const rows: string[] = [];
    const timeLabel = TIME_RANGES.find((t) => t.value === daysFilter)?.label || "全部时间";
    const jobLabel = jobLabelOf();

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
  // 行动层（今日重点 + 关键指标）显隐：任一模块在「调整模块」里开着就显示
  const statsOn = !isHidden("today_focus") || !isHidden("kpi_band");
  // 「无数据」判定：overview 已返回且账号核心指标全为零（新注册/空账号）时，
  // 指标条整块隐藏——否则首屏是一排 0，对空账号没有信息量。
  const actionEmpty = !!overview
    && (overview.totalTalents ?? 0) === 0
    && (overview.openJobs ?? 0) === 0
    && (overview.activeCandidates ?? 0) === 0
    && (overview.weeklyNewTalents ?? 0) === 0
    && (overview.todayInterviewCount ?? 0) === 0
    && (overview.tasks?.pending ?? 0) === 0
    && (overview.tasks?.overdue ?? 0) === 0
    && (overview.tasks?.today ?? 0) === 0
    && dueSoonCount === 0;
  // 指标条：加载中/拉取失败维持原样（骨架 / 不显示），仅「已返回且全零」时隐藏
  const showStats = statsOn && !actionEmpty;

  return (
    <div className="funnel-page">
      {/* ===== 顶部操作行：调整模块（快捷入口已下线——搜人才/加候选人/发 JD/面试安排
           均与侧栏菜单重复，入口在「人才资产/招聘推进」分组）===== */}
      <div className="wb-topbar">
        <Button icon={<AppstoreOutlined />} onClick={() => setCfgOpen(true)}>调整模块</Button>
      </div>

      {/* ===== 行动层：今日重点 + 关键指标（通栏）===== */}
      {showStats && (overview || ovLoading || ovErr) && (
        <div className="wb-hero">
          {overview ? (
            <div className="page-stats wb-strip">
              {/* 关键指标 */}
              {!isHidden("kpi_band") && (
                <>
                  <div className="stat">
                    <span className="stat-icon is-neutral"><AimOutlined /></span>
                    <span className="stat-body">
                      <span className="stat-num is-neutral"><AnimatedNumber value={overview.openJobs ?? 0} format={(n) => Math.round(n).toLocaleString("zh-CN")} /></span>
                      <span className="stat-label">{termFor(profile, "在招岗位")}</span>
                    </span>
                  </div>
                  <div className="stat">
                    <span className="stat-icon is-neutral"><TeamOutlined /></span>
                    <span className="stat-body">
                      <span className="stat-num"><AnimatedNumber value={overview.activeCandidates ?? 0} format={(n) => Math.round(n).toLocaleString("zh-CN")} /></span>
                      <span className="stat-label">{termFor(profile, "待推进")}</span>
                    </span>
                  </div>
                  <div className="stat">
                    <span className="stat-icon is-good"><RiseOutlined /></span>
                    <span className="stat-body">
                      <span className="stat-num is-good"><AnimatedNumber value={overview.weeklyNewTalents ?? 0} format={(n) => Math.round(n).toLocaleString("zh-CN")} /></span>
                      <span className="stat-label">
                        本周新增
                        {(() => {
                          const w = wowText(overview.weeklyNewTalents ?? 0, overview.prevWeekNewTalents ?? 0);
                          const color = w.tone === "up" ? "#16a34a" : w.tone === "down" ? "#ea580c" : "#94a3b8";
                          return <span className="wb-wow" style={{ color }}>较上周 {w.text}</span>;
                        })()}
                      </span>
                    </span>
                  </div>
                </>
              )}
              {/* 今日重点：今日面试 / 近 3 天到期（带逾期红徽标，点击进对应页） */}
              {!isHidden("today_focus") && (
                <>
                  <Link to="/interviews" className="stat is-link">
                    <span className="stat-icon is-warn"><CalendarOutlined /></span>
                    <span className="stat-body">
                      <span className="stat-num is-warn"><AnimatedNumber value={overview.todayInterviewCount ?? 0} format={(n) => Math.round(n).toLocaleString("zh-CN")} /></span>
                      <span className="stat-label">
                        今日面试
                        {(() => {
                          const w = wowText(overview.todayInterviewCount ?? 0, overview.prevWeekdayInterviewCount ?? 0);
                          const color = w.tone === "up" ? "#16a34a" : w.tone === "down" ? "#ea580c" : "#94a3b8";
                          return <span className="wb-wow" style={{ color }}>较上周 {w.text}</span>;
                        })()}
                      </span>
                    </span>
                  </Link>
                  <Link to="/tasks" className="stat is-link">
                    <span className="stat-icon is-warn"><AlertOutlined /></span>
                    <span className="stat-body">
                      <span className="stat-num is-warn">{dueSoonCount}</span>
                      <span className="stat-label">
                        近 3 天到期
                        {overdue > 0 && <span className="wb-focus-overdue">{overdue} 逾期</span>}
                      </span>
                    </span>
                  </Link>
                </>
              )}
            </div>
          ) : ovLoading ? (
            <Card><Skeleton active paragraph={{ rows: 1 }} /></Card>
          ) : (
            // 拉取失败：给一行可重试的提示，而不是留一块空白（用户会以为页面坏了）
            <Card styles={{ body: { padding: "10px 16px" } }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                关键指标加载失败，其他数据不受影响。
              </Typography.Text>
              <Button size="small" type="link" onClick={() => setOvToken((n) => n + 1)}>重试</Button>
            </Card>
          )}
        </div>
      )}

      {/* ===== 分析层：招聘概览 ===== */}
      <div className="wb-section-head">
        <span className="wb-section-title"><FunnelPlotOutlined /> {termFor(profile, "招聘概览")}</span>
        <Space wrap size={8}>
          {!isHidden("trend") && (
            <Segmented
              className="app-pill-seg"
              size="small"
              value={trendRange}
              onChange={(v) => setTrendRange(v as "4w" | "12w" | "24w")}
              options={[
                { label: "近 4 周", value: "4w" },
                { label: "近 12 周", value: "12w" },
                { label: "近 24 周", value: "24w" },
              ]}
            />
          )}
          <Tooltip title={analysisReady ? "按当前筛选口径，让 AI 写出叙述性复盘（瓶颈 + 建议），可复制用于汇报" : "先有招聘数据，AI 才能复盘"}>
            <Button className="ai-btn" size="small" icon={<RobotOutlined />} onClick={genRecap} loading={recapLoading} disabled={!analysisReady}>AI 复盘</Button>
          </Tooltip>
          {/* 两个导出入口合并成一个下拉：卡头在 1280px 下已有 Segmented + AI + 导出，
              按钮再多就换行；CSV 是 Excel 的子集，按需选即可 */}
          <Dropdown
            disabled={!analysisReady}
            menu={{
              items: [
                { key: "xlsx", icon: <FileExcelOutlined />, label: "汇报 Excel（多表）" },
                { key: "csv", icon: <DownloadOutlined />, label: "数据 CSV" },
              ],
              onClick: ({ key }) => {
                if (key === "xlsx") void exportWorkbook();
                else exportFunnel();
              },
            }}
          >
            <Button size="small" icon={<DownloadOutlined />} disabled={!analysisReady}>导出</Button>
          </Dropdown>
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

      {/* 筛选生效提示：漏斗、趋势、导出都按这个口径算，滚到下面或离开再回来很容易忘 */}
      {filtered && (
        <div className="wb-filter-bar">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            当前口径：{[
              jobFilter ? jobLabelOf() : "",
              ownerFilter ? (users.find((u) => u.id === ownerFilter)?.name ?? "指定成员") : "",
              daysFilter ? (TIME_RANGES.find((t) => t.value === daysFilter)?.label ?? `${daysFilter} 天内`) : "",
            ].filter(Boolean).join(" · ")}
          </Typography.Text>
          <Button size="small" type="link" onClick={resetSearch}>清除筛选</Button>
        </div>
      )}

      {/* AI 招聘复盘：生成后内嵌展示（复制全文 / 重新生成）；AI 失败时降级显示规则诊断 */}
      {!loading && analysisReady && (recap || recapErr || recapLoading) && (
        <Card
          size="small"
          style={{ marginBottom: 16 }}
          title={<Space size={8}><RobotOutlined />AI 招聘复盘</Space>}
          extra={
            <Space size={8}>
              <Button size="small" icon={<CopyOutlined />} onClick={copyRecap} disabled={!recap}>复制全文</Button>
              <Button size="small" onClick={genRecap} loading={recapLoading}>重新生成</Button>
              <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => { setRecap(null); setRecapErr(""); }} />
            </Space>
          }
        >
          {recapLoading ? (
            <AiThinking steps={["正在读取数据…", "正在分析漏斗与周期…", "正在组织复盘结论…"]} />
          ) : recap ? (
            <div className="wb-recap">
              <p><TypeText text={recap.summary} /></p>
              {recap.bottlenecks.map((b, i) => (
                <div className="wb-recap-line" key={`b${i}`}>· <b>瓶颈</b>：<TypeText text={b} /></div>
              ))}
              {recap.suggestions.map((sg, i) => (
                <div className="wb-recap-line" key={`s${i}`}>· <b>建议</b>：<TypeText text={sg} /></div>
              ))}
              <AiUsageFoot usage={recap._usage} />
            </div>
          ) : (
            <Alert
              type="warning"
              showIcon
              message={`AI 暂不可用（${recapErr}），先看系统规则诊断：`}
              description={
                diagnosis.length > 0
                  ? diagnosis.map((h, i) => <div key={i}>· {h}</div>)
                  : "当前数据量还不足以给出诊断，先积累一些候选人数据再来。"
              }
            />
          )}
        </Card>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem" }}><Spin size="large" /></div>
      ) : !analysisReady ? (
        <Card className="list-card">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              filtered
                ? termFor(profile, "当前筛选条件下没有数据，试试放宽岗位或时间范围")
                : termFor(profile, "还没有人才进入招聘看板，先去把人挂到岗位上，这里就会有数据了")
            }
          >
            {!filtered && (
              <>
                <Link to="/pipeline" className="btn-as-primary">
                  {termFor(profile, "去招聘看板录入")}
                </Link>
                <div style={{ marginTop: 12, color: "#999", fontSize: 12 }}>
                  {termFor(profile, "在看板把候选人推进到面试阶段后，这里会自动汇总漏斗、周期与渠道数据")}
                </div>
              </>
            )}
          </Empty>
        </Card>
      ) : (
        (() => {
          // ===== 分析层模块扁平化：按显隐过滤后，用估算高度贪心分到两列（各 50%）=====
          // 隐藏任何模块后，剩余模块自动重新落位补位，两列高度始终接近；
          // h 为估算高度（px），只用于落位决策，+16 对应列内 gap
          const modules: { key: string; h: number; node: ReactNode }[] = [];

          // 招聘趋势
          if (!isHidden("trend")) {
            modules.push({
              key: "trend",
              h: 340, // 260 图 + 卡头/内边距
              node: (
                <Card
                  title={<Space><LineChartOutlined />招聘趋势</Space>}
                  styles={{ body: { padding: "12px 16px" } }}
                  extra={
                    <Tooltip title="单位是「人次」：同一人才投多个岗位、同一岗位反复推进会分别计；漏斗统计的是去重人数，两者不能直接对账。新增=人才入库；进入面试=到达初试的日志；入职=到达已入职的日志。最后一周是本周至今，尚未满一周。">
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
              ),
            });
          }

          // 转化漏斗
          if (!isHidden("funnel") && s) {
            modules.push({
              key: "funnel",
              h: stages.length * 76 + 260, // 漏斗主体 + 终态分支/诊断/口径区
              node: (
                <Card
                  title={<Space><FunnelPlotOutlined />转化漏斗</Space>}
                  styles={{ body: { padding: "20px 24px" } }}
                  extra={
                    <Space size={12}>
                      <Tooltip title="阶段人数按「曾到达」统计：只要候选人到过该阶段就计入，因此漏斗逐级递减，不会因为后期淘汰而回退">
                        <span style={{ fontSize: 12, color: "#8c8c8c" }}>统计口径说明</span>
                      </Tooltip>
                      <Popover
                        placement="bottomRight"
                        trigger="click"
                        content={
                          <div className="wb-pal-list">
                            {FUNNEL_PALETTES.map((p) => (
                              <button
                                type="button"
                                key={p.id}
                                className={`wb-pal-item${palette === p.id ? " is-active" : ""}`}
                                onClick={() => updatePalette(p.id)}
                              >
                                <span className="wb-pal-swatch">
                                  {p.levels.map((l, i) => (
                                    <i key={i} style={{ background: `linear-gradient(180deg, ${l.from}, ${l.to})` }} />
                                  ))}
                                </span>
                                <span className="wb-pal-text">
                                  <b>{p.name}</b>
                                  <em>{p.desc}</em>
                                </span>
                              </button>
                            ))}
                          </div>
                        }
                      >
                        <Tooltip title="切换漏斗配色">
                          <Button size="small" type="text" icon={<BgColorsOutlined />} />
                        </Tooltip>
                      </Popover>
                      <Tooltip title="下载高清 PNG（白底，含阶段名与转化率，可直接贴进汇报 PPT）">
                        <Button
                          size="small" type="text" icon={<PictureOutlined />}
                          onClick={downloadFunnelPng}
                        >PNG</Button>
                      </Tooltip>
                    </Space>
                  }
                >
                  <FunnelChartView
                    stages={stages}
                    stageStay={data!.stage_stay}
                    dark={isDark}
                    palette={palette}
                    height={Math.round(stages.length * 76 + 52)}
                    chartOut={funnelChartRef}
                  />

                  <div className="funnel-branches">
                    <div className="funnel-branch">
                      <span className="funnel-dot" style={{ background: "#ef4444" }} />
                      已淘汰
                      <b style={{ color: "#ef4444", marginLeft: 6 }}>{s.rejected}</b> 人
                    </div>
                    <div className="funnel-branch">
                      <span className="funnel-dot" style={{ background: "#94a3b8" }} />
                      已放弃
                      <b style={{ color: "#94a3b8", marginLeft: 6 }}>{s.withdrawn}</b> 人
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
              ),
            });
          }

          // 招聘周期
          if (!isHidden("cycles") && s) {
            modules.push({
              key: "cycles",
              h: 430, // 构成行 + 耗时条 + 指标表
              node: (
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
                  {(() => {
                    const bars = CYCLE_ROWS.filter((r) => r.key !== "total").map((cr) => ({
                      key: cr.key,
                      title: cr.title,
                      avg: data!.cycles[cr.key].avg ?? 0,
                    }));
                    const maxAvg = bars.reduce((m, b) => Math.max(m, b.avg), 0);
                    return (
                      <div className="wb-cycle-bars">
                        <div className="wb-cycle-bars-cap">各环节平均耗时（瓶颈环节标红）</div>
                        {bars.map((b) => {
                          const w = maxAvg > 0 ? Math.max(4, (b.avg / maxAvg) * 100) : 0;
                          const isMax = b.avg > 0 && b.avg === maxAvg;
                          return (
                            <div className="wb-cycle-bar-row" key={b.key}>
                              <span className="wb-cycle-bar-lab">{b.title}</span>
                              <span className="wb-cycle-bar-track">
                                <span
                                  className={`wb-cycle-bar-fill${isMax ? " is-bottleneck" : ""}`}
                                  style={{ width: `${w}%` }}
                                />
                              </span>
                              <span className="wb-cycle-bar-val">{b.avg > 0 ? `${r1(b.avg)} 天` : "—"}</span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
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
              ),
            });
          }

          // 渠道效果
          if (!isHidden("sources") && s && data!.sources.length > 0) {
            modules.push({
              key: "sources",
              h: 120 + (data!.sources.length + 1) * 40, // 卡头 + 提示区 + 表格行
              node: (
                <Card
                  title={<Space><TeamOutlined />渠道效果</Space>}
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
                        render: (v: number) => {
                          const color = v >= 0.3 ? "#10b981" : v > 0 ? "#d48806" : "#bfbfbf";
                          const w = Math.max(3, v * 100);
                          return (
                            <span className="wb-rate-cell">
                              <span className="wb-rate-bar">
                                <span className="wb-rate-fill" style={{ width: `${w}%`, background: color }} />
                              </span>
                              <b style={{ color }}>{pct(v)}</b>
                            </span>
                          );
                        },
                      },
                      {
                        title: "平均周期", dataIndex: "avg_cycle_days", align: "right",
                        render: (v: number | null) => (v == null ? "—" : `${v} 天`),
                      },
                    ]}
                  />
                </Card>
              ),
            });
          }

          // 各阶段当前停留
          if (!isHidden("stay")) {
            modules.push({ key: "stay", h: 340, node: <OverviewPanel data={overview} loading={ovLoading} /> });
          }

          // 淘汰原因分布
          if (!isHidden("reject") && s && data!.reject_reasons.length > 0) {
            modules.push({
              key: "reject",
              h: 130 + Math.min(8, data!.reject_reasons.length) * 52, // 卡头 + 紧凑条行
              node: (
                <Card
                  title="淘汰原因分布"
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
              ),
            });
          }

          // 贪心落位：放进累计高度较小的那一列（+16 为列内 gap）
          const cols: { key: string; node: ReactNode }[][] = [[], []];
          const colH = [0, 0];
          for (const m of modules) {
            const t = colH[0] <= colH[1] ? 0 : 1;
            cols[t].push(m);
            colH[t] += m.h + 16;
          }
          return (
            <div className="wb-cols">
              {cols.map((col, ci) => (
                <div className="wb-col" key={ci}>
                  {col.map((m) => (
                    <div key={m.key}>{m.node}</div>
                  ))}
                </div>
              ))}
            </div>
          );
        })()
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
