import { useState, useEffect } from "react";
import {
  Modal, Button, Input, InputNumber, Select, Typography, Spin, Alert, Tag, Tooltip, DatePicker,
} from "antd";
import dayjs from "dayjs";
import { STATUS_LABELS } from "../types";
import { useDict } from "../dict";
import type { ParsedTalent } from "../utils/resumeImport";

import { api } from "../api";
import AiResultCard from "./AiResultCard";
import AiInsightView, { insightToText } from "./AiInsightView";

interface Props {
  record: ParsedTalent | null;
  /** 当前第几份（0-based） */
  index: number;
  /** 队列总数 */
  total: number;
  saving: boolean;
  /** 批量确认进度（null = 未在批量中）：核对弹窗内常驻显示，避免长时间无反馈 */
  batchProgress: { current: number; total: number } | null;
  onChange: (field: keyof ParsedTalent, value: unknown) => void;
  onSave: () => void;
  /** 全部确认：剩余记录一次性录入，不再逐份点保存 */
  onConfirmAll: () => void;
  onSkip: () => void;
  onClose: () => void;
}

// 逐份核对弹窗：左侧简历原文预览（PDF 用 iframe / Word 用 mammoth 转 HTML），
// 右侧解析字段（可直接改），点「保存并录入」才写入人才库并保存原始简历。
export default function ImportPreviewModal({
  record, index, total, saving, batchProgress, onChange, onSave, onConfirmAll, onSkip, onClose,
}: Props) {
  const { education: educationOptions } = useDict();
  const [pdfUrl, setPdfUrl] = useState("");
  const [docText, setDocText] = useState("");
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState("");

  const file = record?.file || null;
  const fname = file?.name.toLowerCase() || "";
  const isPdf = fname.endsWith(".pdf");
  const isWord = fname.endsWith(".docx") || fname.endsWith(".doc");

  // 换到下一份时重置预览并按格式重新渲染
  useEffect(() => {
    setPdfUrl("");
    setDocText("");
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
          // Word 预览走服务端抽文本（浏览器不再下载 mammoth 350KB）。
          // 纯文本展示：核对看的是内容，格式简化可接受。
          const r = await api.parseResumeFile(file, false);
          if (!cancelled) setDocText(r.text);
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
      title={record ? `核对${file ? "简历" : "记录"}（第 ${index + 1} / ${total} ${file ? "份" : "条"}）` : "核对"}
      open={!!record}
      onCancel={onClose}
      width="92%"
      style={{ top: 20 }}
      // 弹窗嵌套：项目没配 getPopupContainer，antd Modal 默认就地渲染，
      // 核对弹窗会变成上传弹窗 DOM 的子节点，层级与裁切都不可控。
      // 强制挂到 body 并显式抬高 z-index（上传 1000 < 核对 1050 < 确认框 1100），
      // 避免确认框被压在下面变成「点了没反应」。
      getContainer={() => document.body}
      zIndex={1050}
      destroyOnClose
      maskClosable={false}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            确认无误点「保存并录入」即写入{"人才库"}{file ? "并保存原始简历" : ""}；不想要的点「移除」。
          </Typography.Text>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <Button onClick={onClose}>关闭</Button>
            <Button danger onClick={onSkip} disabled={saving}>移除</Button>
            {total > 1 && (
              <Tooltip title="按当前解析结果直接录入剩余全部，不再逐份核对（不做逐条查重）">
                <Button loading={saving} onClick={onConfirmAll}>全部确认（剩余 {total} 份）</Button>
              </Tooltip>
            )}
            <Button type="primary" loading={saving} onClick={onSave}>保存并录入</Button>
          </div>
        </div>
      }
    >
      {/* 手工录入提示：解析失败的文件转成了空白记录，得让用户知道「为什么是空的、
          该看哪里」。不提示的话，用户只会看到一张全空的表单，以为系统又出错了。 */}
      {record?._manualReason && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="这份没能自动解析，需要你对照左侧原文件填写"
          description={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              原因：{record._manualReason}
            </Typography.Text>
          }
        />
      )}
      {/* 图片识别提示：OCR 出来的数字容易错（0/O、1/l、小数点），必须点名让人核对 */}
      {record?._ocr && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="这份是图片型 PDF，文字由识别生成，请重点核对手机号、出生年月与薪资"
        />
      )}

      {/* 批量确认进度：常驻在弹窗内，长耗时操作不能只靠 toast */}
      {batchProgress && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={`正在批量录入 ${batchProgress.current} / ${batchProgress.total} 份，请勿关闭页面`}
        />
      )}
      {record && (
        <div style={{ display: "flex", gap: 16, alignItems: "stretch" }}>
          {/* 左：简历原文。没有文件时整块不渲染，右侧字段区自动占满 */}
          {file && (
          <div style={{ flex: "1 1 55%", minWidth: 0 }}>
            <div style={{ marginBottom: 6, fontSize: 12, color: "#888" }}>
              <Tag color="blue" style={{ marginInlineEnd: 6 }}>{record.fileName || "无文件"}</Tag>简历原文
            </div>
            {isPdf ? (
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
                  style={{
                    height: "66vh", overflow: "auto", padding: 12,
                    whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.7,
                  }}
                >
                  {docText}
                </div>
              )
            ) : (
              <Alert type="warning" showIcon message={`暂不支持预览 ${fname || "该格式"} 文件`} />
            )}
          </div>
          )}

          {/* 右：解析字段（可编辑） */}
          <div style={{ flex: file ? "1 1 45%" : "1 1 100%", minWidth: 0, overflowY: "auto", maxHeight: "70vh", paddingRight: 4 }}>
            <div style={{ marginBottom: 6, fontSize: 12, color: "#888", display: "flex", alignItems: "center", gap: 8 }}>
              解析字段（可直接修改）
              {record._ai
                ? <Tag color="green" style={{ marginInlineEnd: 0 }}>AI 解析</Tag>
                : <Tag color="orange" style={{ marginInlineEnd: 0 }}>本地规则解析 · 建议重点核对</Tag>}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "72px 1fr", rowGap: 8, columnGap: 8, alignItems: "center" }}>
              <label style={{ fontSize: 13, color: "#5b6472" }}>姓名</label>
              <Input size="small" value={record.name} placeholder="请输入姓名" {...missing(record.name)} onChange={(e) => onChange("name", e.target.value)} />

              <label style={{ fontSize: 13, color: "#5b6472" }}>手机号</label>
              <Input size="small" value={record.phone} placeholder="请输入手机号" {...missing(record.phone)} onChange={(e) => onChange("phone", e.target.value)} />

              <label style={{ fontSize: 13, color: "#5b6472" }}>邮箱</label>
              <Input size="small" value={record.email} placeholder="请输入邮箱" onChange={(e) => onChange("email", e.target.value)} />

              <label style={{ fontSize: 13, color: "#5b6472" }}>
                出生年月
                {record.birth_date ? (
                  <span style={{ color: "#94a3b8", marginLeft: 4 }}>
                    （{dayjs().diff(dayjs(record.birth_date), "year")} 岁）
                  </span>
                ) : null}
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <DatePicker
                  size="small"
                  picker="month"
                  // estimated（按年龄反推）的生日不在这里显示——那会冒充「用户确认过 1 月出生」，
                  // 推算值只出现在右侧年龄框里，补选真实年月后自动升级为 month 精度。
                  value={record.birth_date && record.birth_date_precision !== "estimated" ? dayjs(record.birth_date) : undefined}
                  placeholder={record.age && !record.birth_date ? `原简历写 ${record.age} 岁，可在右侧直接输年龄` : "出生年月"}
                  style={{ flex: 1, minWidth: 0 }}
                  onChange={(v) => {
                    // 三个字段一起改：生日是事实源，年龄只是它的派生值。
                    // 选到月就存当月 1 号 + month 精度，后端读取时按生日实时算年龄。
                    onChange("birth_date", v ? v.format("YYYY-MM-01") : "");
                    onChange("birth_date_precision", v ? "month" : "");
                    onChange("age", v ? dayjs().diff(v, "year") : null);
                  }}
                />
                <InputNumber
                  size="small"
                  min={14}
                  max={80}
                  style={{ width: 108, flexShrink: 0 }}
                  placeholder="或输年龄"
                  addonAfter="岁"
                  // 已有精确/到月生日时年龄是派生值，只读展示，
                  // 防止手输年龄把真实生日覆盖成推算值
                  disabled={!!record.birth_date && record.birth_date_precision !== "estimated"}
                  value={record.birth_date ? dayjs().diff(dayjs(record.birth_date), "year") : (record.age ?? undefined)}
                  onChange={(v) => {
                    if (v == null) {
                      // 清空年龄：只有「推算」出来的生日才连带清掉，解析/手选的不动
                      if (record.birth_date_precision === "estimated") {
                        onChange("birth_date", "");
                        onChange("birth_date_precision", "");
                      }
                      onChange("age", null);
                      return;
                    }
                    // 输年龄反推出生年：存当年 1 月 1 日 + estimated 精度，
                    // 详情页会打「推算」标签（误差最多 1 岁），读取时年龄按生日实时算
                    const year = dayjs().year() - v;
                    onChange("birth_date", `${year}-01-01`);
                    onChange("birth_date_precision", "estimated");
                    onChange("age", v);
                  }}
                />
              </div>

              <label style={{ fontSize: 13, color: "#5b6472" }}>性别</label>
              <Select size="small" value={record.gender || undefined} allowClear placeholder="性别" style={{ width: "100%" }} onChange={(v) => onChange("gender", v || "")} options={[{ label: "男", value: "男" }, { label: "女", value: "女" }]} />

              <label style={{ fontSize: 13, color: "#5b6472" }}>学历</label>
              <Select size="small" value={record.education || undefined} allowClear placeholder="请选择学历" style={{ width: "100%" }} onChange={(v) => onChange("education", v || "")} options={educationOptions.map((e) => ({ label: e, value: e }))} />

              <label style={{ fontSize: 13, color: "#5b6472" }}>院校</label>
              <Input size="small" value={record.school} placeholder="请输入院校" onChange={(e) => onChange("school", e.target.value)} />

              <label style={{ fontSize: 13, color: "#5b6472" }}>专业</label>
              <Input size="small" value={record.major} placeholder="请输入所学专业" onChange={(e) => onChange("major", e.target.value)} />

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

            {/* AI 解读（入库前预审）：此时还没有人才 id，用解析字段做通用解读，
                帮 HR 在「保存并录入」前判断这人值不值得进库。
                key 挂 record.key：切到下一条时重置结果，避免看到上一条的解读 */}
            <AiResultCard
              key={`insight-${record.key}`}
              title="AI 解读（入库前预审）"
              style={{ marginTop: 12 }}
              hint="点「生成」，AI 会基于当前解析字段给出亮点、风险与建议，帮你决定这条是否值得录入。"
              onGenerate={async () => {
                return (await api.aiResumeInsight({
                  pre_key: record.key,
                  fields: {
                    name: record.name,
                    age: record.age,
                    gender: record.gender,
                    education: record.education,
                    school: record.school,
                    current_company: record.current_company,
                    current_title: record.current_title,
                    years_experience: record.years_experience,
                    city: record.city,
                    skills: record.skills,
                    expected_salary: null,
                  },
                })) as unknown as Record<string, unknown>;
              }}
              toText={(d) => insightToText(d as import("../types").AiResumeInsight)}
              render={(d) => <AiInsightView data={d as import("../types").AiResumeInsight} />}
            />
          </div>
        </div>
      )}
    </Modal>
  );
}
