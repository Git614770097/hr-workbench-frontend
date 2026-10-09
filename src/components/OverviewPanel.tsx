import { useEffect, useState } from "react";
import { Card, Empty, Spin, Tooltip } from "antd";
import { ArrowRightOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import type { OverviewResponse } from "../types";
import { PIPELINE_STAGES } from "../types";
import { api } from "../api";

/**
 * 各阶段当前停留（快照口径）——原「招聘概览」并入漏斗页后保留的唯一模块。
 * 位置：漏斗页右栏「招聘周期」卡片下方（不再是页面顶部）。
 * 数据源：/api/overview 的 stageCounts = talent_jobs.stage 分组。
 *
 * ⚠️ 与上方漏斗阶段图口径不同，别混读：
 *   - 本模块 = 此刻卡在哪一步（快照，数字小）
 *   - 漏斗图  = 曾经到过该阶段（job_stage_logs 去重，累计，数字大）
 */
export default function OverviewPanel() {
  const navigate = useNavigate();
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .getOverview()
      .then((r) => {
        if (alive) {
          setData(r);
          setErr(null);
        }
      })
      .catch((e) => {
        // 概览是增强信息，拉取失败不该让整个漏斗页不可用
        if (alive) setErr(e instanceof Error ? e.message : "加载失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <Card className="dash-card" style={{ marginTop: 16 }}>
        <div style={{ textAlign: "center", padding: "1.25rem 0" }}>
          <Spin />
        </div>
      </Card>
    );
  }

  if (err || !data) {
    // 失败时静默降级：不展示卡片，其余漏斗内容照常
    return null;
  }

  const stageArr = PIPELINE_STAGES.map((s) => ({
    ...s,
    count: data.stageCounts[s.key] || 0,
  }));
  const stageMax = Math.max(1, ...stageArr.map((s) => s.count));

  return (
    <Card
      className="dash-card"
      style={{ marginTop: 16 }}
      title={
        <Tooltip title="按 talent_jobs 当前阶段统计：此刻每位候选人卡在哪一步。与下方漏斗的「曾到达」累计口径不同，数字会更小。">
          <span>各阶段当前停留</span>
        </Tooltip>
      }
      extra={
        <a onClick={() => navigate("/pipeline")}>
          看板 <ArrowRightOutlined />
        </a>
      }
    >
      {stageArr.every((s) => s.count === 0) ? (
        <Empty description="暂无在招流程" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <div className="dash-bars">
          {stageArr.map((s) => (
            <div className="dash-bar-row" key={s.key}>
              <span className="dash-bar-label" style={{ color: s.color }}>{s.label}</span>
              <span className="dash-bar-track">
                <span
                  className="dash-bar-fill"
                  style={{
                    width: `${(s.count / stageMax) * 100}%`,
                    background: s.color,
                    opacity: s.terminal ? 0.55 : 1,
                  }}
                />
              </span>
              <span className="dash-bar-num">{s.count}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
