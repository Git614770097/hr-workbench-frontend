import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { Card, Button, Select, Space, Table, Empty, Spin, Tooltip, message } from "antd";
import {
  ReloadOutlined, SearchOutlined, FunnelPlotOutlined,
  ThunderboltOutlined, RiseOutlined, ClockCircleOutlined, TeamOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import type { FunnelResponse, FunnelStayItem, Job, User } from "../types";
import FunnelChartView from "../components/FunnelChart";

const labelStyle: React.CSSProperties = { flexShrink: 0, fontSize: 13, color: "#8c8c8c" };

const TIME_RANGES = [
  { label: "全部时间", value: 0 },
  { label: "近 30 天", value: 30 },
  { label: "近 90 天", value: 90 },
  { label: "近 180 天", value: 180 },
];

// 百分比展示
const pct = (v: number) => `${(v * 100).toFixed(v >= 0.1 || v === 0 ? 0 : 1)}%`;
// 天数展示
const dayText = (v: number | null) => (v == null ? "—" : `${v} 天`);
// 时间戳（本地）
const nowText = () =>
  new Date().toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

export default function Funnel() {
  const [data, setData] = useState<FunnelResponse | null>(null);
  const [jobs, setJobs] = useState<Pick<Job, "id" | "title" | "status">[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState("");

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
      setUpdatedAt(nowText());
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

  // 各阶段停留明细（表格用，仅保留主线 5 级）
  const stayMap: Record<string, FunnelStayItem> = Object.fromEntries(
    (data?.stage_stay || []).map((x) => [x.key, x])
  );

  return (
    <div className="funnel-page">
      {/* 页面头 */}
      <div className="page-head">
        <div className="page-head-main">
          <h1 className="page-title">招聘漏斗</h1>
          <p className="page-desc">
            从简历入库到入职的逐级转化与周期分析，用来定位「卡在哪一环」
            {updatedAt && ` · 数据更新于 ${updatedAt}`}
          </p>
        </div>
        <div className="page-stats">
          <div className="stat">
            <span className="stat-num">{s?.total ?? 0}</span>
            <span className="stat-label">进入流程</span>
          </div>
          <div className="stat-sep" />
          <div className="stat">
            <span className="stat-num" style={{ color: "#0ea5e9" }}>{s?.in_progress ?? 0}</span>
            <span className="stat-label">招聘中</span>
          </div>
          <div className="stat-sep" />
          <div className="stat">
            <span className="stat-num" style={{ color: "#10b981" }}>{s?.hired ?? 0}</span>
            <span className="stat-label">已入职</span>
          </div>
          <div className="stat-sep" />
          <div className="stat">
            <span className="stat-num" style={{ color: "#f59e0b" }}>
              {s ? pct(s.overall_rate) : "—"}
            </span>
            <span className="stat-label">整体转化率</span>
          </div>
          <div className="stat-sep" />
          <div className="stat">
            <span className="stat-num" style={{ color: "#6366f1" }}>
              {data ? (data.cycles.total == null ? "—" : data.cycles.total) : "—"}
            </span>
            <span className="stat-label">平均招聘周期(天)</span>
          </div>
        </div>
      </div>

      {/* 筛选 */}
      <Card style={{ marginBottom: 16 }} styles={{ body: { padding: 16 } }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={labelStyle}>岗位</span>
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
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={labelStyle}>时间范围</span>
            <Select
              style={{ width: "100%" }}
              value={draftDays}
              onChange={(v) => setDraftDays(v)}
              options={TIME_RANGES}
            />
          </div>
          {isAdmin && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={labelStyle}>创建人</span>
              <Select
                style={{ width: "100%" }} allowClear placeholder="全部"
                value={draftOwner || undefined}
                onChange={(v) => setDraftOwner(v || "")}
                options={users.map((u) => ({ label: u.name, value: u.id }))}
                showSearch
                optionFilterProp="label"
              />
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
        <>
          {/* 主漏斗 */}
          <Card
            title={<Space><FunnelPlotOutlined />转化漏斗</Space>}
            style={{ marginBottom: 16 }}
            styles={{ body: { padding: "20px 24px" } }}
            extra={
              <Tooltip title="阶段人数按「曾到达」统计：只要候选人到过该阶段就计入，因此漏斗逐级递减，不会因为后期淘汰而回退">
                <span style={{ fontSize: 12, color: "#8c8c8c" }}>统计口径说明</span>
              </Tooltip>
            }
          >
            <FunnelChartView
              stages={stages}
              stageStay={data!.stage_stay}
              dark={isDark}
              height={stages.length * 82 + 48}
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

          {/* 周期指标 */}
          <div className="funnel-kpi-grid">
            <Card className="funnel-kpi" styles={{ body: { padding: "16px 18px" } }}>
              <div className="funnel-kpi-head">
                <ThunderboltOutlined style={{ color: "#0ea5e9" }} />
                简历到首面
              </div>
              <div className="funnel-kpi-value" style={{ color: "#0ea5e9" }}>
                {dayText(data!.cycles.tti)}
              </div>
              <div className="funnel-kpi-foot">
                入库到首次面试 · 样本 {data!.cycles.tti_n} 人
              </div>
            </Card>
            <Card className="funnel-kpi" styles={{ body: { padding: "16px 18px" } }}>
              <div className="funnel-kpi-head">
                <RiseOutlined style={{ color: "#6366f1" }} />
                面试到 Offer
              </div>
              <div className="funnel-kpi-value" style={{ color: "#6366f1" }}>
                {dayText(data!.cycles.to_offer)}
              </div>
              <div className="funnel-kpi-foot">
                首面到发出 Offer · 样本 {data!.cycles.to_offer_n} 人
              </div>
            </Card>
            <Card className="funnel-kpi" styles={{ body: { padding: "16px 18px" } }}>
              <div className="funnel-kpi-head">
                <TeamOutlined style={{ color: "#f59e0b" }} />
                Offer 到入职
              </div>
              <div className="funnel-kpi-value" style={{ color: "#f59e0b" }}>
                {dayText(data!.cycles.to_hire)}
              </div>
              <div className="funnel-kpi-foot">
                接受 Offer 到实际到岗 · 样本 {data!.cycles.to_hire_n} 人
              </div>
            </Card>
            <Card className="funnel-kpi" styles={{ body: { padding: "16px 18px" } }}>
              <div className="funnel-kpi-head">
                <ClockCircleOutlined style={{ color: "#10b981" }} />
                全流程周期
              </div>
              <div className="funnel-kpi-value" style={{ color: "#10b981" }}>
                {dayText(data!.cycles.total)}
              </div>
              <div className="funnel-kpi-foot">
                入库到入职 · 样本 {data!.cycles.total_n} 人
              </div>
            </Card>
          </div>

          {/* 阶段明细 */}
          <Card
            title="阶段明细"
            style={{ marginTop: 16 }}
            styles={{ body: { padding: 0 } }}
          >
            <Table
              className="profiles-table"
              rowKey="key"
              size="small"
              pagination={false}
              dataSource={stages.filter((x) => x.key !== "hired")}
              columns={[
                {
                  title: "阶段",
                  dataIndex: "label",
                  width: 160,
                  render: (v: string, r: any) => (
                    <Space size={8}>
                      <span className="funnel-dot" style={{ background: r.color }} />
                      <span style={{ fontWeight: 500 }}>{v}</span>
                    </Space>
                  ),
                },
                {
                  title: "人数",
                  dataIndex: "count",
                  width: 100,
                  align: "right",
                  render: (v: number) => <b>{v}</b>,
                },
                {
                  title: "较上一级",
                  dataIndex: "rate",
                  width: 150,
                  align: "right",
                  render: (v: number, r: any) => {
                    if (r.key === stages[0]?.key) return <span style={{ color: "#bfbfbf" }}>—</span>;
                    const bad = v < 0.5;
                    return (
                      <Tooltip title={`上一级 ${r.prev_count} 人，本阶段 ${r.count} 人`}>
                        <span style={{ color: bad ? "#ef4444" : "#10b981", fontWeight: 500 }}>
                          {pct(v)}
                        </span>
                      </Tooltip>
                    );
                  },
                },
                {
                  title: "流失",
                  dataIndex: "drop",
                  width: 90,
                  align: "right",
                  render: (v: number, r: any) =>
                    r.key === stages[0]?.key ? (
                      <span style={{ color: "#bfbfbf" }}>—</span>
                    ) : (
                      <span style={{ color: v > 0 ? "#fa8c16" : "#bfbfbf" }}>{v > 0 ? `-${v}` : "0"}</span>
                    ),
                },
                {
                  title: "累计转化",
                  dataIndex: "overall_rate",
                  width: 110,
                  align: "right",
                  render: (v: number) => <span style={{ color: "#8c8c8c" }}>{pct(v)}</span>,
                },
                {
                  title: "当前停留均长",
                  key: "stay",
                  width: 130,
                  align: "right",
                  render: (_: any, r: any) => {
                    const st = stayMap[r.key];
                    if (!st || st.avg_days == null) return <span style={{ color: "#bfbfbf" }}>—</span>;
                    return (
                      <Tooltip title={`当前有 ${st.count} 人处于该阶段`}>
                        <span style={{ color: st.avg_days >= 7 ? "#fa541c" : "#595959" }}>
                          {st.avg_days} 天
                        </span>
                      </Tooltip>
                    );
                  },
                },
              ]}
              scroll={{ x: 740 }}
            />
          </Card>

          {/* 结论文案 */}
          <Card style={{ marginTop: 16 }} styles={{ body: { padding: "14px 18px" } }}>
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
                if (data!.cycles.total != null && data!.cycles.total > 30) {
                  hints.push(`全流程平均耗时 ${data!.cycles.total} 天，超过 30 天偏慢，注意长尾候选人`);
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
        </>
      )}
    </div>
  );
}
