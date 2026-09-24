import { Tag, Progress, Button, Space, Tooltip, Empty } from "antd";
import {
  TrophyOutlined, FileTextOutlined, UserAddOutlined, SendOutlined,
  CheckCircleFilled, CloseCircleFilled, QuestionCircleFilled, ExclamationCircleFilled,
} from "@ant-design/icons";
import { VERDICT_COLORS } from "../types";
import type { MatchResult } from "../types";
import type { ParsedTalent } from "../utils/resumeImport";

interface Props {
  rank: number;
  talent: ParsedTalent;
  result: MatchResult;
  /** 已在人才库里的人选（不需要、也不能再录入一次） */
  fromLibrary?: boolean;
  savedId: string | null;
  importing: boolean;
  onViewText: () => void;
  onImport: () => void;
  onAddToPipeline: () => void;
}

/** 结论 → 头部渐变的底色（越靠前越醒目，一眼区分档次） */
const VERDICT_BG: Record<string, string> = {
  强烈推荐: "rgba(16,185,129,.10)",
  推荐: "rgba(59,130,246,.10)",
  可考虑: "rgba(245,158,11,.10)",
  不建议: "rgba(239,68,68,.08)",
};

/**
 * 硬指标格子：达标 / 未达标 / 资历偏高 / 无法判定。
 * over 特用于经验年限：7 年遇到「3-5 年」画像是"资历偏高、薪资可能谈不拢"，
 * 跟"只有 1 年经验"完全不是一回事，必须分开显示，否则会误导筛选。
 */
function HardCell({
  label, actual, require, ok, over, tooltip,
}: {
  label: string;
  actual: string;
  require: string;
  ok: boolean | null;
  over?: boolean;
  tooltip?: string;
}) {
  let fg = "#6b7280", bg = "#fafafa", border = "#f0f0f0", status = "无法判定";
  let Icon = QuestionCircleFilled;
  if (ok === true && over) {
    fg = "#d97706"; bg = "#fffbeb"; border = "#fde68a"; status = "资历偏高";
    Icon = ExclamationCircleFilled;
  } else if (ok === true) {
    fg = "#059669"; bg = "#ecfdf5"; border = "#a7f3d0"; status = "达标";
    Icon = CheckCircleFilled;
  } else if (ok === false) {
    fg = "#dc2626"; bg = "#fef2f2"; border = "#fecaca"; status = "未达标";
    Icon = CloseCircleFilled;
  }

  const body = (
    <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: 8, padding: "8px 10px", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginBottom: 2 }}>
        <span style={{ fontSize: 12, color: "#6b7280" }}>{label}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: fg, display: "inline-flex", alignItems: "center", gap: 3, whiteSpace: "nowrap" }}>
          <Icon style={{ fontSize: 12, color: fg }} />
          {status}
        </span>
      </div>
      <div
        style={{
          fontSize: 14, fontWeight: 600, color: actual ? "#111827" : "#9ca3af",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}
      >
        {actual || "简历未体现"}
      </div>
      {require && <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 1 }}>要求 {require}</div>}
    </div>
  );

  return tooltip ? <Tooltip title={tooltip}>{body}</Tooltip> : body;
}

/** 结论分区：左边框 + 浅底色，比一列小字更容易扫读 */
function Panel({
  title, items, color, bg, emptyText,
}: {
  title: string;
  items: string[];
  color: string;
  bg: string;
  emptyText?: string;
}) {
  if (!items || items.length === 0) {
    if (!emptyText) return null;
    return (
      <div style={{ borderLeft: `3px solid #e5e7eb`, background: "#fafafa", borderRadius: "0 6px 6px 0", padding: "6px 12px", marginTop: 8 }}>
        <span style={{ fontSize: 13, color: "#9ca3af" }}>{title}：{emptyText}</span>
      </div>
    );
  }
  return (
    <div style={{ borderLeft: `3px solid ${color}`, background: bg, borderRadius: "0 6px 6px 0", padding: "8px 12px", marginTop: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color, marginBottom: 2 }}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: 16, color: "#4b5563", fontSize: 13, lineHeight: 1.8 }}>
        {items.map((t, i) => <li key={i}>{t}</li>)}
      </ul>
    </div>
  );
}

