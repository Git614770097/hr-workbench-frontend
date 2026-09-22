import { Table, Tag, Progress, Tooltip } from "antd";
import {
  TrophyOutlined, CheckCircleFilled, CloseCircleFilled,
  QuestionCircleFilled, ExclamationCircleFilled,
} from "@ant-design/icons";
import { VERDICT_COLORS } from "../types";
import type { MatchResult } from "../types";
import type { ParsedTalent } from "../utils/resumeImport";

export interface CompareItem {
  key: string;
  talent: ParsedTalent;
  result: MatchResult;
  fileName: string;
  fromLibrary?: boolean;
}

interface CompareRow {
  key: string;
  label: string;
  /** 该行的单元格渲染：result / talent / 名次下标（0 = 最佳） */
  cell: (r: MatchResult, t: ParsedTalent, i: number) => React.ReactNode;
}

/** 硬指标的达标态图标：与结果卡片同一套语义色（达标绿 / 未达标红 / 资历偏高黄 / 未知灰） */
function StateIcon({ ok, over }: { ok: boolean | null; over?: boolean }) {
  if (ok === true && over) return <ExclamationCircleFilled style={{ color: "#d97706", fontSize: 12 }} />;
  if (ok === true) return <CheckCircleFilled style={{ color: "#52c41a", fontSize: 12 }} />;
  if (ok === false) return <CloseCircleFilled style={{ color: "#ff4d4f", fontSize: 12 }} />;
  return <QuestionCircleFilled style={{ color: "#bfbfbf", fontSize: 12 }} />;
}

/** 硬指标单元格：图标 + 实际值，红/黄/绿一眼区分，未体现的灰化 */
function HardValue({
  actual, ok, over, suffix,
}: {
  actual: string;
  ok: boolean | null;
  over?: boolean;
  suffix?: string;
}) {
  const color =
    ok === true && over ? "#d97706" : ok === true ? "#111827" : ok === false ? "#dc2626" : "#8c8c8c";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13 }}>
      <StateIcon ok={ok} over={over} />
      <span style={{ fontWeight: 600, color }}>{actual || "未体现"}</span>
      {suffix && actual && <span style={{ color: "#9ca3af", fontSize: 12 }}>{suffix}</span>}
    </span>
  );
}

/** 长文本行：只显示首条，鼠标悬停看全部（对比表要的是"能横向扫视"，不是完整阅读） */
function TextCell({ items, empty, tone }: { items: string[]; empty: string; tone: string }) {
  if (!items || items.length === 0) {
    return <span style={{ fontSize: 12, color: "#bfbfbf" }}>{empty}</span>;
  }
  const first = items[0];
  const tip = items.length > 1 ? items.join("\n") : "";
  const node = (
    <span
      style={{
        fontSize: 13, color: tone, lineHeight: 1.6,
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
        overflow: "hidden",
      }}
    >
      {first}
      {items.length > 1 && <span style={{ color: "#9ca3af" }}> 等 {items.length} 条</span>}
    </span>
  );
  return tip ? <Tooltip title={<div style={{ whiteSpace: "pre-wrap" }}>{tip}</div>}>{node}</Tooltip> : node;
}

/**
 * 匹配结果对比表：**列 = 候选人，行 = 对比维度**。
 * 这样同一个维度是横向排列的，比逐张卡片往下翻更容易看出"谁强在哪儿、谁卡在哪一项"。
 * 顺序与卡片视图一致（按分数从高到低），最佳人选在表头带奖杯、分数标金。
 */
