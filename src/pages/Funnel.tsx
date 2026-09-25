import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { Card, Button, Select, Space, Row, Col, Empty, Spin, Tooltip, message } from "antd";
import {
  ReloadOutlined, SearchOutlined, FunnelPlotOutlined,
  ThunderboltOutlined, RiseOutlined, ClockCircleOutlined, TeamOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import type { FunnelResponse, Job, User } from "../types";
import FunnelChartView from "../components/FunnelChart";

// 周期指标的配色（与漏斗同一套柔和色系，暗色模式取亮档）
// 顺序即流程顺序：入库→首面 / 首面→Offer / Offer→入职 / 全流程
const KPI_COLORS_LIGHT = ["#2563eb", "#0891b2", "#d97706", "#059669"];
const KPI_COLORS_DARK = ["#60a5fa", "#22d3ee", "#fbbf24", "#34d399"];

// 四张周期卡的配置（icon 存组件，渲染时再按主题上色）
const CYCLE_CARDS = [
  { key: "tti", title: "简历到首面", desc: "入库到首次面试", icon: ThunderboltOutlined },
  { key: "to_offer", title: "面试到 Offer", desc: "首面到发出 Offer", icon: RiseOutlined },
  { key: "to_hire", title: "Offer 到入职", desc: "接受 Offer 到实际到岗", icon: TeamOutlined },
  { key: "total", title: "全流程周期", desc: "入库到入职", icon: ClockCircleOutlined },
] as const;

// 构成条三段（与 KPI_COLORS 前三段同源，保证左右配色一致）
const SEG_NAMES = ["简历 → 首面", "首面 → Offer", "Offer → 入职"];

// 全流程周期健康度阈值（经验值，单位：天）
const HEALTH_FAST = 21;
const HEALTH_SLOW = 35;
const healthOf = (v: number | null) => {
  if (v == null) return null;
  if (v <= HEALTH_FAST) return { label: "快", cls: "is-fast" };
  if (v <= HEALTH_SLOW) return { label: "正常", cls: "is-ok" };
  return { label: "偏慢", cls: "is-slow" };
};

const TIME_RANGES = [
  { label: "全部时间", value: 0 },
  { label: "近 30 天", value: 30 },
  { label: "近 90 天", value: 90 },
  { label: "近 180 天", value: 180 },
];

// 百分比展示
const pct = (v: number) => `${(v * 100).toFixed(v >= 0.1 || v === 0 ? 0 : 1)}%`;
// 构成占比展示（小数位随量级自适应，避免出现「20.0%」这种冗余）
const shareText = (v: number) => {
  const p = v * 100;
  return `${p >= 10 ? p.toFixed(0) : p.toFixed(1)}%`;
};
// 天数展示
const dayText = (v: number | null) => (v == null ? "—" : `${v} 天`);
// 纯数字天数（构成条图例用，避免「天」字重复）
const numText = (v: number | null) => (v == null ? "—" : `${v}`);
const r1 = (v: number) => Math.round(v * 10) / 10;
// 时间戳（本地）
export default function Funnel() {
  const [data, setData] = useState<FunnelResponse | null>(null);
  const [jobs, setJobs] = useState<Pick<Job, "id" | "title" | "status">[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);

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

  // 跟随全局主题（html[data-theme]，配 ECharts 文字色/描边色）
  const [isDark, setIsDark] = useState(
    () => document.documentElement.getAttribute("data-theme") === "dark"
  );
  const KPI_COLORS = isDark ? KPI_COLORS_DARK : KPI_COLORS_LIGHT;
  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setIsDark(el.getAttribute("data-theme") === "dark");
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

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
  // 周期：构成条三段（必须全部有值才能拆分，否则退化成空态）
  const segRaw = data ? [data.cycles.segments.s1, data.cycles.segments.s2, data.cycles.segments.s3] : [];
  const segs: { name: string; days: number }[] =
    segRaw.length === 3 && segRaw.every((d): d is number => d != null)
      ? segRaw.map((d, i) => ({ name: SEG_NAMES[i], days: d }))
      : [];
  const segTotal = segs.length ? segs.reduce((a, b) => a + b.days, 0) : null;
  const SEG_COLORS = KPI_COLORS.slice(0, 3);

  return (
    <div className="funnel-page">
      {/* 筛选 */}
      <Card className="search-card" style={{ marginBottom: 16 }} styles={{ body: { padding: 16 } }}>
        <div className="search-grid">
          <div className="search-field">
            <span className="search-label">岗位</span>
            <div className="search-control">
            <Select
              style={{ width: "100%" }} allowClear placeholder="全部岗位"
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
        <div style={{ textAlign: "center", padding: "4rem" }}><Spin size="large" /></div>
      ) : !s || s.total === 0 ? (
        <Card>
          <Empty
            description={
              filtered
                ? "当前筛选条件下没有数据，试试放宽岗位或时间范围"
                : "还没有候选人进入招聘流程，先去「招聘流程」把人才挂到岗位上，这里就会有数据了"
            }
          >
            <Link to="/pipeline">
              <Button type="primary">去招聘流程录入</Button>
            </Link>
          </Empty>
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          {/* ===== 左：漏斗展示 ===== */}
          <Col xs={24} xl={14}>
          <Card
            title={<Space><FunnelPlotOutlined />阶段转化</Space>}
            style={{ marginBottom: 16 }}
            styles={{ body: { padding: "20px 24px" } }}
            extra={
              <Tooltip title="阶段人数按「曾到达」统计：只要候选人到过该阶段就计入。柱体为各阶段人数，柱顶标注相对上一级的转化率与流失人数，蓝色折线为累计转化率（右轴），x 轴下方为当前停留均长">
                <span style={{ fontSize: 12, color: "#8c8c8c" }}>统计口径说明</span>
              </Tooltip>
            }
          >
            <FunnelChartView
              stages={stages}
              stageStay={data!.stage_stay}
              dark={isDark}
              height={420}
            />

            {/* 终态分支：淘汰 / 放弃 */}
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
                （终态分支不计入漏斗主线，人才可能在任何一级进入终态）
              </span>
            </div>
          </Card>
          {/* 结论：先给总览数据，再给诊断意见 */}
          <Card title="结论" styles={{ body: { padding: "14px 18px" } }}>
            <div className="funnel-summary">
              <div className="funnel-summary-item">
                <span className="funnel-summary-num">{s.total}</span>
                <span className="funnel-summary-label">进入流程</span>
              </div>
              <div className="funnel-summary-item">
                <span className="funnel-summary-num" style={{ color: "#0ea5e9" }}>{s.in_progress}</span>
                <span className="funnel-summary-label">招聘中</span>
              </div>
              <div className="funnel-summary-item">
                <span className="funnel-summary-num" style={{ color: "#10b981" }}>{s.hired}</span>
                <span className="funnel-summary-label">已入职</span>
              </div>
              <div className="funnel-summary-item">
                <span className="funnel-summary-num" style={{ color: "#f59e0b" }}>
                  {pct(s.overall_rate)}
                </span>
                <span className="funnel-summary-label">整体转化率</span>
              </div>
              <div className="funnel-summary-item">
                <span className="funnel-summary-num" style={{ color: "#6366f1" }}>
                  {data!.cycles.total.avg == null ? "—" : data!.cycles.total.avg}
                </span>
                <span className="funnel-summary-label">平均周期(天)</span>
              </div>
            </div>
            <div style={{ fontSize: 13, color: "#595959", lineHeight: 1.9 }}>
              {(() => {
                const bottleneck = stages
                  .slice(1)
                  .reduce((min, cur) => (cur.rate < min.rate ? cur : min), stages[1] || stages[0]);
                const hints: string[] = [];
                if (bottleneck && stages[1]) {
                  hints.push(
                    `转化最弱的一环是「${stages[stages.indexOf(bottleneck) - 1]?.label} → ${bottleneck.label}」，仅 ${pct(bottleneck.rate)}，本阶段流失 ${bottleneck.drop} 人`
                  );
                }
                const tc = data!.cycles.total;
                if (tc.avg != null && tc.avg > HEALTH_SLOW) {
                  hints.push(
                    `全流程平均 ${tc.avg} 天、中位 ${dayText(tc.p50)}，超过 ${HEALTH_SLOW} 天偏慢`
                  );
                }
                // 长尾：P90 达到中位数 2 倍以上，说明是少数人在拖慢整体，而非普遍慢
                if (tc.p50 != null && tc.p90 != null && tc.p50 > 0 && tc.p90 >= tc.p50 * 2) {
                  hints.push(
                    `周期长尾明显：P90 ${tc.p90} 天是中位 ${tc.p50} 天的 ${(tc.p90 / tc.p50).toFixed(1)} 倍，是少数候选人在拖慢整体，优先清理这批人比整体提速更有效`
                  );
                }
                // 耗时构成：指出时间主要花在哪一段
                if (segs.length > 0 && segTotal) {
                  const worst = segs.reduce((m, x) => (x.days > m.days ? x : m), segs[0]);
                  hints.push(
                    `全流程耗时主要花在「${worst.name}」，${worst.days} 天，占总时长 ${shareText(worst.days / segTotal)}`
                  );
                }
                const slow = data!.stage_stay.filter((x) => x.avg_days != null && x.avg_days >= 7);
                if (slow.length > 0) {
                  hints.push(
                    `有阶段当前停留超过 7 天（${slow.map((x) => `${x.label} ${x.avg_days} 天`).join("、")}），建议优先推进`
                  );
                }
                return hints.length > 0 ? hints.map((h, i) => <div key={i}>· {h}</div>) : <div>· 目前各环节转化正常，暂无明显瓶颈</div>;
              })()}
            </div>
          </Card>
          </Col>

          {/* ===== 右：数据分析 ===== */}
          <Col xs={24} xl={10}>
          {/* 招聘周期 */}
          <Card
            title="招聘周期"
            styles={{ body: { padding: "16px 18px" } }}
            extra={
              <Tooltip title="平均值容易被个别拖很久的候选人拉高，所以同时给出中位数（典型水平）与 P90（九成的人快于此值，代表长尾）">
                <span style={{ fontSize: 12, color: "#8c8c8c" }}>指标说明</span>
              </Tooltip>
            }
          >
            {/* 全流程耗时构成：基于完整链路入职者，三段之和 = 全流程周期 */}
            <div className="funnel-cycle-split">
              <div className="funnel-cycle-split-head">
                <span>耗时构成</span>
                <span className="funnel-cycle-split-sum">
                  {segTotal != null
                    ? `合计 ${r1(segTotal)} 天 · ${data!.cycles.segments.n} 名入职者`
                    : "暂无完整链路数据"}
                </span>
              </div>
              {segTotal != null && segTotal > 0 ? (
                <>
                  <div className="funnel-cycle-bar">
                    {segs.map((sg, i) => (
                      <Tooltip
                        key={sg.name}
                        title={`${sg.name}：${numText(sg.days)} 天，占全流程 ${shareText(sg.days / segTotal)}`}
                      >
                        <div
                          className="funnel-cycle-seg"
                          style={{ width: `${(sg.days / segTotal) * 100}%`, background: SEG_COLORS[i] }}
                        />
                      </Tooltip>
                    ))}
                  </div>
                  <div className="funnel-cycle-legend">
                    {segs.map((sg, i) => (
                      <span className="funnel-cycle-legend-item" key={sg.name}>
                        <span className="funnel-dot" style={{ background: SEG_COLORS[i] }} />
                        {sg.name}
                        <b>{numText(sg.days)}</b> 天
                        <em>{shareText(sg.days / segTotal)}</em>
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <div className="funnel-cycle-empty">
                  {data!.cycles.segments.n > 0
                    ? "当前入职样本耗时不足 1 天（多为同日完成），占比暂无法拆分"
                    : "需要「入库 → 首面 → Offer → 入职」四段齐全的候选人，才能把总耗时拆开"}
                </div>
              )}
            </div>

            {/* 分段统计：平均 / 中位 / P90 / 最长 */}
            <div className="funnel-kpi-grid is-narrow">
              {CYCLE_CARDS.map((cd, i) => {
                const st = data!.cycles[cd.key];
                const color = KPI_COLORS[i];
                const Icon = cd.icon;
                const health = cd.key === "total" ? healthOf(st.avg) : null;
                return (
                  <div className="funnel-kpi" key={cd.key}>
                    <div className="funnel-kpi-head">
                      <Icon style={{ color }} />
                      <Tooltip title={cd.desc}>
                        <span className="funnel-kpi-title">{cd.title}</span>
                      </Tooltip>
                      {health && <span className={`funnel-health ${health.cls}`}>{health.label}</span>}
                    </div>
                    <div className="funnel-kpi-value" style={{ color }}>
                      {dayText(st.avg)}
                    </div>
                    {st.n > 0 ? (
                      <>
                        <div className="funnel-kpi-dist">
                          中位 {dayText(st.p50)}
                          <span className="funnel-kpi-sep">·</span>
                          P90 {dayText(st.p90)}
                        </div>
                        <div className="funnel-kpi-foot">
                          最快 {dayText(st.min)} · 最长 {dayText(st.max)} · 样本 {st.n} 人
                          {st.n < 3 && <span className="funnel-kpi-warn">样本少</span>}
                        </div>
                      </>
                    ) : (
                      <div className="funnel-kpi-foot">暂无样本 · {cd.desc}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          </Col>

          {/* ===== 渠道效果：各来源「进入流程 → 入职」转化 ===== */}
          {data!.sources.length > 0 && (
            <Col xs={24} xl={14}>
              <Card
                title={<Space><TeamOutlined />渠道效果</Space>}
                styles={{ body: { padding: "16px 18px" } }}
                extra={
                  <Tooltip title="按人才来源统计进入流程与入职转化；同一人才投多个岗位按投递记录分别计入，与漏斗口径一致。来源在人才库「来源渠道」字段维护">
                    <span style={{ fontSize: 12, color: "#8c8c8c" }}>口径说明</span>
                  </Tooltip>
                }
              >
                {data!.sources.map((src) => (
                  <div key={src.source} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{src.source}</span>
                      <span style={{ fontSize: 12, color: "#8c8c8c" }}>
                        进入 <b style={{ color: "#262626" }}>{src.entered}</b>
                        <span style={{ margin: "0 4px" }}>·</span>
                        入职 <b style={{ color: "#10b981" }}>{src.hired}</b>
                        <span style={{ margin: "0 4px" }}>·</span>
                        <b style={{ color: src.rate >= 0.3 ? "#10b981" : src.rate > 0 ? "#d48806" : "#8c8c8c" }}>{pct(src.rate)}</b>
                      </span>
                    </div>
                    <div className="funnel-analysis-bar">
                      <div
                        className="funnel-analysis-fill"
                        style={{ width: `${Math.max(2, src.rate * 100)}%`, background: "#10b981" }}
                      />
                    </div>
                  </div>
                ))}
              </Card>
            </Col>
          )}

          {/* ===== 淘汰原因分布：反哺 JD 与画像修正 ===== */}
          {data!.reject_reasons.length > 0 && (
            <Col xs={24} xl={10}>
              <Card
                title="淘汰原因分布"
                styles={{ body: { padding: "16px 18px" } }}
                extra={
                  <Tooltip title="看板把候选人拖入「已淘汰」时选择的标准原因，自动按流转日志汇总；高频原因可用于修正 JD 与画像">
                    <span style={{ fontSize: 12, color: "#8c8c8c" }}>说明</span>
                  </Tooltip>
                }
              >
                {data!.reject_reasons.map((r, i) => (
                  <div key={r.reason} style={{ marginBottom: i === data!.reject_reasons.length - 1 ? 0 : 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                      <span>{r.reason}</span>
                      <b style={{ color: "#ef4444" }}>{r.count} 人</b>
                    </div>
                    <div className="funnel-analysis-bar">
                      <div
                        className="funnel-analysis-fill"
                        style={{ width: `${Math.max(3, (r.count / data!.reject_reasons[0].count) * 100)}%`, background: "#ef4444" }}
                      />
                    </div>
                  </div>
                ))}
              </Card>
            </Col>
          )}
        </Row>
      )}
    </div>
  );
}
