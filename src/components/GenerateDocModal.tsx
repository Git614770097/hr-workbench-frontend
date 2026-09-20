import { useState, useEffect, useMemo } from "react";
import {
  Modal, Select, Input, Button, Alert, Tag, Typography, message, Divider,
} from "antd";
import { DownloadOutlined, PrinterOutlined } from "@ant-design/icons";
import { api } from "../api";
import type { Talent, DocTemplate } from "../types";
import { extractPlaceholders, isAutoFillable, fillTemplate, exportAsWord, printDoc } from "../utils/template";
import RichTextEditor from "./RichTextEditor";

interface Props {
  template: DocTemplate | null;
  onClose: () => void;
}

// 一键套用生成：选人才 → 自动替换占位符 → 缺失的手动补 → 富文本预览微调 → 导出
export default function GenerateDocModal({ template, onClose }: Props) {
  const [talents, setTalents] = useState<Talent[]>([]);
  const [talentId, setTalentId] = useState<string | undefined>(undefined);
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const [editedHtml, setEditedHtml] = useState("");
  const [touched, setTouched] = useState(false);

  // 加载人才列表（用于套用选择）
  useEffect(() => {
    if (!template) return;
    api.getTalents({ page: 1, limit: 100 }).then((res) => setTalents(res.items)).catch(() => {});
    setTalentId(undefined);
    setManualValues({});
    setEditedHtml("");
    setTouched(false);
  }, [template?.id]);

  const talent = talents.find((t) => t.id === talentId) || null;

  const placeholders = useMemo(
    () => (template ? extractPlaceholders(template.content) : []),
    [template]
  );
  // 需要手动填写的占位符（人才字段覆盖不到的）
  const manualKeys = useMemo(
    () => placeholders.filter((k) => !isAutoFillable(k)),
    [placeholders]
  );

  const { html: generated, missing } = useMemo(() => {
    if (!template) return { html: "", missing: [] as string[] };
    return fillTemplate(template.content, talent, manualValues);
  }, [template, talent, manualValues]);

  // 用户手动改过的内容以 editedHtml 为准，否则用自动生成的
  const finalHtml = touched ? editedHtml : generated;

  const handleExport = () => {
    if (!template) return;
    if (missing.length > 0 && !touched) {
      message.warning(`还有 ${missing.length} 个占位符未填写，导出文档中会显示为【占位符】标记`);
    }
    exportAsWord(`${template.name}-${talent?.name || "未署名"}`, finalHtml);
  };

  return (
    <Modal
      title={`套用生成 - ${template?.name || ""}`}
      open={!!template}
      onCancel={onClose}
      width={920}
      footer={null}
      destroyOnClose
    >
      {template && (
        <div>
          {/* 第一步：选择人才 */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <span style={{ flexShrink: 0 }}>套用人才：</span>
            <Select
              style={{ flex: 1 }}
              showSearch
              allowClear
              placeholder="请选择人才，自动填充姓名、手机号、公司、职位等信息"
              optionFilterProp="label"
              value={talentId}
              onChange={(v) => { setTalentId(v); setTouched(false); }}
              options={talents.map((t) => ({
                label: `${t.name}${t.current_company ? ` · ${t.current_company}` : ""}${t.current_title ? ` · ${t.current_title}` : ""}`,
                value: t.id,
              }))}
            />
          </div>

          {/* 第二步：手动补充人才信息覆盖不到的占位符 */}
          {manualKeys.length > 0 && (
            <div style={{ marginBottom: 12, padding: 12, background: "#fafafa", borderRadius: 8 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
                以下占位符无法从人才档案自动填充，请手动补充：
              </Typography.Text>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px 16px" }}>
                {manualKeys.map((key) => (
                  <div key={key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ flexShrink: 0, fontSize: 13, color: "#666", maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={key}>{key}</span>
                    <Input
                      size="small"
                      placeholder={`请输入${key}`}
                      value={manualValues[key] || ""}
                      onChange={(e) => { setManualValues((prev) => ({ ...prev, [key]: e.target.value })); setTouched(false); }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {missing.length > 0 && !touched && (
            <Alert
              style={{ marginBottom: 12 }}
              type="warning"
              showIcon
              message={`${missing.length} 个占位符未填写：${missing.map((k) => `【${k}】`).join(" ")}，请在上方补充或直接在下方文档中修改`}
            />
          )}

          {/* 第三步：富文本预览与微调 */}
          <Divider style={{ margin: "8px 0" }}>生成预览（可直接编辑排版）</Divider>
          <div style={{ marginBottom: 8 }}>
            {talent && <Tag color="green">已套用：{talent.name}</Tag>}
            {placeholders.filter((k) => isAutoFillable(k)).length > 0 && (
              <Tag>自动填充 {placeholders.filter((k) => isAutoFillable(k)).length} 处</Tag>
            )}
          </div>
          <RichTextEditor
            value={finalHtml}
            onChange={(html) => { setEditedHtml(html); setTouched(true); }}
            minHeight={340}
          />

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <Button onClick={onClose}>取消</Button>
            <Button icon={<PrinterOutlined />} onClick={() => printDoc(template.name, finalHtml)}>打印 / 存 PDF</Button>
            <Button type="primary" icon={<DownloadOutlined />} onClick={handleExport}>导出 Word</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
