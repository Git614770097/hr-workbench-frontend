import { useState, useEffect, useMemo, useRef } from "react";
import {
  Modal, Select, Input, Button, Alert, Tag, Typography, message, Divider, Spin,
} from "antd";
import { DownloadOutlined, PrinterOutlined } from "@ant-design/icons";
import { api } from "../api";
import type { Talent, DocTemplate } from "../types";
import { extractPlaceholders, getPlaceholderValues, fillTemplate, exportAsWord, printDoc } from "../utils/template";
import RichTextEditor from "./RichTextEditor";

interface Props {
  template: DocTemplate | null;
  onClose: () => void;
}

// 一键套用生成：选人才 → 自动替换占位符 → 缺失的补 → 富文本预览微调 → 导出
export default function GenerateDocModal({ template, onClose }: Props) {
  const [talents, setTalents] = useState<Talent[]>([]);
  const [talentSearching, setTalentSearching] = useState(false);
  const [talentId, setTalentId] = useState<string | undefined>(undefined);
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const [editedHtml, setEditedHtml] = useState("");
  const [touched, setTouched] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 远程搜索人才（输入关键字实时查，避免一次只加载前 100 条找不到人）
  const fetchTalents = (q: string) => {
    setTalentSearching(true);
    api.getTalents({ page: 1, limit: 30, q })
      .then((res) => setTalents(res.items))
      .catch(() => {})
      .finally(() => setTalentSearching(false));
  };

  useEffect(() => {
    if (!template) return;
    fetchTalents("");
    setTalentId(undefined);
    setManualValues({});
    setEditedHtml("");
    setTouched(false);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template?.id]);

  const onSearch = (v: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => fetchTalents(v), 300);
  };

  const talent = talents.find((t) => t.id === talentId) || null;

  const placeholders = useMemo(
    () => (template ? extractPlaceholders(template.content) : []),
    [template]
  );
  // 每个占位符当前值（自动填充 / 手动填写 / 待填）
  const preview = useMemo(
    () => (template ? getPlaceholderValues(template.content, talent, manualValues) : []),
    [template, talent, manualValues]
  );
  const filledCount = preview.filter((p) => p.value).length;

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
          {/* 第一步：选择人才（远程搜索） */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <span style={{ flexShrink: 0 }}>套用人才：</span>
            <Select
              style={{ flex: 1 }}
              showSearch
              allowClear
              filterOption={false}
              loading={talentSearching}
              onSearch={onSearch}
              notFoundContent={talentSearching ? <Spin size="small" /> : "未找到匹配人才"}
              placeholder="搜索并选择人才，自动填充姓名、手机号、公司、职位等信息"
              value={talentId}
              onChange={(v) => { setTalentId(v); setTouched(false); }}
              options={talents.map((t) => ({
                label: `${t.name}${t.current_company ? ` · ${t.current_company}` : ""}${t.current_title ? ` · ${t.current_title}` : ""}`,
                value: t.id,
              }))}
            />
          </div>

          {/* 第二步：占位符填充核对（列出全部占位符，可覆盖任何一项） */}
          {placeholders.length > 0 && (
            <div style={{ marginBottom: 12, padding: 12, background: "#fafafa", borderRadius: 8 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  占位符填充核对（共 {placeholders.length} 个，已填 {filledCount}）
                </Typography.Text>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "8px 16px" }}>
                {preview.map(({ key, value, auto }) => (
                  <div key={key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{ flexShrink: 0, fontSize: 13, color: "#666", width: 72, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title={key}
                    >
                      {key}
                    </span>
                    <Input
                      size="small"
                      status={value ? undefined : "warning"}
                      placeholder={value ? undefined : `请输入${key}`}
                      value={manualValues[key] ?? value}
                      onChange={(e) => { setManualValues((prev) => ({ ...prev, [key]: e.target.value })); setTouched(false); }}
                    />
                    <Tag
                      style={{ flexShrink: 0, marginInlineEnd: 0 }}
                      color={value ? (auto ? "green" : "blue") : "orange"}
                    >
                      {value ? (auto ? "自动" : "手动") : "待填"}
                    </Tag>
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
            {preview.filter((p) => p.auto).length > 0 && (
              <Tag>自动填充 {preview.filter((p) => p.auto).length} 处</Tag>
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
