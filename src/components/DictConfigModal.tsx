import { useState, useEffect } from "react";
import { Modal, Input, Button, Alert, message, Typography } from "antd";
import { api } from "../api";
import { useDict } from "../dict";
import { SOURCE_OPTIONS, REJECT_REASONS } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** 数据字典配置：来源渠道 / 淘汰原因。每行一项，保存后全站下拉立即生效。 */
export default function DictConfigModal({ open, onClose }: Props) {
  const { reload } = useDict();
  const [sourcesText, setSourcesText] = useState("");
  const [reasonsText, setReasonsText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.getDictConfig()
      .then((d) => {
        setSourcesText((d.sources?.length ? d.sources : SOURCE_OPTIONS).join("\n"));
        setReasonsText((d.reject_reasons?.length ? d.reject_reasons : REJECT_REASONS).join("\n"));
      })
      .catch(() => {
        setSourcesText(SOURCE_OPTIONS.join("\n"));
        setReasonsText(REJECT_REASONS.join("\n"));
      });
  }, [open]);

  const toList = (text: string): string[] =>
    [...new Set(text.split("\n").map((s) => s.trim()).filter(Boolean))];

  const handleSave = async () => {
    const sources = toList(sourcesText);
    const reject_reasons = toList(reasonsText);
    if (sources.length === 0 || reject_reasons.length === 0) {
      message.warning("两项都至少要保留一个选项");
      return;
    }
    setSaving(true);
    try {
      await api.setDictConfig({ sources, reject_reasons });
      await reload();
      message.success("数据字典已保存，全站选项已更新");
      onClose();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="数据字典设置" open={open} onCancel={onClose} footer={null} width={560}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="不同公司对「来源渠道」「淘汰原因」的叫法不一样，在这里改即可，无需改代码。"
        description="每行一个选项，保存后立即生效（招聘看板淘汰原因、录入/导入的来源下拉）。已存在的数据不受影响。"
      />
      <div style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 6, fontWeight: 600 }}>来源渠道</div>
        <Input.TextArea
          value={sourcesText}
          onChange={(e) => setSourcesText(e.target.value)}
          rows={6}
          placeholder={"BOSS直聘\n内推\n校招"}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          当前 {toList(sourcesText).length} 项
        </Typography.Text>
      </div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 6, fontWeight: 600 }}>淘汰原因</div>
        <Input.TextArea
          value={reasonsText}
          onChange={(e) => setReasonsText(e.target.value)}
          rows={6}
          placeholder={"薪资不匹配\n能力不达标"}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          当前 {toList(reasonsText).length} 项 · 漏斗页按此统计淘汰原因分布
        </Typography.Text>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button onClick={onClose}>取消</Button>
        <Button type="primary" loading={saving} onClick={handleSave}>
          保存
        </Button>
      </div>
    </Modal>
  );
}
