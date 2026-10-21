import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Table, Button, Space, Tag, Modal, Form, Input, InputNumber, message,
  Empty, Typography, Select, DatePicker, Alert, Tabs, Popconfirm, Row, Col,
} from "antd";
import { PlusOutlined, ReloadOutlined, EditOutlined, RollbackOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import dayjs from "dayjs";
import { api } from "../api";
import { useDict } from "../dict";
import type { Requisition } from "../types";
import {
  REQUISITION_STATUS_LABELS, JOB_TYPE_LABELS, EDUCATION_OPTIONS,
  PRIORITY_LABELS, PRIORITY_COLORS,
} from "../types";

type StatusKey = "" | "pending" | "approved" | "closed";

const STATUS_TABS: { key: StatusKey; label: string }[] = [
  { key: "", label: "全部" },
  { key: "pending", label: "待处理" },
  { key: "approved", label: "已转岗" },
  { key: "closed", label: "已作废" },
];

/** 招聘需求：用人部门提需求 → 一键转正式岗位（并入岗位管理页），无审批环节 */
export default function RequisitionPanel({
  isAdmin,
  submitOpen,
  onSubmitOpenChange,
  hideSubmitButton,
}: {
  isAdmin: boolean;
  /** 父级受控打开「提交需求」弹窗：把提交入口并入列表卡 toolbar 时用；不传则组件自管 */
  submitOpen?: boolean;
  onSubmitOpenChange?: (open: boolean) => void;
  /** 提交入口已由父级 toolbar 提供时，隐藏组件内部的触发按钮 */
  hideSubmitButton?: boolean;
}) {
  const { cities } = useDict();
  const [items, setItems] = useState<Requisition[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusKey>("");
  const [innerOpen, setInnerOpen] = useState(false);
  const open = submitOpen ?? innerOpen;
  const setOpen = (v: boolean) => {
    setInnerOpen(v);
    onSubmitOpenChange?.(v);
  };
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  // 编辑模式：editingId 非空表示正在编辑某条需求
  const [editingId, setEditingId] = useState<string | null>(null);
  // 当前用户 id：用于判断能否编辑/撤回（仅本人或管理员）
  const currentUserId: string | null = (() => {
    try {
      return JSON.parse(localStorage.getItem("user") || "null")?.id ?? null;
    } catch {
      return null;
    }
  })();

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

  // 按状态筛选（前端过滤，避免频繁请求；数据量不大）
  const filtered = useMemo(
    () => (statusFilter ? items.filter((i) => i.status === statusFilter) : items),
    [items, statusFilter]
  );

  // 各状态数量（用于 Tab 徽标）
  const counts = useMemo(() => {
    const c: Record<string, number> = { "": items.length };
    for (const i of items) c[i.status] = (c[i.status] || 0) + 1;
    return c;
  }, [items]);

  const today = dayjs().format("YYYY-MM-DD");

  const openCreate = () => {
    setEditingId(null);
    form.resetFields();
    setOpen(true);
  };

  const openEdit = (row: Requisition) => {
    setEditingId(row.id);
    form.setFieldsValue({
      department: row.department,
      title: row.title,
      headcount: row.headcount,
      job_type: row.job_type,
      city: row.city,
      salary_range: row.salary_range,
      education: row.education,
      experience: row.experience,
      priority: row.priority,
      expect_date: row.expect_date ? dayjs(row.expect_date) : null,
      reason: row.reason,
    });
    setOpen(true);
  };

  const handleSave = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const payload = {
        ...v,
        expect_date: v.expect_date ? dayjs(v.expect_date).format("YYYY-MM-DD") : null,
      };
      if (editingId) {
        await api.updateRequisition(editingId, payload);
        message.success("需求已更新");
      } else {
        await api.createRequisition(payload);
        message.success("招聘需求已提交，可随时转为正式岗位");
      }
      setOpen(false);
      form.resetFields();
      setEditingId(null);
      load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleConvert = async (row: Requisition) => {
    try {
      const r = await api.convertRequisition(row.id);
      message.success(`已转为正式岗位${r.job_id ? "" : ""}`);
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const handleWithdraw = async (row: Requisition) => {
    try {
      await api.withdrawRequisition(row.id);
      message.success("已撤回");
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const statusColor = (s: string) =>
    s === "approved" ? "green" : s === "rejected" ? "red" : s === "closed" ? "default" : "gold";

  // 期望到岗已过期且仍未处理 → 标红
  const isOverdue = (row: Requisition) =>
    row.status === "pending" && !!row.expect_date && row.expect_date < today;

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="用人部门在这里提交招聘需求，随时可以一键转为正式岗位并进入「在招」状态。"
      />
      <div className="toolbar">
        <Space>
          {!hideSubmitButton && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              提交招聘需求
            </Button>
          )}
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
      </div>

      <Tabs
        activeKey={statusFilter}
        onChange={(k) => setStatusFilter(k as StatusKey)}
        items={STATUS_TABS.map((t) => ({
          key: t.key,
          label: `${t.label}${counts[t.key] ? ` (${counts[t.key]})` : ""}`,
        }))}
        style={{ marginBottom: 8 }}
      />

      <Table<Requisition>
        className="profiles-table"
        rowKey="id"
        dataSource={filtered}
        loading={loading}
        size="middle"
        scroll={{ x: 1100 }}
        locale={{ emptyText: <Empty description="还没有招聘需求" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        columns={[
          { title: "需求部门", dataIndex: "department", key: "department", width: 110 },
          { title: "岗位名称", dataIndex: "title", key: "title", width: 150 },
          { title: "HC", dataIndex: "headcount", key: "headcount", width: 60, align: "center" },
          {
            title: "优先级",
            dataIndex: "priority",
            key: "priority",
            width: 70,
            align: "center",
            render: (v: string) => (
              <Tag color={PRIORITY_COLORS[v] || "default"}>{PRIORITY_LABELS[v] || v}</Tag>
            ),
          },
          {
            title: "类型",
            key: "job_type",
            width: 90,
            render: (_: unknown, r: Requisition) => JOB_TYPE_LABELS[r.job_type] || r.job_type,
          },
          { title: "城市", dataIndex: "city", key: "city", width: 80, render: (v: string | null) => v || "-" },
          {
            title: "期望到岗",
            dataIndex: "expect_date",
            key: "expect_date",
            width: 110,
            render: (v: string | null, r: Requisition) =>
              v ? (
                <span style={{ color: isOverdue(r) ? "#dc2626" : undefined, fontWeight: isOverdue(r) ? 600 : 400 }}>
                  {v}{isOverdue(r) && " 已逾期"}
                </span>
              ) : "-",
          },
          {
            title: "状态",
            dataIndex: "status",
            key: "status",
            width: 90,
            render: (v: string) => <Tag color={statusColor(v)}>{REQUISITION_STATUS_LABELS[v] || v}</Tag>,
          },
          {
            title: "操作",
            key: "act",
            width: 200,
            align: "center",
            render: (_: unknown, r: Requisition) => {
              if (r.status === "pending") {
                const canManage = isAdmin || r.owner_id === currentUserId;
                return (
                  <Space size={8}>
                    <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={() => handleConvert(r)}>
                      转为岗位
                    </Button>
                    {canManage && (
                      <>
                        <Button type="link" size="small" icon={<EditOutlined />} style={{ paddingInline: 0 }}
                          onClick={() => openEdit(r)}>
                          编辑
                        </Button>
                        <Popconfirm title="确认撤回该需求？" onConfirm={() => handleWithdraw(r)} okText="撤回" cancelText="取消">
                          <Button type="link" size="small" icon={<RollbackOutlined />} style={{ paddingInline: 0 }}>
                            撤回
                          </Button>
                        </Popconfirm>
                      </>
                    )}
                  </Space>
                );
              }
              if (r.status === "approved") {
                return (
                  <Link to={`/jobs${r.job_id ? `?focus=${r.job_id}` : ""}`} className="ant-btn-link" style={{ fontSize: 12 }}>
                    查看岗位 →
                  </Link>
                );
              }
              if (r.status === "rejected") {
                return (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {r.reject_reason || "已驳回"}
                  </Typography.Text>
                );
              }
              return <Typography.Text type="secondary" style={{ fontSize: 12 }}>-</Typography.Text>;
            },
          },
        ]}
      />

      <Modal
        title={editingId ? "编辑招聘需求" : "提交招聘需求"}
        open={open}
        onCancel={() => { setOpen(false); setEditingId(null); form.resetFields(); }}
        onOk={handleSave}
        confirmLoading={saving}
        okText={editingId ? "保存" : "提交"}
        cancelText="取消"
        destroyOnClose
        width={680}
      >
        {/* 两列布局：短字段并排，需求原因独占一行 */}
        <Form form={form} layout="horizontal" className="form-horizontal" labelCol={{ flex: "80px" }}
          initialValues={{ headcount: 1, job_type: "fulltime", priority: "normal" }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="department" label="需求部门" rules={[{ required: true, message: "请填写需求部门" }]}>
                <Input placeholder="如：产品部" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="title" label="岗位名称" rules={[{ required: true, message: "请填写岗位名称" }]}>
                <Input placeholder="如：前端开发工程师" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="headcount" label="需求人数" rules={[{ required: true }]}>
                <InputNumber min={1} max={999} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="priority" label="优先级">
                <Select options={Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value, label }))} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="job_type" label="用工类型">
                <Select options={Object.entries(JOB_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="city" label="工作城市">
                <Select
                  allowClear
                  showSearch
                  placeholder="选择城市"
                  optionFilterProp="label"
                  options={cities.map((c) => ({ value: c, label: c }))}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="education" label="学历要求">
                <Select
                  allowClear
                  placeholder="最低学历要求"
                  options={EDUCATION_OPTIONS.map((e) => ({ value: e, label: e }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="experience" label="经验要求">
                <Input placeholder="如：3-5 年" />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="salary_range" label="薪资范围">
                <Input placeholder="如：15-25K" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="expect_date" label="期望到岗">
                <DatePicker style={{ width: "100%" }} placeholder="选择期望到岗日期" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="reason" label="需求原因">
            <Input.TextArea rows={3} placeholder="说明业务背景与需求缘由" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
