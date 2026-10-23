import { Card, Empty, Spin, Tooltip } from "antd";
import { ArrowRightOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import type { OverviewResponse } from "../types";
import { PIPELINE_STAGES } from "../types";

/**
 * 各阶段当前停留（快照口径）——原「招聘概览」并入漏斗页后保留的唯一模块。
 * 位置：漏斗页右栏「招聘周期」卡片下方（不再是页面顶部）。
 * 数据源：/api/overview 的 stageCounts = talent_jobs.stage 分组。
 * 纯展示组件：数据由漏斗页统一拉取后传入（漏斗页自己也要用这份数据，
 * 早期两边各拉一次同一接口，属于重复请求，已合并）。
 *
 * ⚠️ 与上方漏斗阶段图口径不同，别混读：
 *   - 本模块 = 此刻卡在哪一步（快照，数字小）
 *   - 漏斗图  = 曾经到过该阶段（job_stage_logs 去重，累计，数字大）
 */
export default function OverviewPanel({
  data,
  loading,
}: {
  data: OverviewResponse | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <Card className="dash-card" style={{ marginTop: 16 }}>
        <div style={{ textAlign: "center", padding: "1.25rem 0" }}>
          <Spin />
        </div>
      </Card>
    );
  }

  if (!data) {
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
      className="dash-card is-compact"
      style={{ marginTop: 16 }}
      styles={{ body: { padding: "12px 16px" } }}
      title={
        <Tooltip title="按 talent_jobs 当前阶段统计：此刻每位候选人卡在哪一步。与下方漏斗的「曾到达」累计口径不同，数字会更小。">
          <span>各阶段当前停留</span>
        </Tooltip>
      }
      extra={
        // 用 Link 而不是 <a onClick>：后者键盘不可达、也不能被浏览器当链接处理
        <Link to="/pipeline">
          看板 <ArrowRightOutlined />
        </Link>
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
