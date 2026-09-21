import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  Card, Button, Space, Tag, Input, Select, Checkbox, Popconfirm, message,
  Modal, Form, DatePicker, Segmented, Empty, Spin, Badge, Tooltip, Dropdown,
} from "antd";
import {
  PlusOutlined, ReloadOutlined, DeleteOutlined, EditOutlined, ClockCircleOutlined,
  CheckCircleOutlined, MoreOutlined, LinkOutlined, UserOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import type { MenuProps } from "antd";
import { api } from "../api";
import type { Task, User } from "../types";
import { PRIORITY_LABELS, PRIORITY_COLORS, TASK_SOURCE_LABELS } from "../types";
import { useSearchParams } from "react-router-dom";

export default function Tasks() {
  const [searchParams, setSearchParams] = useSearchParams();
  const talentFilter = searchParams.get("talent_id") || "";

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<"todo" | "done" | "all">("todo");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [summary, setSummary] = useState({ pending: 0, overdue: 0, today: 0 });
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [talents, setTalents] = useState<{ id: string; name: string }[]>([]);
  const [jobs, setJobs] = useState<{ id: string; title: string }[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const currentUser: User | null = (() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  })();
  const isAdmin = currentUser?.role === "admin";

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getTasks({
        scope: scope === "all" ? "all" : scope,
        priority: priorityFilter || undefined,
        owner_id: ownerFilter || undefined,
        talent_id: talentFilter || undefined,
      });
      setTasks(res.items);
      const s = await api.getTaskSummary();
      setSummary(s);
    } catch (err) {
      message.error((err as Error).message);
    }
    setLoading(false);
  }, [scope, priorityFilter, ownerFilter, talentFilter]);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  useEffect(() => {
    if (isAdmin) api.getUsers().then(setUsers).catch(() => {});
    api.getTalents({ page: 1, limit: 500 })
      .then((r) => setTalents(r.items.map((t) => ({ id: t.id, name: t.name }))))
      .catch(() => {});
    api.getJobOptions().then((r) => setJobs(r.map((j) => ({ id: j.id, title: j.title })))).catch(() => {});
  }, [isAdmin]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ priority: "normal", talent_id: talentFilter || undefined });
    setModalOpen(true);
  };

  const openEdit = (t: Task) => {
    setEditing(t);
    form.setFieldsValue({ ...t, due_date: t.due_date ? dayjs(t.due_date) : null });
    setModalOpen(true);
  };

  const handleSubmit = async (values: any) => {
    setSaving(true);
    try {
      const data = { ...values, due_date: values.due_date ? values.due_date.format("YYYY-MM-DD") : null };
      if (editing) {
        await api.updateTask(editing.id, data);
        message.success("待办已更新");
      } else {
        await api.createTask({ ...data, source: "manual" });
        message.success("待办已创建");
      }
      form.resetFields();
      setModalOpen(false);
      fetchTasks();
    } catch (err) {
      message.error((err as Error).message);
    }
    setSaving(false);
  };

  const toggleDone = async (t: Task) => {
    try {
      await api.updateTaskStatus(t.id, t.status === "done" ? "pending" : "done");
      fetchTasks();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleDelete = async (t: Task) => {
    try {
      await api.deleteTask(t.id);
      message.success("已删除");
      fetchTasks();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const moreMenu = (t: Task): MenuProps["items"] => [
    { key: "edit", label: "编辑待办", icon: <EditOutlined /> },
    {
      key: "cancel",
      label: t.status === "cancelled" ? "恢复为待办" : "标记为已取消",
      icon: <ClockCircleOutlined />,
    },
    { type: "divider" },
    { key: "delete", label: "删除", icon: <DeleteOutlined />, danger: true },
  ];

  const onMoreClick = async (t: Task, key: string) => {
    if (key === "edit") return openEdit(t);
    if (key === "delete") return handleDelete(t);
    if (key === "cancel") {
      try {
        await api.updateTaskStatus(t.id, t.status === "cancelled" ? "pending" : "cancelled");
        fetchTasks();
      } catch (err) {
        message.error((err as Error).message);
      }
    }
  };

  // 到期文案
  const dueText = (t: Task) => {
    if (!t.due_date) return "不限时";
    if (t.status !== "pending") return t.due_date;
    if (t.days_left === null) return t.due_date;
    if (t.days_left < 0) return `${t.due_date}（逾期 ${-t.days_left} 天）`;
    if (t.days_left === 0) return `${t.due_date}（今天）`;
    return `${t.due_date}（还剩 ${t.days_left} 天）`;
  };

  const dueColor = (t: Task) => {
    if (t.status !== "pending") return "#8c8c8c";
    if (t.overdue) return "#ff4d4f";
    if (t.due_today) return "#faad14";
    return "#8c8c8c";
  };

  return (
    <div>
      {/* 顶部统计 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <Space size="large" wrap>
          <span style={{ fontSize: 13, color: "#666" }}>
            待办 <b style={{ fontSize: 18, color: "#3b82f6" }}>{summary.pending}</b> 项
          </span>
          <span style={{ fontSize: 13, color: "#666" }}>
            逾期 <b style={{ fontSize: 18, color: "#ff4d4f" }}>{summary.overdue}</b> 项
          </span>
          <span style={{ fontSize: 13, color: "#666" }}>
            今日到期 <b style={{ fontSize: 18, color: "#faad14" }}>{summary.today}</b> 项
          </span>
        </Space>
        <Space>
          <Segmented
            value={scope}
            onChange={(v) => setScope(v as "todo" | "done" | "all")}
            options={[
              { label: "待办中", value: "todo" },
              { label: "已完成", value: "done" },
              { label: "全部", value: "all" },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={fetchTasks} loading={loading}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建待办</Button>
        </Space>
      </div>

      {/* 筛选 */}
      {(talentFilter || isAdmin) && (
        <Card style={{ marginBottom: 16 }} styles={{ body: { padding: 16 } }}>
          <Space wrap>
            {talentFilter && (
              <Tag
                closable
                color="blue"
                onClose={() => { searchParams.delete("talent_id"); setSearchParams(searchParams); }}
              >
                仅看该人才的待办
              </Tag>
            )}
            <span style={{ fontSize: 13, color: "#666" }}>优先级</span>
            <Select
              style={{ width: 120 }} allowClear placeholder="全部"
              value={priorityFilter || undefined} onChange={(v) => setPriorityFilter(v || "")}
              options={Object.entries(PRIORITY_LABELS).map(([k, v]) => ({ label: v, value: k }))}
            />
            {isAdmin && (
              <>
                <span style={{ fontSize: 13, color: "#666" }}>负责人</span>
                <Select
                  style={{ width: 140 }} allowClear placeholder="全部"
                  value={ownerFilter || undefined} onChange={(v) => setOwnerFilter(v || "")}
                  options={users.map((u) => ({ label: u.name, value: u.id }))}
                />
              </>
            )}
          </Space>
        </Card>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: "4rem" }}><Spin size="large" /></div>
      ) : tasks.length === 0 ? (
        <Card>
          <Empty
            description={
              scope === "todo"
                ? "没有待处理的跟进事项，可以歇一歇"
                : "没有符合条件的待办"
            }
          />
        </Card>
      ) : (
        <div>
          {tasks.map((t) => (
            <div
              key={t.id}
              className={`task-item${t.overdue ? " is-overdue" : ""}${t.due_today ? " is-today" : ""}${t.status === "done" ? " is-done" : ""}`}
            >
              <Checkbox
                checked={t.status === "done"}
                onChange={() => toggleDone(t)}
                style={{ marginTop: 3 }}
              />
              <div className="task-main">
                <div className="task-title">{t.title}</div>
                <div className="task-meta">
                  <span style={{ color: dueColor(t), fontWeight: t.overdue || t.due_today ? 600 : 400 }}>
                    <ClockCircleOutlined /> {dueText(t)}
                  </span>
                  <Tag color={PRIORITY_COLORS[t.priority] || "default"} style={{ marginInlineEnd: 0 }}>
                    {PRIORITY_LABELS[t.priority] || t.priority}
                  </Tag>
                  {t.talent_id && (
                    <Link to={`/talents/${t.talent_id}`} style={{ color: "#3b82f6" }}>
                      <UserOutlined /> {t.talent_name || "关联人才"}
                    </Link>
                  )}
                  {t.job_title && (
                    <span><LinkOutlined /> {t.job_title}</span>
                  )}
                  {t.status === "cancelled" && <Tag style={{ marginInlineEnd: 0 }}>已取消</Tag>}
                  {t.status === "done" && <Tag color="green" style={{ marginInlineEnd: 0 }}>已完成</Tag>}
                  <span style={{ color: "#c2c6cc" }}>
                    {TASK_SOURCE_LABELS[t.source] || t.source}
                    {isAdmin && t.owner_name ? ` · ${t.owner_name}` : ""}
                  </span>
                </div>
                {t.content && <div className="task-content">{t.content}</div>}
              </div>
              <div className="task-actions">
                {t.status !== "done" && (
                  <Tooltip title="标记完成">
                    <Button type="text" size="small" icon={<CheckCircleOutlined />} onClick={() => toggleDone(t)} />
                  </Tooltip>
                )}
                <Dropdown
                  menu={{ items: moreMenu(t), onClick: ({ key }) => onMoreClick(t, key) }}
                  trigger={["click"]}
                >
                  <Button type="text" size="small" icon={<MoreOutlined />} />
                </Dropdown>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 新建 / 编辑待办 */}
      <Modal
        title={editing ? "编辑待办" : "新建待办"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        footer={null}
        width={560}
        destroyOnClose
      >
        <Form form={form} layout="vertical" onFinish={handleSubmit}>
          <Form.Item name="title" label="待办事项" rules={[{ required: true, message: "请输入待办内容" }]}>
            <Input placeholder="如：跟进张三维的面试时间确认" />
          </Form.Item>

          <Form.Item name="due_date" label="到期日" style={{ display: "inline-block", width: "calc(50% - 8px)", marginRight: 16 }}>
            <DatePicker style={{ width: "100%" }} placeholder="不限时可不填" />
          </Form.Item>
          <Form.Item name="priority" label="优先级" style={{ display: "inline-block", width: "calc(50% - 8px)" }}>
            <Select options={Object.entries(PRIORITY_LABELS).map(([k, v]) => ({ label: v, value: k }))} />
          </Form.Item>

          <Form.Item name="talent_id" label="关联人才" style={{ display: "inline-block", width: "calc(50% - 8px)", marginRight: 16 }}>
            <Select
              showSearch allowClear placeholder="可选"
              optionFilterProp="label"
              options={talents.map((t) => ({ label: t.name, value: t.id }))}
            />
          </Form.Item>
          <Form.Item name="job_id" label="关联岗位" style={{ display: "inline-block", width: "calc(50% - 8px)" }}>
            <Select
              showSearch allowClear placeholder="可选"
              optionFilterProp="label"
              options={jobs.map((j) => ({ label: j.title, value: j.id }))}
            />
          </Form.Item>

          <Form.Item name="content" label="备注">
            <Input.TextArea rows={3} placeholder="补充说明…" />
          </Form.Item>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="ant-btn ant-btn-default" onClick={() => setModalOpen(false)}>取消</button>
            <button type="submit" className="ant-btn ant-btn-primary" disabled={saving}>
              {saving ? "保存中…" : editing ? "保存修改" : "创建待办"}
            </button>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
