import { useState, useEffect, useCallback } from "react";
import {
  Table, Button, Space, Tag, Modal, Form, Input, InputNumber, message,
  Popconfirm, Empty, Typography, Select, DatePicker, Alert,
} from "antd";
import { PlusOutlined, ReloadOutlined, CheckOutlined, CloseOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api";
import type { Requisition } from "../types";
import { REQUISITION_STATUS_LABELS, JOB_TYPE_LABELS } from "../types";

/** 招聘需求：用人部门提需求 → 审批 → 一键转正式岗位（并入岗位管理页） */
export default function RequisitionPanel({ isAdmin }: { isAdmin: boolean }) {
  const [items, setItems] = useState<Requisition[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<Requisition | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getRequisitions();
      setItems(r.items);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await api.createRequisition({
        ...v,
        expect_date: v.expect_date ? dayjs(v.expect_date).format("YYYY-MM-DD") : null,
      });
      message.success("招聘需求已提交，等待 HR 审批");
      setOpen(false);
      form.resetFields();
      load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleApprove = async (row: Requisition) => {
    try {
      await api.approveRequisition(row.id);
      message.success("已通过，并自动生成正式岗位");
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const handleReject = async () => {
    if (!rejectTarget) return;
    try {
      await api.rejectRequisition(rejectTarget.id, rejectReason);
      message.success("已驳回");
      setRejectTarget(null);
      setRejectReason("");
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const statusColor = (s: string) =>
    s === "approved" ? "green" : s === "rejected" ? "red" : s === "closed" ? "default" : "gold";

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="用人部门在这里提交招聘需求，HR 审批通过后会自动生成正式岗位并进入「在招」状态。"
      />
      <div className="toolbar">
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setOpen(true); }}>
            提交招聘需求
          </Button>
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
      </div>

      <Table<Requisition>
        className="profiles-table"
        rowKey="id"
        dataSource={items}
        loading={loading}
        size="middle"
        scroll={{ x: 1000 }}
        locale={{ emptyText: <Empty description="还没有招聘需求" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        columns={[
          { title: "需求部门", dataIndex: "department", key: "department", width: 110 },
          { title: "岗位名称", dataIndex: "title", key: "title", width: 150 },
          { title: "HC", dataIndex: "headcount", key: "headcount", width: 60, align: "center" },
          {
            title: "类型",
            key: "job_type",
            width: 90,
            render: (_: unknown, r: Requisition) => JOB_TYPE_LABELS[r.job_type] || r.job_type,
          },
          { title: "城市", dataIndex: "city", key: "city", width: 90, render: (v: string | null) => v || "—" },
          {
            title: "期望到岗",
            dataIndex: "expect_date",
            key: "expect_date",
            width: 100,
            render: (v: string | null) => v || "—",
          },
          {
            title: "状态",
            dataIndex: "status",
            key: "status",
            width: 100,
            render: (v: string) => <Tag color={statusColor(v)}>{REQUISITION_STATUS_LABELS[v] || v}</Tag>,
          },
          {
            title: "操作",
            key: "act",
            width: 150,
            align: "center",
            render: (_: unknown, r: Requisition) =>
              r.status === "pending" && isAdmin ? (
                <Space size={12}>
                  <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={() => handleApprove(r)}>
                    通过
                  </Button>
                  <Button type="link" size="small" danger style={{ paddingInline: 0 }}
                    onClick={() => { setRejectTarget(r); setRejectReason(""); }}>
                    驳回
                  </Button>
                </Space>
              ) : r.status === "approved" ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>已生成岗位</Typography.Text>
              ) : r.status === "rejected" ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.reject_reason || "已驳回"}</Typography.Text>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>—</Typography.Text>
              ),
          },
        ]}
      />

      <Modal title="提交招聘需求" open={open} onCancel={() => setOpen(false)} onOk={handleSave}
        confirmLoading={saving} okText="提交" cancelText="取消" destroyOnClose width={560}>
        <Form form={form} layout="horizontal" className="form-horizontal" labelCol={{ flex: "88px" }}
          initialValues={{ headcount: 1, job_type: "fulltime" }}>
          <Form.Item name="department" label="需求部门" rules={[{ required: true, message: "请填写需求部门" }]}>
            <Input placeholder="如：产品部 / 销售一部" />
          </Form.Item>
          <Form.Item name="title" label="岗位名称" rules={[{ required: true, message: "请填写岗位名称" }]}>
            <Input placeholder="如：前端开发工程师" />
          </Form.Item>
          <Form.Item name="headcount" label="需求人数" rules={[{ required: true }]}>
            <InputNumber min={1} max={999} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="job_type" label="用工类型">
            <Select options={Object.entries(JOB_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
          </Form.Item>
          <Form.Item name="city" label="工作城市">
            <Input placeholder="如：上海" />
          </Form.Item>
          <Form.Item name="salary_range" label="薪资范围">
            <Input placeholder="如：15-25K" />
          </Form.Item>
          <Form.Item name="expect_date" label="期望到岗">
            <DatePicker style={{ width: "100%" }} placeholder="选择期望到岗日期" />
          </Form.Item>
          <Form.Item name="reason" label="需求原因">
            <Input.TextArea rows={3} placeholder="说明业务背景与需求缘由" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="驳回招聘需求" open={!!rejectTarget} onCancel={() => setRejectTarget(null)} onOk={handleReject}
        okText="确认驳回" cancelText="取消" destroyOnClose>
        <Input.TextArea rows={3} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
          placeholder="驳回原因（会显示给需求提出人）" />
      </Modal>
    </div>
  );
}
