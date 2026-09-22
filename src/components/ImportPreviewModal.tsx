import { useState, useEffect } from "react";
import {
  Modal, Button, Input, InputNumber, Select, Typography, Spin, Alert, Tag,
} from "antd";
import mammoth from "mammoth";
import { EDUCATION_OPTIONS, STATUS_LABELS } from "../types";
import type { ParsedTalent } from "./ImportModal";

interface Props {
  record: ParsedTalent | null;
  /** 当前第几份（0-based） */
  index: number;
  /** 队列总数 */
  total: number;
  saving: boolean;
  onChange: (field: keyof ParsedTalent, value: unknown) => void;
  onSave: () => void;
  onSkip: () => void;
  onClose: () => void;
}

// 逐份核对弹窗：左侧简历原文预览（PDF 用 iframe / Word 用 mammoth 转 HTML），
// 右侧解析字段（可直接改），点「保存并录入」才写入人才库并保存原始简历。
export default function ImportPreviewModal({
  record, index, total, saving, onChange, onSave, onSkip, onClose,
}: Props) {
  const [pdfUrl, setPdfUrl] = useState("");
  const [docHtml, setDocHtml] = useState("");
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState("");

  const file = record?.file || null;
  const fname = file?.name.toLowerCase() || "";
  const isPdf = fname.endsWith(".pdf");
  const isWord = fname.endsWith(".docx") || fname.endsWith(".doc");

  // 换到下一份时重置预览并按格式重新渲染
  useEffect(() => {
    setPdfUrl("");
    setDocHtml("");
    setDocError("");
    if (!file) return;
    if (isPdf) {
      const url = URL.createObjectURL(file);
      setPdfUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    if (isWord) {
      let cancelled = false;
      setDocLoading(true);
      (async () => {
        try {
          const result = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
          if (!cancelled) setDocHtml(result.value);
        } catch (e) {
          if (!cancelled) setDocError((e as Error).message || "Word 解析失败");
        }
        if (!cancelled) setDocLoading(false);
      })();
      return () => { cancelled = true; };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.key]);

  const missing = (v: string) => (v ? {} : { status: "warning" as const });

  return (
    <Modal
      title={record ? `核对简历（第 ${index + 1} / ${total} 份）` : "核对简历"}
      open={!!record}
      onCancel={onClose}
      width="92%"
      style={{ top: 20 }}
      destroyOnClose
      maskClosable={false}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            确认无误点「保存并录入」即写入人才库并保存原始简历；不想要的点「跳过」。
          </Typography.Text>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <Button onClick={onClose}>关闭</Button>
            <Button danger onClick={onSkip} disabled={saving}>跳过</Button>
            <Button type="primary" loading={saving} onClick={onSave}>保存并录入</Button>
          </div>
        </div>
      }
    >
      {record && (
        <div style={{ display: "flex", gap: 16, alignItems: "stretch" }}>
          {/* 左：简历原文 */}
          <div style={{ flex: "1 1 55%", minWidth: 0 }}>
            <div style={{ marginBottom: 6, fontSize: 12, color: "#888" }}>
              <Tag color="blue" style={{ marginInlineEnd: 6 }}>{record.fileName || "无文件"}</Tag>简历原文
            </div>
            {!file ? (
              <Alert type="info" showIcon message="该记录无简历原文（来自 JSON 导入）" />
            ) : isPdf ? (
              pdfUrl ? (
                <iframe
                  src={pdfUrl}
                  title="简历原文"
                  style={{ width: "100%", height: "66vh", border: "1px solid #eee", borderRadius: 8 }}
                />
              ) : <Spin />
            ) : isWord ? (
              docLoading ? (
                <div style={{ textAlign: "center", padding: "3rem" }}>
                  <Spin />
                  <div style={{ marginTop: 8, color: "#888" }}>正在解析 Word 简历…</div>
                </div>
              ) : docError ? (
                <Alert type="error" showIcon message={docError} />
              ) : (
                <div
                  className="resume-doc-preview"
                  style={{ height: "66vh" }}
                  dangerouslySetInnerHTML={{ __html: docHtml }}
                />
              )
            ) : (
              <Alert type="warning" showIcon message={`暂不支持预览 ${fname || "该格式"} 文件`} />
            )}
          </div>

          {/* 右：解析字段（可编辑） */}
          <div style={{ flex: "1 1 45%", minWidth: 0, overflowY: "auto", maxHeight: "70vh", paddingRight: 4 }}>
            <div style={{ marginBottom: 6, fontSize: 12, color: "#888", display: "flex", alignItems: "center", gap: 8 }}>
              解析字段（可直接修改）
              {record._ai === true
                ? <Tag color="green" style={{ marginInlineEnd: 0 }}>AI 解析</Tag>
                : record._ai === false
                  ? <Tag color="orange" style={{ marginInlineEnd: 0 }}>本地规则解析 · 建议重点核对</Tag>
                  : <Tag style={{ marginInlineEnd: 0 }}>JSON 手工导入</Tag>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "72px 1fr", rowGap: 8, columnGap: 8, alignItems: "center" }}>
              <label style={{ fontSize: 13, color: "#5b6472" }}>姓名</label>
              <Input size="small" value={record.name} placeholder="请输入姓名" {...missing(record.name)} onChange={(e) => onChange("name", e.target.value)} />

              <label style={{ fontSize: 13, color: "#5b6472" }}>手机号</label>
              <Input size="small" value={record.phone} placeholder="请输入手机号" {...missing(record.phone)} onChange={(e) => onChange("phone", e.target.value)} />

              <label style={{ fontSize: 13, color: "#5b6472" }}>邮箱</label>
              <Input size="small" value={record.email} placeholder="请输入邮箱" onChange={(e) => onChange("email", e.target.value)} />

              <label style={{ fontSize: 13, color: "#5b6472" }}>年龄</label>
              <InputNumber size="small" min={16} max={80} value={record.age ?? undefined} placeholder="年龄" style={{ width: "100%" }} onChange={(v) => onChange("age", v ?? null)} />

              <label style={{ fontSize: 13, color: "#5b6472" }}>性别</label>
              <Select size="small" value={record.gender || undefined} allowClear placeholder="性别" style={{ width: "100%" }} onChange={(v) => onChange("gender", v || "")} options={[{ label: "男", value: "男" }, { label: "女", value: "女" }]} />

              <label style={{ fontSize: 13, color: "#5b6472" }}>学历</label>
              <Select size="small" value={record.education || undefined} allowClear placeholder="请选择学历" style={{ width: "100%" }} onChange={(v) => onChange("education", v || "")} options={EDUCATION_OPTIONS.map((e) => ({ label: e, value: e }))} />

              <label style={{ fontSize: 13, color: "#5b6472" }}>院校</label>
              <Input size="small" value={record.school} placeholder="请输入院校" onChange={(e) => onChange("school", e.target.value)} />

              <label style={{ fontSize: 13, color: "#5b6472" }}>当前公司</label>
              <Input size="small" value={record.current_company} placeholder="请输入当前公司" onChange={(e) => onChange("current_company", e.target.value)} />

              <label style={{ fontSize: 13, color: "#5b6472" }}>当前职位</label>
              <Input size="small" value={record.current_title} placeholder="请输入当前职位" onChange={(e) => onChange("current_title", e.target.value)} />

              <label style={{ fontSize: 13, color: "#5b6472" }}>年限</label>
              <InputNumber size="small" min={0} value={record.years_experience ?? undefined} placeholder="年限" style={{ width: "100%" }} onChange={(v) => onChange("years_experience", v ?? null)} />

              <label style={{ fontSize: 13, color: "#5b6472" }}>城市</label>
              <Input size="small" value={record.city} placeholder="请输入城市" onChange={(e) => onChange("city", e.target.value)} />

              <label style={{ fontSize: 13, color: "#5b6472" }}>技能</label>
              <Input size="small" value={record.skills} placeholder="技能，逗号分隔" onChange={(e) => onChange("skills", e.target.value)} />

              <label style={{ fontSize: 13, color: "#5b6472" }}>状态</label>
              <Select size="small" value={record.status} style={{ width: "100%" }} onChange={(v) => onChange("status", v)} options={Object.entries(STATUS_LABELS).map(([k, label]) => ({ label, value: k }))} />

              <label style={{ fontSize: 13, color: "#5b6472" }}>备注</label>
              <Input.TextArea size="small" value={record.notes} placeholder="备注" autoSize={{ minRows: 2, maxRows: 4 }} onChange={(e) => onChange("notes", e.target.value)} />
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
