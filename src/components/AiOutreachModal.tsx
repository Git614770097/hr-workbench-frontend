import { useEffect, useState } from "react";
import { Alert, Modal, Select, Space, Typography } from "antd";
import AiResultCard from "./AiResultCard";
import { api } from "../api";
import type {
  AiOutreach, AiOutreachScene, AiRejectTone, Talent, TalentPipelineItem,
} from "../types";
import {
  AI_OUTREACH_SCENE_LABELS, AI_REJECT_TONE_LABELS,
} from "../types";

// AI 沟通文案弹窗：选场景（邀约/婉拒/跟进）+ 选岗位 → 生成 → 复制。
// 铁律：系统只生成草稿，绝不代发——用户必须自己复制后发出去。
interface Props {
  open: boolean;
  talent: Talent | null;
  pipelines: TalentPipelineItem[];
  onClose: () => void;
}

export default function AiOutreachModal({ open, talent, pipelines, onClose }: Props) {
  const [scene, setScene] = useState<AiOutreachScene>("invite_wechat");
  const [tone, setTone] = useState<AiRejectTone>("warm");
  const [jobId, setJobId] = useState<string | null>(null);

  // 打开时重置：默认选中第一条投递的岗位（HR 最常沟通的就是在推进的那个）
  useEffect(() => {
    if (!open) return;
    setScene("invite_wechat");
    setTone("warm");
    setJobId(pipelines[0]?.job_id ?? null);
  }, [open, pipelines]);

  if (!talent) return null;

  const generate = async (): Promise<Record<string, unknown> | null> => {
    return (await api.aiOutreach({
      talent_id: talent.id,
      job_id: jobId,
      scene,
      ...(scene === "reject" ? { tone } : {}),
    })) as unknown as Record<string, unknown>;
  };

  const toText = (d: any): string => {
    const r = d as AiOutreach;
    const tips = r.tips?.length ? `\n\n使用建议：\n${r.tips.map((t) => `· ${t}`).join("\n")}` : "";
    return `${r.content}${tips}`;
  };

  return (
    <Modal
      title={`AI 沟通文案 · ${talent.name}`}
      open={open}
      onCancel={onClose}
      footer={null}
      width={620}
      destroyOnClose
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="文案由 AI 基于人才与岗位信息生成，仅供参考；请核对后自行复制发送，系统不会代发。"
      />
      <Space wrap style={{ marginBottom: 12 }}>
        <Space size={6}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>场景</Typography.Text>
          <Select
            size="small"
            value={scene}
            style={{ width: 140 }}
            onChange={(v: AiOutreachScene) => setScene(v)}
            options={(Object.keys(AI_OUTREACH_SCENE_LABELS) as AiOutreachScene[]).map((k) => ({
              value: k, label: AI_OUTREACH_SCENE_LABELS[k],
            }))}
          />
        </Space>
        {scene === "reject" && (
          <Space size={6}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>语气</Typography.Text>
            <Select
              size="small"
              value={tone}
              style={{ width: 130 }}
              onChange={(v: AiRejectTone) => setTone(v)}
              options={(Object.keys(AI_REJECT_TONE_LABELS) as AiRejectTone[]).map((k) => ({
                value: k, label: AI_REJECT_TONE_LABELS[k],
              }))}
            />
          </Space>
        )}
        {pipelines.length > 0 && (
          <Space size={6}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>岗位</Typography.Text>
            <Select
              size="small"
              value={jobId ?? undefined}
              style={{ width: 180 }}
              onChange={(v: string) => setJobId(v)}
              options={pipelines.map((p) => ({ value: p.job_id, label: p.job_title }))}
            />
          </Space>
        )}
      </Space>

      <AiResultCard
        key={`${scene}:${tone}:${jobId}`}
        title={outreachTitle(scene, tone)}
        onGenerate={generate}
        toText={toText}
        hint="选好场景后点「生成」。婉拒信默认「温暖挽留型」：先认可对方的具体经历，再说明情况并保留联系。"
        render={(d) => {
          const r = d as AiOutreach;
          return (
            <div>
              <Typography.Paragraph
                style={{ whiteSpace: "pre-wrap", marginBottom: 8, fontSize: 13 }}
              >
                {r.content}
              </Typography.Paragraph>
              {r.tips?.length ? (
                <div style={{ fontSize: 12, color: "#8c8c8c" }}>
                  {r.tips.map((t, i) => (
                    <div key={i}>· {t}</div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        }}
      />
    </Modal>
  );
}

function outreachTitle(scene: AiOutreachScene, tone: AiRejectTone): string {
  if (scene === "reject") return `婉拒信 · ${AI_REJECT_TONE_LABELS[tone]}`;
  return AI_OUTREACH_SCENE_LABELS[scene];
}
