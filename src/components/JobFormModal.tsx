import { useState, useEffect } from "react";
import {
  Modal, Form, Input, InputNumber, Select, DatePicker, message, Alert, Button, Divider,
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
      <Form form={form} layout="horizontal" className="form-horizontal" labelCol={{ flex: "88px" }} onFinish={handleSubmit}>
        {/* 两列网格（全站统一）：外层 .form-grid 固定两列均分，
           每个字段占一个单元格，label 定宽 88px，控件撑满剩余宽度，
           所以无论 Input / Select / DatePicker / InputNumber，右侧边界都对齐、宽度完全一致。 */}
        <div className="form-grid">
          <Form.Item
            name="title" label="岗位名称" rules={[{ required: true, message: "请输入岗位名称" }]}
          >
            <Input placeholder="如 高级前端工程师" />
          </Form.Item>
          <Form.Item name="department" label="用人部门">
            <Select
              showSearch allowClear placeholder="请选择或输入部门"
              mode="tags" maxCount={1}
              options={departments.map((d) => ({ label: d, value: d }))}
              onChange={(v: string[]) => form.setFieldValue("department", v?.[v.length - 1] || undefined)}
              value={undefined}
            />
          </Form.Item>

          <Form.Item name="city" label="工作城市">
            <Input placeholder="如 深圳" />
          </Form.Item>
          <Form.Item name="job_type" label="用工类型">
            <Select options={Object.entries(JOB_TYPE_LABELS).map(([k, v]) => ({ label: v, value: k }))} />
          </Form.Item>

          <Form.Item name="headcount" label="招聘人数">
            <InputNumber style={{ width: "100%" }} min={1} max={999} />
          </Form.Item>
          <Form.Item name="opened_at" label="开放日期">
            <DatePicker style={{ width: "100%" }} placeholder="请选择日期" />
          </Form.Item>

          <Form.Item name="priority" label="紧急度">
            <Select options={Object.entries(PRIORITY_LABELS).map(([k, v]) => ({ label: v, value: k }))} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select options={[
              { label: "在招", value: "open" },
              { label: "暂停", value: "paused" },
              { label: "已关闭", value: "closed" },
            ]} />
          </Form.Item>

          <Form.Item name="salary_range" label="薪资范围">
            <Input placeholder="如 25-40K·14薪" />
          </Form.Item>
          <Form.Item name="education" label="学历要求">
            <Select allowClear placeholder="不限" options={EDUCATION_OPTIONS.map((e) => ({ label: e, value: e }))} />
          </Form.Item>

          <Form.Item name="experience" label="经验要求">
            <Input placeholder="如 3-5年" />
          </Form.Item>
          {/* 占位：字段数为奇数，补一格让最后一行的左列不被拉伸 */}
          <span className="form-row-filler" />
        </div>

        <Divider orientation="left" orientationMargin={0} style={{ fontSize: 13, color: "#8c8c8c", margin: "4px 0 16px" }}>
          岗位说明
        </Divider>

        <Form.Item name="description" label="岗位职责" labelCol={{ flex: "88px" }}>
          <Input.TextArea rows={3} placeholder="一行一条，或用编号书写…" />
        </Form.Item>

        <Form.Item name="requirements" label="任职要求" labelCol={{ flex: "88px" }}>
          <Input.TextArea rows={3} placeholder="一行一条…" />
        </Form.Item>

        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="关闭岗位时系统会自动记录关闭日期；重新开放会自动清空。"
        />

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" htmlType="submit" loading={saving}>
            {isEdit ? "保存修改" : "创建岗位"}
          </Button>
        </div>
      </Form>
    </Modal>
  );
}
