import { useEffect, useState } from "react";
import { Select, Spin, message } from "antd";
import { api } from "../api";
import type { FunnelResponse } from "../types";
import { useIdentityProfile } from "../useIdentity";
import { termFor } from "../identityProfiles";

const TIME_RANGES = [
  { label: "全部时间", value: 0 },
  { label: "近 30 天", value: 30 },
  { label: "近 90 天", value: 90 },
  { label: "近 180 天", value: 180 },
];

const SEG_NAMES = ["简历 → 首面", "首面 → Offer", "Offer → 入职"];
const SEG_COLORS = ["#3b82f6", "#06b6d4", "#f59e0b"];

const pct = (v: number) => `${(v * 100).toFixed(v >= 0.1 || v === 0 ? 0 : 1)}%`;
const dayText = (v: number | null) => (v == null ? "—" : `${Math.round(v * 10) / 10} 天`);

export default function MFunnel() {
  const [data, setData] = useState<FunnelResponse | null>(null);
  const [jobs, setJobs] = useState<{ id: string; title: string; status: string }[]>([]);
  const [jobFilter, setJobFilter] = useState("");
  const [daysFilter, setDaysFilter] = useState(0);
  const [loading, setLoading] = useState(true);
  const profile = useIdentityProfile();

  const load = async () => {
    setLoading(true);
    try {
      setData(
        await api.getFunnel({
          job_id: jobFilter || undefined,
          days: daysFilter || undefined,
        })
      );
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobFilter, daysFilter]);

  useEffect(() => {
    api.getJobOptions().then((r) => setJobs(r.map((j) => ({ id: j.id, title: j.title, status: j.status })))).catch(() => {});
  }, []);

  const s = data?.summary;
  const stages = data?.stages || [];
  // 条宽基准取顶层人数（与桌面 ECharts 的 max 口径一致），否则首级撑不满
  const top = stages.length ? stages[0].count : 0;
  const segs = data
    ? [data.cycles.segments.s1, data.cycles.segments.s2, data.cycles.segments.s3]
    : [null, null, null];
  const segTotal = segs.every((d) => d != null) ? segs.reduce((a, b) => (a || 0) + (b || 0), 0) : null;

  return (
    <div>
      <div className="m-filter">
        <Select
          placeholder={termFor(profile, "全部岗位")}
          allowClear
          value={jobFilter || undefined}
          onChange={(v) => setJobFilter(v || "")}
          options={jobs.map((j) => ({
            value: j.id,
            label: j.status === "closed" ? `${j.title}（已关闭）` : j.title,
          }))}
          style={{ flex: 1 }}
        />
        <Select
          value={daysFilter}
          onChange={setDaysFilter}
          options={TIME_RANGES.map((t) => ({ value: t.value, label: t.label }))}
          style={{ width: 116, flex: "none" }}
        />
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "40px 0" }}>
          <Spin />
        </div>
      ) : !data || !s || s.total === 0 ? (
        <div className="m-empty">当前条件下暂无招聘数据</div>
      ) : (
        <>
          <div className="m-stats">
            <div className="m-stat">
              <div className="m-stat-num">{s.total}</div>
              <div className="m-stat-label">进入流程</div>
            </div>
            <div className="m-stat">
              <div className="m-stat-num">{s.in_progress}</div>
              <div className="m-stat-label">进行中</div>
            </div>
            <div className="m-stat is-good">
              <div className="m-stat-num">{s.hired}</div>
              <div className="m-stat-label">已入职</div>
            </div>
            <div className="m-stat">
              <div className="m-stat-num">{pct(s.overall_rate)}</div>
              <div className="m-stat-label">转化率</div>
            </div>
          </div>

          <div className="m-section-title">阶段漏斗</div>
          <div className="m-funnel">
            {stages.map((st) => (
              <div key={st.key} className="m-funnel-row">
                <div className="m-funnel-head">
                  <span>{st.label}</span>
                  <span className="m-funnel-num">
                    {st.count}
                    {st.prev_count !== st.count ? (
                      <span className="m-funnel-rate"> · {pct(st.rate)}</span>
                    ) : null}
                  </span>
                </div>
                <div className="m-funnel-track">
                  <div
                    className="m-funnel-fill"
                    style={{
                      width: `${top ? Math.max((st.count / top) * 100, 3) : 0}%`,
                      background: st.color,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="m-hint">人数按「曾到达」口径：到过该阶段即计入，因此逐级递减</div>

          <div className="m-section-title">招聘周期</div>
          <div className="m-card">
            <div className="m-cycle-main">
              <span className="m-cycle-num">{dayText(data!.cycles.total.avg)}</span>
              <span className="m-cycle-label">全流程平均</span>
            </div>
            <div className="m-kv">
              <div className="m-kv-item">
                <span className="m-kv-k">中位数</span>
                <span className="m-kv-v">{dayText(data!.cycles.total.p50)}</span>
              </div>
              <div className="m-kv-item">
                <span className="m-kv-k">90 分位</span>
                <span className="m-kv-v">{dayText(data!.cycles.total.p90)}</span>
              </div>
              <div className="m-kv-item">
                <span className="m-kv-k">样本</span>
                <span className="m-kv-v">{data!.cycles.total.n} 名入职者</span>
              </div>
            </div>
          </div>

          {segTotal ? (
            <div className="m-card">
              <div className="m-section-title" style={{ marginTop: 0 }}>耗时构成</div>
              {segs.map((d, i) => (
                <div key={SEG_NAMES[i]} className="m-funnel-row">
                  <div className="m-funnel-head">
                    <span>{SEG_NAMES[i]}</span>
                    <span className="m-funnel-num">
                      {d == null ? "—" : `${Math.round(d * 10) / 10} 天`}
                      <span className="m-funnel-rate">
                        {" · "}
                        {d == null ? "—" : `${Math.round(((d || 0) / (segTotal || 1)) * 100)}%`}
                      </span>
                    </span>
                  </div>
                  <div className="m-funnel-track">
                    <div
                      className="m-funnel-fill"
                      style={{
                        width: `${Math.max((((d || 0) as number) / (segTotal || 1)) * 100, 3)}%`,
                        background: SEG_COLORS[i],
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {data!.sources?.length ? (
            <>
              <div className="m-section-title">渠道效果</div>
              <div className="m-card">
                {data!.sources.map((src) => (
                  <div key={src.source} className="m-list-row">
                    <span className="m-list-main">{src.source}</span>
                    <span className="m-list-sub">
                      入职 {src.hired}/{src.entered}
                      {src.rate != null ? ` · ${pct(src.rate)}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {data!.reject_reasons?.length ? (
            <>
              <div className="m-section-title">淘汰原因</div>
              <div className="m-card">
                {data!.reject_reasons.map((r) => (
                  <div key={r.reason} className="m-list-row">
                    <span className="m-list-main">{r.reason}</span>
                    <span className="m-list-sub">{r.count} 人次</span>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
