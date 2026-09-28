import { useState, useEffect } from "react";
import { Modal, Form, Select, Input, message, Alert, Button } from "antd";
import { api } from "../api";
import type { Talent, Job } from "../types";
import { PIPELINE_STAGES } from "../types";

interface Props {
  open: boolean;
  /** 预选中的岗位（从岗位管理页「添加候选人」进入时使用） */
  presetJobId?: string | null;
  /** 预选中的人才（从人才详情页「加入岗位」进入时使用） */
  presetTalentId?: string | null;
  /** 批量模式：人才库多选后整批加入同一岗位（传入时忽略 presetTalentId） */
  presetTalentIds?: string[];
  onClose: () => void;
  onSuccess: () => void;
}

export default function AddToPipelineModal({ open, presetJobId, presetTalentId, presetTalentIds, onClose, onSuccess }: Props) {
  const [form] = Form.useForm();
  const [talents, setTalents] = useState<Talent[]>([]);
  const [jobs, setJobs] = useState<Pick<Job, "id" | "title" | "department" | "status">[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // 批量模式：人才已在外部选定，弹窗里只选岗位/阶段/备注
  const batchIds = presetTalentIds && presetTalentIds.length > 0 ? presetTalentIds : null;

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    // 人才库取前 500 条用于选择（导入场景外很少超过）
    Promise.all([
      api.getTalents({ page: 1, limit: 500 }),
      api.getJobOptions(),
    ])
      .then(([t, j]) => {
        setTalents(t.items);
        // 已关闭的岗位仍然可选（补录历史），但排在后面
        setJobs(j);
      })
      .catch((err) => message.error((err as Error).message))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      talent_id: presetTalentId || undefined,
      job_id: presetJobId || undefined,
      stage: "screening",
    });
  }, [open, presetJobId, presetTalentId]);

  const handleSubmit = async (values: { talent_id: string; job_id: string; stage: string; notes?: string }) => {
    if (!values.job_id) return;
    setSaving(true);
    try {
      if (batchIds) {
        const res = await api.batchAddToPipeline({
          talent_ids: batchIds, job_id: values.job_id,
          stage: values.stage, notes: values.notes,
        });
        const skip = res.skipped > 0 ? `，${res.skipped} 人已在流程中自动跳过` : "";
        message.success(`已把 ${res.added} 人加入「${res.job_title}」${skip}`);
      } else {
        const res = await api.addToPipeline(values);
        message.success(`「${res.talent_name}」已加入「${res.job_title}」的招聘看板`);
      }
      form.resetFields();
      onSuccess();
      onClose();
    } catch (err) {
      message.error((err as Error).message);
    }
    setSaving(false);
  };

  const openJobs = jobs.filter((j) => j.status !== "closed");
  const closedJobs = jobs.filter((j) => j.status === "closed");

  return (
    <Modal
      title="加入招聘看板"
      open={open}
      onCancel={onClose}
      width={560}
      footer={null}
      destroyOnClose
    >
      {jobs.length === 0 && !loading ? (
        <Alert
          type="warning"
          showIcon
          message="还没有岗位"
          description="招聘看板需要先有岗位。请先到「岗位管理」创建一个在招岗位，再回来添加候选人。"
        />
      ) : (
        <Form form={form} layout="horizontal" className="form-horizontal" labelCol={{ flex: "88px" }} onFinish={handleSubmit} initialValues={{ stage: "screening" }}>
          {batchIds ? (
            <Form.Item label="已选人才">
              <div>
                <span style={{ fontWeight: 600, marginRight: 8 }}>{batchIds.length} 人</span>
                {(() => {
                  const sel = talents.filter((t) => batchIds.includes(t.id));
                  const shown = sel.slice(0, 8).map((t) => t.name);
                  return (
                    <span style={{ color: "#8c8c8c", fontSize: 12 }}>
                      {shown.join("、")}{sel.length > 8 ? ` 等 ${sel.length} 人` : ""}
                    </span>
                  );
                })()}
              </div>
            </Form.Item>
          ) : (
            <Form.Item name="talent_id" label="人才" rules={[{ required: true, message: "请选择人才" }]}>
              <Select
                showSearch
                placeholder="搜索并选择人才（姓名 / 职位 / 公司）"
                loading={loading}
                optionFilterProp="label"
                options={talents.map((t) => ({
                  label: `${t.name}${t.current_title ? ` · ${t.current_title}` : ""}${t.current_company ? ` @ ${t.current_company}` : ""}`,
                  value: t.id,
                }))}
              />
            </Form.Item>
          )}

          <Form.Item name="job_id" label="应聘岗位" rules={[{ required: true, message: "请选择岗位" }]}>
            <Select
              showSearch
              placeholder="搜索并选择岗位"
              optionFilterProp="label"
              options={[
                ...openJobs.map((j) => ({
                  label: `${j.title}${j.department ? `（${j.department}）` : ""}`,
                  value: j.id,
                })),
                ...closedJobs.map((j) => ({
                  label: `${j.title}（已关闭）`,
                  value: j.id,
                })),
              ]}
            />
          </Form.Item>

          <Form.Item name="stage" label="初始阶段">
            <Select
              options={PIPELINE_STAGES.map((s) => ({ label: s.label, value: s.key }))}
            />
          </Form.Item>

          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={2} placeholder="如：内推候选人、期望薪资偏高…" />
          </Form.Item>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" htmlType="submit" loading={saving}>
              {batchIds ? `加入流程（${batchIds.length} 人）` : "加入流程"}
            </Button>
          </div>
        </Form>
      )}
    </Modal>
  );
}
