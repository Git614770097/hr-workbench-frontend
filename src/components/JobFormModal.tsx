import { useState, useEffect } from "react";
import {
  Modal, Form, Input, InputNumber, Select, DatePicker, message, Alert,
} from "antd";
import dayjs from "dayjs";
import { api } from "../api";
import type { Job } from "../types";
import { EDUCATION_OPTIONS, JOB_TYPE_LABELS, PRIORITY_LABELS } from "../types";

interface Props {
  open: boolean;
  jobId?: string | null;
  onClose: () => void;
  onSuccess: () => void;
}

export default function JobFormModal({ open, jobId, onClose, onSuccess }: Props) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [departments, setDepartments] = useState<string[]>([]);
  const isEdit = !!jobId;

  useEffect(() => {
    if (!open) return;
    api.getDepartments().then(setDepartments).catch(() => {});
    if (isEdit && jobId) {
      api.getJob(jobId)
        .then((j) => {
          form.setFieldsValue({
            ...j,
            opened_at: j.opened_at ? dayjs(j.opened_at) : null,
            closed_at: j.closed_at ? dayjs(j.closed_at) : null,
          });
        })
        .catch((err) => message.error((err as Error).message));
    } else {
      form.resetFields();
      form.setFieldsValue({ job_type: "fulltime", status: "open", priority: "normal", headcount: 1 });
    }
  }, [open, jobId]);

  const handleSubmit = async (values: any) => {
    setSaving(true);
    try {
      const data: Partial<Job> = {
        ...values,
        opened_at: values.opened_at ? values.opened_at.format("YYYY-MM-DD") : null,
        closed_at: values.closed_at ? values.closed_at.format("YYYY-MM-DD") : null,
      };
      if (isEdit && jobId) {
        await api.updateJob(jobId, data);
        message.success("岗位已更新");
      } else {
        await api.createJob(data);
        message.success("岗位已创建");
      }
      form.resetFields();
      onSuccess();
      onClose();
    } catch (err) {
      message.error((err as Error).message);
    }
    setSaving(false);
  };

  return (
    <Modal
      title={isEdit ? "编辑岗位" : "新增岗位"}
      open={open}
      onCancel={onClose}
      width={720}
      footer={null}
      destroyOnClose
    >
      <Form form={form} layout="vertical" onFinish={handleSubmit}>
        <Form.Item
          name="title" label="岗位名称" rules={[{ required: true, message: "请输入岗位名称" }]}
          style={{ display: "inline-block", width: "calc(50% - 8px)", marginRight: 16 }}
        >
          <Input placeholder="如 高级前端工程师" />
        </Form.Item>
        <Form.Item name="department" label="用人部门" style={{ display: "inline-block", width: "calc(50% - 8px)" }}>
          <Select
            showSearch allowClear placeholder="请选择或输入部门"
            mode="tags" maxCount={1}
            options={departments.map((d) => ({ label: d, value: d }))}
            onChange={(v: string[]) => form.setFieldValue("department", v?.[v.length - 1] || undefined)}
            value={undefined}
          />
        </Form.Item>

        <Form.Item name="city" label="工作城市" style={{ display: "inline-block", width: "calc(33% - 11px)", marginRight: 16 }}>
          <Input placeholder="如 深圳" />
        </Form.Item>
        <Form.Item name="job_type" label="用工类型" style={{ display: "inline-block", width: "calc(33% - 11px)", marginRight: 16 }}>
          <Select options={Object.entries(JOB_TYPE_LABELS).map(([k, v]) => ({ label: v, value: k }))} />
        </Form.Item>
        <Form.Item name="headcount" label="招聘人数（HC）" style={{ display: "inline-block", width: "calc(33% - 11px)" }}>
          <InputNumber style={{ width: "100%" }} min={1} max={999} />
        </Form.Item>

        <Form.Item name="priority" label="紧急度" style={{ display: "inline-block", width: "calc(33% - 11px)", marginRight: 16 }}>
          <Select options={Object.entries(PRIORITY_LABELS).map(([k, v]) => ({ label: v, value: k }))} />
        </Form.Item>
        <Form.Item name="status" label="状态" style={{ display: "inline-block", width: "calc(33% - 11px)", marginRight: 16 }}>
          <Select options={[
            { label: "在招", value: "open" },
            { label: "暂停", value: "paused" },
            { label: "已关闭", value: "closed" },
          ]} />
        </Form.Item>
        <Form.Item name="opened_at" label="开放日期" style={{ display: "inline-block", width: "calc(33% - 11px)" }}>
          <DatePicker style={{ width: "100%" }} placeholder="请选择" />
        </Form.Item>

        <Form.Item name="salary_range" label="薪资范围" style={{ display: "inline-block", width: "calc(50% - 8px)", marginRight: 16 }}>
          <Input placeholder="如 25-40K·14薪" />
        </Form.Item>
        <Form.Item name="education" label="学历要求" style={{ display: "inline-block", width: "calc(50% - 8px)" }}>
          <Select allowClear placeholder="不限" options={EDUCATION_OPTIONS.map((e) => ({ label: e, value: e }))} />
        </Form.Item>

        <Form.Item name="experience" label="经验要求">
          <Input placeholder="如 3-5年" />
        </Form.Item>

        <Form.Item name="description" label="岗位职责">
          <Input.TextArea rows={4} placeholder="一行一条，或用编号书写…" />
        </Form.Item>

        <Form.Item name="requirements" label="任职要求">
          <Input.TextArea rows={4} placeholder="一行一条…" />
        </Form.Item>

        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="关闭岗位时系统会自动记录关闭日期；重新开放会自动清空。"
        />

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="ant-btn ant-btn-default" onClick={onClose}>取消</button>
          <button type="submit" className="ant-btn ant-btn-primary" disabled={saving}>
            {saving ? "保存中…" : isEdit ? "保存修改" : "创建岗位"}
          </button>
        </div>
      </Form>
    </Modal>
  );
}
