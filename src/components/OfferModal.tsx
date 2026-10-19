import { useState, useEffect, useCallback } from "react";
import { Modal, Select, Input, Button, Space, message, Alert, Typography, Divider } from "antd";
import { SendOutlined, DownloadOutlined } from "@ant-design/icons";
import { api } from "../api";
import type { BackgroundCheck, PipelineCard, DocTemplate } from "../types";
import { downloadBlob, dateStamp, escapeHtml } from "../utils/file";

/**
 * Offer 一键生成：选模板 → 自动填充候选人/岗位变量 → 预览 → 导出 Word 或直接发起审批。
 * 模板走现有 doc_templates（模板库「招聘入职」类别），支持 {{姓名}} 等占位符替换。
 */
export default function OfferModal({
  card,
  open,
  onClose,
  onApproved,
}: {
  card: PipelineCard | null;
  open: boolean;
  onClose: () => void;
  onApproved?: () => void;
}) {
  const [templates, setTemplates] = useState<DocTemplate[]>([]);
  const [tplId, setTplId] = useState<string | undefined>();
  const [salary, setSalary] = useState<string>("");
  const [position, setPosition] = useState<string>("");
  const [entryDate, setEntryDate] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [loadingTpl, setLoadingTpl] = useState(false);
  const [bg, setBg] = useState<BackgroundCheck | null>(null);
  const [bgLoading, setBgLoading] = useState(false);

  // 拉「招聘入职」类模板
  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const r = await api.getTemplates({ category: "招聘入职", limit: 100 });
        setTemplates(r.items);
        setTplId((prev) => prev ?? r.items[0]?.id);
      } catch (e) {
        message.error((e as Error).message);
      }
    })();
  }, [open]);

  // 打开时用卡片信息预填
  useEffect(() => {
    if (open && card) {
      setSalary("");
      setPosition(card.job_title || "");
      setEntryDate("");
    }
  }, [open, card]);

  // 背调结论随行：打开时按候选人拉最近一条背调，让「发不发 Offer」的决策现场能看到结论。
  // 失败静默——背调接口异常不该阻断 Offer 生成主流程。
  useEffect(() => {
    if (!open || !card?.talent_id) { setBg(null); return; }
    let alive = true;
    setBgLoading(true);
    (async () => {
      try {
        const r = await api.getBackgroundChecks({ talent_id: card.talent_id });
        if (!alive) return;
        // 列表已按「进行中优先 + 创建倒排」；优先取第一条未取消的
        setBg(r.items.find((x) => x.status !== "cancelled") || r.items[0] || null);
      } catch { if (alive) setBg(null); }
      finally { if (alive) setBgLoading(false); }
    })();
    return () => { alive = false; };
  }, [open, card]);

  /** 背调状态 → Offer 决策提示：fail 必须呛脸，pass 给绿灯，其余只报状态 */
  const bgHint = (): { type: "success" | "info" | "warning" | "error"; message: string; description?: string } | null => {
    if (!bg) return null;
    const sum = bg.summary?.trim();
    const snippet = sum ? (sum.length > 120 ? sum.slice(0, 120) + "…" : sum) : undefined;
    if (bg.status === "passed") return { type: "success", message: "背调已通过并入职", description: snippet };
    if (bg.result === "fail") return { type: "error", message: "背调结论：不建议通过", description: snippet || "请确认是否仍要继续发出 Offer。" };
    if (bg.result === "pass") return { type: "success", message: "背调结论：建议通过", description: snippet };
    if (bg.consent_status === "granted") return { type: "info", message: `背调进行中（${bg.status_label}）`, description: "结论出具后将显示在这里。" };
    return { type: "warning", message: `背调未获授权（${bg.consent_label}）`, description: "依据个人信息保护法，背调须取得候选人单独明示授权后方可开展。" };
  };
  const hint = !bgLoading && bg ? bgHint() : null;

  const tpl = templates.find((t) => t.id === tplId);

  /** 变量替换：{{姓名}} {{岗位}} {{薪资}} {{入职日期}} 等 */
  const filled = useCallback(() => {
    if (!tpl || !card) return "";
    const map: Record<string, string> = {
      姓名: card.name,
      候选人: card.name,
      岗位: card.job_title || "",
      应聘岗位: card.job_title || "",
      部门: card.job_department || "",
      城市: card.job_city || card.city || "",
      学历: card.education || "",
      经验: card.years_experience != null ? `${card.years_experience} 年` : "",
      薪资: salary,
      职位: position || card.job_title || "",
      入职日期: entryDate,
      报到日期: entryDate,
      日期: new Date().toLocaleDateString("zh-CN"),
    };
    return tpl.content.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, key: string) => {
      const v = map[key.trim()];
      return v !== undefined && v !== "" ? v : whole;
    });
  }, [tpl, card, salary, position, entryDate]);

  const handleExport = () => {
    if (!tpl || !card) return;
    const body = filled();
    const safeName = `${card.name}-${card.job_title || "Offer"}`.replace(/[\\/:*?"<>|]/g, "_");
    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(tpl.name)}</title>
<style>
  body { font-family: "SimSun", "宋体", serif; margin: 48px 56px; color: #222; font-size: 14px; line-height: 1.9; }
  h1 { text-align: center; font-size: 22px; margin: 0 0 8px; }
  .meta { text-align: center; color: #999; font-size: 12px; margin-bottom: 28px; }
  p { margin: 0.4em 0; }
</style></head><body>
<h1>${escapeHtml(tpl.name)}</h1>
<div class="meta">${escapeHtml(card.name)} · ${escapeHtml(card.job_title || "")} · 生成时间 ${new Date().toLocaleString("zh-CN")}</div>
${body}
</body></html>`;
    downloadBlob(new Blob(["\ufeff" + html], { type: "application/msword;charset=utf-8" }), `${safeName}_${dateStamp()}.doc`);
    message.success("Offer 已导出（Word）");
  };

  const handleSubmit = async () => {
    if (!card) return;
    setSubmitting(true);
    try {
      await api.createApprovalInstance({
        talent_job_id: card.link_id,
        scene: "offer",
        title: `${card.name} · ${card.job_title || ""} Offer 审批`,
        payload: { salary, position: position || card.job_title, entry_date: entryDate, template: tpl?.name },
      });
      message.success("已发起 Offer 审批，去「审批中心」查看进度");
      onApproved?.();
      onClose();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="生成 Offer"
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      destroyOnClose
    >
      {card ? (
        <div>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message={
              <span>
                候选人：<b>{card.name}</b>
                {card.job_title ? ` · 应聘岗位：${card.job_title}` : ""}
                {" · "}模板里的 <code>{"{{姓名}} {{岗位}}"}</code> 等占位符会自动替换
              </span>
            }
          />

          {bgLoading ? (
            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 16 }}>背调状态加载中…</Typography.Text>
          ) : hint ? (
            <Alert type={hint.type} showIcon style={{ marginBottom: 16 }}
              message={hint.message} description={hint.description} />
          ) : (
            <Alert type="info" showIcon style={{ marginBottom: 16 }}
              message="该候选人尚未发起背调"
              description="如该岗位需要背景调查，可到「背调中心」发起；取得授权并出具结论后将显示在这里。" />
          )}

          <Space direction="vertical" style={{ width: "100%" }} size={12}>
            <div>
              <Typography.Text strong>选择 Offer 模板</Typography.Text>
              <Select
                style={{ width: "100%", marginTop: 6 }}
                loading={loadingTpl}
                value={tplId}
                onChange={setTplId}
                placeholder="从模板库「招聘入职」中选择"
                options={templates.map((t) => ({ value: t.id, label: t.name }))}
              />
              {templates.length === 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  模板库「招聘入职」类别下暂无模板，请先到「模板库管理」新建一份 Offer 模板。
                </Typography.Text>
              ) : null}
            </div>

            <div style={{ display: "flex", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <Typography.Text strong>薪资</Typography.Text>
                <Input
                  style={{ marginTop: 6 }}
                  value={salary}
                  onChange={(e) => setSalary(e.target.value)}
                  placeholder="如：20-30K·14薪（替换 {{薪资}}）"
                />
              </div>
              <div style={{ flex: 1 }}>
                <Typography.Text strong>职位/岗位</Typography.Text>
                <Input
                  style={{ marginTop: 6 }}
                  value={position}
                  onChange={(e) => setPosition(e.target.value)}
                  placeholder="默认取应聘岗位"
                />
              </div>
              <div style={{ flex: 1 }}>
                <Typography.Text strong>入职/报到日期</Typography.Text>
                <Input
                  style={{ marginTop: 6 }}
                  value={entryDate}
                  onChange={(e) => setEntryDate(e.target.value)}
                  placeholder="如 2026-11-01"
                />
              </div>
            </div>

            <Divider orientation="left" plain>预览</Divider>
            <div
              style={{
                maxHeight: 260,
                overflow: "auto",
                border: "1px solid var(--color-border-tertiary)",
                borderRadius: 8,
                padding: 16,
                background: "var(--color-background-secondary)",
                fontSize: 13,
                lineHeight: 1.9,
              }}
              dangerouslySetInnerHTML={{ __html: filled() || "<p style='color:#999'>请先选择模板</p>" }}
            />

            <Space>
              <Button type="primary" icon={<DownloadOutlined />} onClick={handleExport} disabled={!tpl}>
                导出 Word 发给候选人
              </Button>
              <Button icon={<SendOutlined />} loading={submitting} onClick={handleSubmit} disabled={!card}>
                发起 Offer 审批
              </Button>
            </Space>
          </Space>
        </div>
      ) : null}
    </Modal>
  );
}
