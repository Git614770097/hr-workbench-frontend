import { Tooltip } from "antd";
import {
  CheckCircleFilled, CloseCircleFilled, QuestionCircleFilled, ExclamationCircleFilled,
} from "@ant-design/icons";
import { VERDICT_COLORS } from "../types";
import type { MatchHardCheck } from "../types";

/** 对比图的一行 = 一位候选人（调用方按匹配度总分从高到低传） */
export interface CompareRow {
  key: string;
  rank: number;
  name: string;
  score: number;
  verdict: string;
  /** 必备技能命中数 / 总数（画像没设必备技能时 total 为 0，该行不渲染技能条） */
  skillHit: number;
  skillTotal: number;
  hard?: MatchHardCheck;
}

/** 硬性条件状态点：达标 / 未达标 / 资历偏高 / 无法判定，hover 看详情 */
function HardDot({ label, ok, over }: { label: string; ok: boolean | null; over?: boolean }) {
  let cls = "is-null";
  let Icon = QuestionCircleFilled;
  let text = "无法判定";
  if (ok === true && over) {
    cls = "is-over"; Icon = ExclamationCircleFilled; text = "资历偏高";
  } else if (ok === true) {
    cls = "is-ok"; Icon = CheckCircleFilled; text = "达标";
  } else if (ok === false) {
    cls = "is-no"; Icon = CloseCircleFilled; text = "未达标";
  }
  return (
    <Tooltip title={`${label}：${text}`}>
      <span className={`match-cmp-dot ${cls}`}><Icon /></span>
    </Tooltip>
  );
}

/**
 * 匹配结果对比图：所有候选人同图对比，回答「先看谁、差多少、卡在哪」。
 * - 主条 = 匹配度总分（长度随分数，颜色随结论档位），虚线为全员均值
 * - 细条 = 必备技能命中率
 * - 右侧圆点 = 学历 / 经验 / 城市三项硬性条件
 * 纯 CSS 条形（不引图表库）：数据量小（行数=候选人数）、需要随评估进度
 * 实时增长，DOM 条形比 canvas 更轻，也和结果卡的视觉语言一致。
 */
export default function MatchCompareChart({ rows }: { rows: CompareRow[] }) {
  const avg = rows.length > 0
    ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length)
    : 0;

  return (
    <div className="match-compare">
      <div className="match-compare-head">
        <span className="match-compare-title">结果对比</span>
        <span className="match-compare-hint">
          主条 = 匹配度总分（颜色随结论）· 细条 = 必备技能命中 · 右侧圆点 = 学历 / 经验 / 城市
        </span>
        {rows.length >= 2 && <span className="match-compare-avg">均值 {avg} 分</span>}
      </div>
      <div className="match-compare-rows">
        {rows.map((r) => {
          const color = VERDICT_COLORS[r.verdict] || "#3b82f6";
          const skillPct = r.skillTotal > 0 ? Math.round((r.skillHit / r.skillTotal) * 100) : 0;
          return (
            <div className="match-cmp-row" key={r.key}>
              <div className="match-cmp-name">
                <span
                  className="match-cmp-rank"
                  style={r.rank === 1 ? { background: "linear-gradient(135deg,#fbbf24,#f59e0b)", color: "#fff" } : undefined}
                >
                  {r.rank}
                </span>
                <span className="match-cmp-nm" title={r.name}>{r.name}</span>
                <span className="match-cmp-verdict" style={{ color }}>{r.verdict}</span>
              </div>
              <div className="match-cmp-bars">
                <div className="match-cmp-bar is-total">
                  <div className="match-cmp-track">
                    <div className="match-cmp-fill" style={{ width: `${Math.min(100, Math.max(0, r.score))}%`, background: color }} />
                    {rows.length >= 2 && (
                      <div className="match-cmp-avgline" style={{ left: `${Math.min(100, Math.max(0, avg))}%` }} />
                    )}
                  </div>
                  <span className="match-cmp-val" style={{ color }}>{r.score}</span>
                </div>
                {r.skillTotal > 0 && (
                  <div className="match-cmp-bar is-skill">
                    <div className="match-cmp-track">
                      <div
                        className="match-cmp-fill"
                        style={{ width: `${skillPct}%`, background: skillPct === 100 ? "#10b981" : "#f59e0b" }}
                      />
                    </div>
                    <span className="match-cmp-val is-sm">{r.skillHit}/{r.skillTotal}</span>
                  </div>
                )}
              </div>
              <div className="match-cmp-hard">
                <HardDot label="学历" ok={r.hard?.education?.ok ?? null} />
                <HardDot label="经验" ok={r.hard?.years?.ok ?? null} over={r.hard?.years?.over} />
                <HardDot label="城市" ok={r.hard?.city?.ok ?? null} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