export default function MatchCompareTable({ items }: { items: CompareItem[] }) {
  const rows: CompareRow[] = [
    {
      key: "score",
      label: "匹配度",
      cell: (r, _t, i) => (
        <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
          {i === 0 && <TrophyOutlined style={{ color: "#f59e0b", fontSize: 13 }} />}
          <span style={{ fontSize: 22, fontWeight: 700, color: VERDICT_COLORS[r.verdict] || "#3b82f6" }}>
            {r.score}
          </span>
          <span style={{ fontSize: 12, color: "#9ca3af" }}>分</span>
          {r.source === "rule" && (
            <Tooltip title="未配置 AI 密钥或 AI 调用失败，按硬性条件估算">
              <Tag style={{ marginInlineStart: 4, marginInlineEnd: 0, fontSize: 11 }}>规则估算</Tag>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      key: "verdict",
      label: "结论",
      cell: (r) => (
        <Tag
          color={VERDICT_COLORS[r.verdict] || "#3b82f6"}
          style={{ marginInlineEnd: 0, fontWeight: 600, fontSize: 13 }}
        >
          {r.verdict}
        </Tag>
      ),
    },
    {
      key: "level",
      label: "落位级别",
      cell: (r) =>
        r.level ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
            <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>「{r.level.name}」</Tag>
            {r.level.below && (
              <Tooltip title={`低于该级别最低年限${r.level.gap_years != null ? ` ${r.level.gap_years} 年` : ""}`}>
                <Tag color="orange" style={{ marginInlineEnd: 0 }}>年限不足</Tag>
              </Tooltip>
            )}
            {r.level.above && <Tag color="cyan" style={{ marginInlineEnd: 0 }}>超最高级别</Tag>}
          </span>
        ) : (
          <span style={{ fontSize: 12, color: "#bfbfbf" }}>不分级</span>
        ),
    },
    {
      key: "salary",
      label: "市场薪资",
      cell: (r) => {
        const { salary_min: lo, salary_max: hi, salary_note: note } = r.level || {};
        if (lo == null && hi == null) return <span style={{ fontSize: 12, color: "#bfbfbf" }}>未提供</span>;
        const k = (v: number | null | undefined) => Math.round((v ?? 0) / 1000);
        return (
          <Tooltip title={note || ""}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "#b45309" }}>
              {k(lo)}K-{k(hi || lo)}K
            </span>
          </Tooltip>
        );
      },
    },
    {
      key: "education",
      label: "学历",
      cell: (r) => <HardValue actual={r.hard.education.actual} ok={r.hard.education.ok} />,
    },
    {
      key: "years",
      label: "工作经验",
      cell: (r) => (
        <HardValue
          actual={r.hard.years.actual != null ? `${r.hard.years.actual}` : ""}
          ok={r.hard.years.ok}
          over={r.hard.years.over}
          suffix="年"
        />
      ),
    },
    {
      key: "city",
      label: "工作城市",
      cell: (r) => <HardValue actual={r.hard.city.actual} ok={r.hard.city.ok} />,
    },
    {
      key: "skills",
      label: "必备技能",
      cell: (r) => {
        const hit = r.hard.must_skills?.hit ?? [];
        const miss = r.hard.must_skills?.miss ?? [];
        const total = hit.length + miss.length;
        if (total === 0) return <span style={{ fontSize: 12, color: "#bfbfbf" }}>画像未指定</span>;
        const pct = Math.round((hit.length / total) * 100);
        const full = hit.length === total;
        return (
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: full ? "#059669" : "#d97706" }}>
                {hit.length}/{total} 命中
              </span>
            </div>
            <Progress percent={pct} showInfo={false} size="small" strokeColor={full ? "#10b981" : "#f59e0b"} trailColor="#f0f0f0" />
            {miss.length > 0 && (
              <div style={{ marginTop: 5, display: "flex", gap: 4, flexWrap: "wrap" }}>
                {miss.slice(0, 3).map((s) => (
                  <Tag key={s} color="error" style={{ marginInlineEnd: 0, fontSize: 11 }}>{s}</Tag>
                ))}
                {miss.length > 3 && <span style={{ fontSize: 11, color: "#9ca3af" }}>+{miss.length - 3}</span>}
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: "nice",
      label: "加分项",
      cell: (r) => {
        const hit = r.hard.nice_skills?.hit ?? [];
        if (hit.length === 0) return <span style={{ fontSize: 12, color: "#bfbfbf" }}>无</span>;
        return (
          <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
            {hit.slice(0, 3).map((s) => (
              <Tag key={s} color="gold" style={{ marginInlineEnd: 0, fontSize: 11 }}>{s}</Tag>
            ))}
            {hit.length > 3 && <span style={{ fontSize: 11, color: "#9ca3af" }}>+{hit.length - 3}</span>}
          </span>
        );
      },
    },
    {
      key: "reasons",
      label: "推荐理由",
      cell: (r) => <TextCell items={r.reasons} empty="AI 未给出" tone="#065f46" />,
    },
    {
      key: "gaps",
      label: "主要差距",
      cell: (r) => <TextCell items={r.gaps} empty="无明显差距" tone="#92400e" />,
    },
    {
      key: "risks",
      label: "用人风险",
      cell: (r) => <TextCell items={r.risks} empty="未发现明显风险" tone="#991b1b" />,
    },
  ];

  const columns = [
    {
      title: "对比项",
      dataIndex: "label",
      key: "label",
      width: 92,
      fixed: "left" as const,
      render: (v: string) => (
        <span style={{ fontSize: 12, color: "#6b7280", fontWeight: 600 }}>{v}</span>
      ),
    },
    ...items.map((it, i) => ({
      key: it.key,
      width: 220,
      title: (
        <div style={{ padding: "2px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                fontSize: 12, fontWeight: 700,
                background: i === 0 ? "linear-gradient(135deg,#fbbf24,#f59e0b)" : "#f3f4f6",
                color: i === 0 ? "#fff" : "#6b7280",
              }}
            >
              {i === 0 ? <TrophyOutlined /> : i + 1}
            </span>
            <span
              style={{
                fontWeight: 600, color: "#111827", fontSize: 13,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}
            >
              {it.talent.name || "未识别姓名"}
            </span>
          </div>
          <div
            style={{
              fontSize: 11, color: "#9ca3af", marginTop: 2,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}
          >
            {[it.talent.current_title, it.talent.current_company].filter(Boolean).join(" @ ") || it.fileName}
          </div>
        </div>
      ),
      render: (_: unknown, row: CompareRow) => row.cell(it.result, it.talent, i),
    })),
  ];

  return (
    <Table
      size="small"
      bordered
      rowKey="key"
      pagination={false}
      dataSource={rows}
      columns={columns}
      scroll={{ x: "max-content" }}
    />
  );
}