// 单个候选人的匹配结果卡片：分数 + 硬指标命中 + 理由/差距/风险 + 落地操作
export default function MatchResultCard({
  rank, talent, result, savedId, importing, fromLibrary, onViewText, onImport, onAddToPipeline,
}: Props) {
  const { hard } = result;
  const color = VERDICT_COLORS[result.verdict] || "#3b82f6";
  const bg = VERDICT_BG[result.verdict] || "rgba(59,130,246,.08)";
  const title = [talent.current_title, talent.current_company].filter(Boolean).join(" @ ");
  const isTop = rank === 1;

  const skillHit = hard.must_skills?.hit.length ?? 0;
  const skillTotal = skillHit + (hard.must_skills?.miss.length ?? 0);
  const skillPct = skillTotal > 0 ? Math.round((skillHit / skillTotal) * 100) : 0;
  const hasNarrative = result.reasons.length > 0 || result.gaps.length > 0 || result.risks.length > 0;

  return (
    <div
      style={{
        marginBottom: 12,
        background: "#fff",
        border: `1px solid ${isTop ? "#fcd34d" : "#e5e7eb"}`,
        borderRadius: 10,
        overflow: "hidden",
        boxShadow: isTop ? "0 3px 14px rgba(245,158,11,.16)" : "0 1px 3px rgba(0,0,0,.04)",
      }}
    >
      {/* ── 头部：排名 + 分数环 + 姓名/职位 + 结论/落位 ── */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
          padding: "14px 16px",
          background: `linear-gradient(90deg, ${bg} 0%, rgba(255,255,255,0) 70%)`,
          borderBottom: "1px solid #f3f4f6",
        }}
      >
        <div
          style={{
            width: 32, height: 32, borderRadius: "50%", flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 14, fontWeight: 700,
            background: isTop ? "linear-gradient(135deg,#fbbf24,#f59e0b)" : "#f3f4f6",
            color: isTop ? "#fff" : "#6b7280",
            boxShadow: isTop ? "0 2px 8px rgba(245,158,11,.4)" : "none",
          }}
        >
          {isTop ? <TrophyOutlined /> : rank}
        </div>

        <Progress
          type="circle"
          size={72}
          percent={result.score}
          strokeColor={color}
          strokeWidth={8}
          format={() => (
            <div style={{ lineHeight: 1.1 }}>
              <div style={{ fontSize: 22, fontWeight: 700, color }}>{result.score}</div>
              <div style={{ fontSize: 10, color: "#9ca3af" }}>匹配度</div>
            </div>
          )}
        />

        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
            {isTop && <Tag icon={<TrophyOutlined />} color="gold" style={{ marginInlineEnd: 0, fontWeight: 600 }}>最佳人选</Tag>}
            <span style={{ fontSize: 16, fontWeight: 700, color: "#111827" }}>
              {talent.name || talent.fileName || "未识别姓名"}
            </span>
            {title && <span style={{ color: "#6b7280", fontSize: 13 }}>{title}</span>}
          </div>
          <Space size={[6, 6]} wrap>
            <Tag color={color} style={{ marginInlineEnd: 0, fontWeight: 600, fontSize: 13 }}>{result.verdict}</Tag>
            {result.source === "rule" && (
              <Tooltip title="未配置 AI 密钥或 AI 调用失败，分数按硬性条件估算">
                <Tag style={{ marginInlineEnd: 0 }}>规则估算</Tag>
              </Tooltip>
            )}
            {savedId && <Tag color="blue" style={{ marginInlineEnd: 0 }}>已录入人才库</Tag>}
          </Space>
        </div>
      </div>

      {/* ── 正文 ── */}
      <div style={{ padding: "12px 16px 14px" }}>
        {result.summary && (
          <div style={{ fontSize: 14, color: "#374151", lineHeight: 1.7, marginBottom: 12 }}>
            {result.summary}
          </div>
        )}

        {/* 硬性条件速览：三格并列，一眼看出卡在哪一项 */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
          <HardCell
            label="学历"
            actual={hard.education.actual}
            require={hard.education.require}
            ok={hard.education.ok}
          />
          <HardCell
            label="工作经验"
            actual={hard.years.actual != null ? `${hard.years.actual} 年` : ""}
            require={hard.years.require}
            ok={hard.years.ok}
            over={hard.years.over}
            tooltip={hard.years.over ? "超过画像的年限上限：资历偏高，薪资预期可能需要确认" : undefined}
          />
          <HardCell
            label="工作城市"
            actual={hard.city.actual}
            require={hard.city.require}
            ok={hard.city.ok}
          />
        </div>

        {/* 必备技能命中 */}
        {skillTotal > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>必备技能</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: skillPct === 100 ? "#059669" : "#d97706" }}>
                {skillHit}/{skillTotal} 命中
              </span>
            </div>
            <Progress
              percent={skillPct}
              showInfo={false}
              size="small"
              strokeColor={skillPct === 100 ? "#10b981" : "#f59e0b"}
              trailColor="#f0f0f0"
            />
            <Space size={[6, 6]} wrap style={{ marginTop: 6 }}>
              {hard.must_skills.hit.map((s) => (
                <Tag key={s} icon={<CheckCircleFilled style={{ color: "#52c41a" }} />} color="success">{s}</Tag>
              ))}
              {hard.must_skills.miss.map((s) => (
                <Tag key={s} icon={<CloseCircleFilled style={{ color: "#ff4d4f" }} />} color="error">{s}</Tag>
              ))}
            </Space>
          </div>
        )}

        {/* 加分项命中 */}
        {hard.nice_skills && hard.nice_skills.hit.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 4 }}>加分项命中</div>
            <Space size={[6, 6]} wrap>
              {hard.nice_skills.hit.map((s) => <Tag key={s} color="gold">{s}</Tag>)}
            </Space>
          </div>
        )}

        {/* 结论分区 */}
        {!hasNarrative ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="AI 未给出详细结论，可查看简历原文自行判断"
            style={{ margin: "12px 0 0" }}
          />
        ) : (
          <>
            <Panel title="推荐理由" items={result.reasons} color="#059669" bg="#f0fdf4" emptyText="AI 未给出" />
            <Panel title="与画像的差距" items={result.gaps} color="#d97706" bg="#fffbeb" emptyText="无明显差距" />
            <Panel title="用人风险" items={result.risks} color="#dc2626" bg="#fef2f2" emptyText="未发现明显风险" />
            <Panel title="面试建议追问" items={result.questions} color="#2563eb" bg="#eff6ff" emptyText="无" />
          </>
        )}

        {/* 落地操作 */}
        <div style={{ display: "flex", gap: 8, marginTop: 12, paddingTop: 12, borderTop: "1px dashed #f0f0f0", flexWrap: "wrap", alignItems: "center" }}>
          <Button size="small" icon={<FileTextOutlined />} onClick={onViewText}>
            {fromLibrary ? "查看比对依据" : "查看简历原文"}
          </Button>
          {!fromLibrary && (
            <Button
              size="small"
              type={savedId ? "default" : "primary"}
              icon={<UserAddOutlined />}
              loading={importing}
              disabled={!!savedId}
              onClick={onImport}
            >
              {savedId ? "已录入" : "录入人才库"}
            </Button>
          )}
          <Button
            size="small"
            icon={<SendOutlined />}
            disabled={!savedId}
            title={savedId ? "" : "请先录入人才库，再加入招聘流程"}
            onClick={onAddToPipeline}
          >
            加入招聘流程
          </Button>
          <span style={{ color: "#9ca3af", fontSize: 12, marginLeft: "auto" }}>
            {fromLibrary
              ? "来自人才库（已有记录）"
              : `来自 ${talent.fileName}${talent._ai ? "（AI 解析）" : "（本地规则解析）"}`}
          </span>
        </div>
      </div>
    </div>
  );
}
