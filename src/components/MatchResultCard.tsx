import { Card, Tag, Progress, Button, Space, Typography, Tooltip, Empty } from "antd";
import {
  CheckCircleTwoTone, CloseCircleTwoTone, QuestionCircleTwoTone, ExclamationCircleTwoTone,
  TrophyOutlined, FileTextOutlined, UserAddOutlined, SendOutlined,
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

/**
 * 硬指标的几种状态：达标 / 未达标 / 资历偏高（超出上限，不算不合格）/ 无法判定。
 * over 特用于经验年限：7 年遇到「3-5 年」画像是"资历偏高、薪资可能谈不拢"，
 * 跟"只有 1 年经验"完全不是一回事，必须分开显示，否则会误导筛选。
 */
function HardTag({ label, text, ok, over }: { label: string; text: string; ok: boolean | null; over?: boolean }) {
  if (ok === true && over) {
    return (
      <Tooltip title="超过画像的年限上限：资历偏高，薪资预期可能需要确认">
        <Tag icon={<ExclamationCircleTwoTone twoToneColor="#faad14" />} color="warning">{label}：{text}（超出区间）</Tag>
      </Tooltip>
    );
  }
  if (ok === true) {
    return <Tag icon={<CheckCircleTwoTone twoToneColor="#52c41a" />} color="success">{label}：{text}</Tag>;
  }
  if (ok === false) {
    return <Tag icon={<CloseCircleTwoTone twoToneColor="#ff4d4f" />} color="error">{label}：{text || "未体现"}</Tag>;
  }
  return (
    <Tooltip title="画像未设要求，或简历里没写，无法判定">
      <Tag icon={<QuestionCircleTwoTone twoToneColor="#bfbfbf" />}>{label}：{text || "未知"}</Tag>
    </Tooltip>
  );
}

function BulletList({ title, items, color }: { title: string; items: string[]; color: string }) {
  if (!items || items.length === 0) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color, marginBottom: 4 }}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: 18, color: "#4b5563", fontSize: 13, lineHeight: 1.9 }}>
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
  const title = [talent.current_title, talent.current_company].filter(Boolean).join(" @ ");

  return (
    <Card
      size="small"
      style={{ marginBottom: 12, borderLeft: `3px solid ${rank === 1 ? "#f59e0b" : "#e5e7eb"}` }}
      title={
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {rank === 1 ? (
            <Tag icon={<TrophyOutlined />} color="gold" style={{ marginRight: 0 }}>最佳人选</Tag>
          ) : (
            <span style={{ color: "#9ca3af", fontSize: 13 }}>第 {rank} 名</span>
          )}
          <span style={{ fontSize: 15, fontWeight: 600 }}>{talent.name || talent.fileName || "未识别姓名"}</span>
          {title && <span style={{ color: "#6b7280", fontSize: 13 }}>{title}</span>}
          <Tag color={color} style={{ marginInlineEnd: 0 }}>{result.verdict}</Tag>
          {result.source === "rule" && (
            <Tooltip title="未配置 AI 密钥或 AI 调用失败，分数按硬性条件估算">
              <Tag>规则估算</Tag>
            </Tooltip>
          )}
          {savedId && <Tag color="blue">已录入人才库</Tag>}
        </div>
      }
      extra={
        <Progress
          type="circle"
          size={54}
          percent={result.score}
          strokeColor={color}
          format={(p) => <span style={{ fontSize: 15, fontWeight: 600 }}>{p}</span>}
        />
      }
    >
      {result.summary && (
        <Typography.Paragraph style={{ marginBottom: 10, color: "#374151" }}>
          {result.summary}
        </Typography.Paragraph>
      )}

      {/* 级别落位：画像分级时，展示候选人落在哪个级别、该级别市场薪资 */}
      {result.level && (
        <div style={{ marginBottom: 10, fontSize: 13 }}>
          <Space size={[6, 6]} wrap>
            <Tag color="geekblue">{result.level.name}</Tag>
            {result.level.min_years != null || result.level.max_years != null ? (
              <span style={{ color: "#6b7280" }}>
                {result.level.min_years ?? 0}~{result.level.max_years ?? "不限"} 年
              </span>
            ) : null}
            {(result.level.salary_min != null || result.level.salary_max != null) && (
              <Tooltip title={`该级别市场薪资${result.level.salary_note ? `（${result.level.salary_note}）` : ""}`}>
                <Tag color="gold">
                  市场薪资 {Math.round((result.level.salary_min ?? 0) / 1000)}K-{Math.round((result.level.salary_max ?? result.level.salary_min ?? 0) / 1000)}K
                </Tag>
              </Tooltip>
            )}
            {result.level.below && result.level.gap_years != null && (
              <Tag color="orange">低于「{result.level.name}」{result.level.gap_years} 年</Tag>
            )}
            {result.level.above && (
              <Tag color="cyan">超出最高级别</Tag>
            )}
          </Space>
        </div>
      )}

      {/* 硬性条件：规则判定，一眼看出卡在哪 */}
      <Space size={[6, 6]} wrap>
        <HardTag label="学历" text={hard.education.actual || "简历未体现"} ok={hard.education.ok} />
        <HardTag
          label="经验"
          text={hard.years.actual != null ? `${hard.years.actual} 年` : "简历未体现"}
          ok={hard.years.ok}
          over={hard.years.over}
        />
        <HardTag label="城市" text={hard.city.actual || "简历未体现"} ok={hard.city.ok} />
      </Space>

      {hard.must_skills && (hard.must_skills.hit.length > 0 || hard.must_skills.miss.length > 0) && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 4 }}>必备技能</div>
          <Space size={[6, 6]} wrap>
            {hard.must_skills.hit.map((s) => (
              <Tag key={s} icon={<CheckCircleTwoTone twoToneColor="#52c41a" />} color="success">{s}</Tag>
            ))}
            {hard.must_skills.miss.map((s) => (
              <Tag key={s} icon={<CloseCircleTwoTone twoToneColor="#ff4d4f" />} color="error">{s}</Tag>
            ))}
          </Space>
        </div>
      )}

      {hard.nice_skills && hard.nice_skills.hit.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 4 }}>加分项命中</div>
          <Space size={[6, 6]} wrap>
            {hard.nice_skills.hit.map((s) => <Tag key={s} color="gold">{s}</Tag>)}
          </Space>
        </div>
      )}

      {result.reasons.length === 0 && result.gaps.length === 0 && result.risks.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="AI 未给出详细结论，可查看简历原文自行判断"
          style={{ margin: "12px 0" }}
        />
      ) : (
        <>
          <BulletList title="推荐理由" items={result.reasons} color="#10b981" />
          <BulletList title="与画像的差距" items={result.gaps} color="#f59e0b" />
          <BulletList title="用人风险" items={result.risks} color="#ef4444" />
          <BulletList title="面试建议追问" items={result.questions} color="#3b82f6" />
        </>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
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
        <span style={{ color: "#9ca3af", fontSize: 12, alignSelf: "center" }}>
          {fromLibrary
            ? "来自人才库（已有记录）"
            : `来自 ${talent.fileName}${talent._ai ? "（AI 解析）" : "（本地规则解析）"}`}
        </span>
      </div>
    </Card>
  );
}
