import { useState, useEffect } from "react";
import {
  Card, Table, Button, Space, Tag, Popconfirm, message, Modal, Form, Input, Tooltip, Select, Alert, Badge,
} from "antd";
import {
  PlusOutlined, KeyOutlined, UserAddOutlined, CheckOutlined, StopOutlined,
  ClockCircleOutlined, LockOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import { ROLE_LABELS } from "../types";
import type { Role, UserRow } from "../types";

/** 账号状态展示元数据：审批通过的用户不展示状态列内容，保持表格干净 */
function statusTag(status: string | null) {
  if (!status || status === "active") return null;
  if (status === "pending") {
    return <Tag icon={<ClockCircleOutlined />} color="warning">待审批</Tag>;
  }
  if (status === "rejected") {
    return <Tag color="default">已拒绝</Tag>;
  }
  return <Tag color="error">已停用</Tag>;
}

export default function Users() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [pending, setPending] = useState<UserRow[]>([]);
  const [resets, setResets] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showReset, setShowReset] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<UserRow | null>(null);
  const [approving, setApproving] = useState<UserRow | null>(null);
  const [resolving, setResolving] = useState<UserRow | null>(null);
  const [createForm] = Form.useForm();
  const [resetForm] = Form.useForm();
  const [assignForm] = Form.useForm();
  const [approveForm] = Form.useForm();
  const [resolveForm] = Form.useForm();

  const fetchUsers = async () => {
    try {
      const [all, waiting, reqs] = await Promise.all([
        api.getUsers(),
        api.getUsers("pending"),
        api.getResetRequests(),
      ]);
      setUsers(all);
      setPending(waiting);
      setResets(reqs);
    } catch (err) {
      message.error((err as Error).message);
    }
    setLoading(false);
  };

  const fetchRoles = async () => {
    try {
      setRoles(await api.getRoles());
    } catch {
      // 角色加载失败不阻塞用户列表
    }
  };

  useEffect(() => { fetchUsers(); fetchRoles(); }, []);

  const handleCreate = async (values: { phone: string; name: string; password: string; role_id?: string | null }) => {
    try {
      await api.createUser(values);
      createForm.resetFields();
      setShowCreate(false);
      message.success("用户已创建");
      fetchUsers();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  /** 审批通过：把 pending 改成 active，并同时挂上角色 */
  const handleApprove = async (values: { role_id?: string | null }) => {
    if (!approving) return;
    try {
      await api.approveUser(approving.id, values.role_id ?? null);
      approveForm.resetFields();
      setApproving(null);
      message.success(`已通过「${approving.name}」的注册申请`);
      fetchUsers();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleReject = async (record: UserRow) => {
    try {
      await api.rejectUser(record.id);
      message.success(`已拒绝「${record.name}」的注册申请`);
      fetchUsers();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  /** 处理忘记密码申请：设置新密码并清除申请 */
  const handleResolveReset = async (values: { password: string }) => {
    if (!resolving) return;
    try {
      await api.resolveReset(resolving.id, "reset", values.password);
      message.success(`已为「${resolving.name}」设置新密码，请线下告知本人`);
      resolveForm.resetFields();
      setResolving(null);
      fetchUsers();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  /** 忽略重置申请（核对后确认无需改密码，或判定为误操作） */
  const handleDismissReset = async (record: UserRow) => {
    try {
      await api.resolveReset(record.id, "dismiss");
      message.success(`已忽略「${record.name}」的重置申请`);
      fetchUsers();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleAssignRole = async (values: { role_id?: string | null }) => {
    if (!assigning) return;
    try {
      await api.updateUserRole(assigning.id, values.role_id ?? null);
      assignForm.resetFields();
      setAssigning(null);
      message.success("角色已更新");
      fetchUsers();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleReset = async (values: { password: string }) => {
    if (!showReset) return;
    try {
      await api.resetUserPassword(showReset, values.password);
      resetForm.resetFields();
      setShowReset(null);
      message.success("密码已重置");
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    try {
      await api.deleteUser(id);
      message.success(`已删除「${name}」`);
      fetchUsers();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  /** 待审批区块的行内操作：通过 / 拒绝 */
  const pendingActions = (record: UserRow) => (
    <Space size={4}>
      <Button
        type="primary"
        size="small"
        icon={<CheckOutlined />}
        onClick={() => { setApproving(record); approveForm.resetFields(); }}
      >
        通过
      </Button>
      <Popconfirm
        title={`确认拒绝「${record.name}」的注册申请？`}
        description="拒绝后该手机号仍可被管理员手动创建为账号。"
        onConfirm={() => handleReject(record)}
      >
        <Button size="small" danger icon={<StopOutlined />}>拒绝</Button>
      </Popconfirm>
    </Space>
  );

  const pendingColumns = [
    {
      title: "姓名",
      dataIndex: "name",
      key: "name",
      render: (text: string) => <strong>{text}</strong>,
    },
    { title: "手机号", dataIndex: "phone", key: "phone", width: 140 },
    {
      title: "申请时间",
      dataIndex: "created_at",
      key: "created_at",
      width: 180,
      render: (v: string) => v ? new Date(v).toLocaleString("zh-CN") : "—",
    },
    {
      title: "操作",
      key: "action",
      width: 170,
      render: (_: unknown, record: UserRow) => pendingActions(record),
    },
  ];

  /** 待处理重置申请的行内操作：设置新密码 / 忽略 */
  const resetActions = (record: UserRow) => (
    <Space size={4}>
      <Button
        type="primary"
        size="small"
        icon={<KeyOutlined />}
        onClick={() => { setResolving(record); resolveForm.resetFields(); }}
      >
        设置新密码
      </Button>
      <Popconfirm
        title={`忽略「${record.name}」的重置申请？`}
        description="忽略后该申请从列表移除，账号密码保持不变。"
        onConfirm={() => handleDismissReset(record)}
      >
        <Button size="small" icon={<StopOutlined />}>忽略</Button>
      </Popconfirm>
    </Space>
  );

  const resetColumns = [
    {
      title: "姓名",
      dataIndex: "name",
      key: "name",
      render: (text: string) => <strong>{text}</strong>,
    },
    { title: "手机号", dataIndex: "phone", key: "phone", width: 140 },
    {
      title: "申请时间",
      dataIndex: "reset_requested_at",
      key: "reset_requested_at",
      width: 180,
      render: (v: string) => v ? new Date(v.replace(" ", "T") + "Z").toLocaleString("zh-CN") : "—",
    },
    {
      title: "操作",
      key: "action",
      width: 190,
      render: (_: unknown, record: UserRow) => resetActions(record),
    },
  ];

  const columns = [
    {
      title: "姓名",
      dataIndex: "name",
      key: "name",
      render: (text: string, record: UserRow) => (
        <Space size={6}>
          <strong>{text}</strong>
          {statusTag(record.status)}
          {record.must_change_password ? (
            <Tooltip title="由管理员设置了临时密码，该用户登录后会收到修改提醒">
              <Tag icon={<LockOutlined />} color="orange">需改密码</Tag>
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: "手机号",
      dataIndex: "phone",
      key: "phone",
      width: 140,
    },
    {
      title: "角色",
      dataIndex: "role",
      key: "role",
      width: 180,
      render: (role: string, record: UserRow) => (
        <Tag color={role === "admin" ? "gold" : record.role_id ? "blue" : "default"}>
          {role === "admin" ? ROLE_LABELS.admin : (record.role_name || "未分配角色")}
        </Tag>
      ),
    },
    {
      title: "创建时间",
      dataIndex: "created_at",
      key: "created_at",
      width: 180,
      render: (v: string) => v ? new Date(v).toLocaleString("zh-CN") : "—",
    },
    {
      title: "操作",
      key: "action",
      width: 200,
      render: (_: unknown, record: UserRow) => (
        <Space>
          <Button type="link" size="small" onClick={() => { setShowReset(record.id); resetForm.resetFields(); }}>重置密码</Button>
          {record.role !== "admin" && (
            <>
              <Button type="link" size="small" onClick={() => { setAssigning(record); assignForm.setFieldsValue({ role_id: record.role_id }); }}>分配角色</Button>
              <Popconfirm title="确认删除？该用户的所有数据将被清除。" onConfirm={() => handleDelete(record.id, record.name)}>
                <Button type="link" size="small" danger>删除</Button>
              </Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => { setShowCreate(true); createForm.resetFields(); }}>
          添加用户
        </Button>
      </div>

      {pending.length > 0 && (
        <Card
          style={{ marginBottom: 16 }}
          title={
            <Space>
              <UserAddOutlined style={{ color: "#f59e0b" }} />
              <span>待审批注册申请</span>
              <Badge count={pending.length} style={{ backgroundColor: "#f59e0b" }} />
            </Space>
          }
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="通过后请为其分配角色，否则该用户登录后看不到任何菜单。"
          />
          <Table
            columns={pendingColumns}
            dataSource={pending}
            rowKey="id"
            pagination={false}
            size="small"
          />
        </Card>
      )}

      {resets.length > 0 && (
        <Card
          style={{ marginBottom: 16 }}
          title={
            <Space>
              <LockOutlined style={{ color: "#ef4444" }} />
              <span>待处理的密码重置申请</span>
              <Badge count={resets.length} style={{ backgroundColor: "#ef4444" }} />
            </Space>
          }
        >
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="请先线下核对申请人身份，再为其设置新密码。系统会打上标记，提醒该用户登录后自行修改。"
          />
          <Table
            columns={resetColumns}
            dataSource={resets}
            rowKey="id"
            pagination={false}
            size="small"
          />
        </Card>
      )}

      <Card title="全部账号">
        <Table
          columns={columns}
          dataSource={users}
          rowKey="id"
          loading={loading}
          pagination={false}
        />
      </Card>

      {/* 创建用户弹窗 */}
      <Modal
        title="添加普通用户"
        open={showCreate}
        onCancel={() => setShowCreate(false)}
        footer={null}
      >
        <Form form={createForm} layout="horizontal" className="form-horizontal" labelCol={{ flex: "88px" }} onFinish={handleCreate}>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: "请输入姓名" }]}>
            <Input placeholder="姓名" />
          </Form.Item>
          <Form.Item
            name="phone"
            label="手机号"
            rules={[
              { required: true, message: "请输入手机号" },
              { pattern: /^1[3-9]\d{9}$/, message: "手机号格式不正确" },
            ]}
          >
            <Input placeholder="手机号" maxLength={11} />
          </Form.Item>
          <Form.Item name="password" label="初始密码" rules={[{ required: true, message: "请输入密码" }, { min: 6, message: "至少6位" }]}>
            <Input.Password placeholder="至少6位" />
          </Form.Item>
          <Form.Item name="role_id" label="角色（可选）">
            <Select
              allowClear
              placeholder="不选则无菜单权限，需稍后分配"
              options={roles.map((r) => ({ value: r.id, label: r.name }))}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button onClick={() => setShowCreate(false)}>取消</Button>
              <Button type="primary" htmlType="submit">创建</Button>
            </div>
          </Form.Item>
        </Form>
      </Modal>

      {/* 审批通过弹窗 —— 通过的同时必须指定角色 */}
      <Modal
        title={`通过注册申请 — ${approving?.name || ""}`}
        open={!!approving}
        onCancel={() => setApproving(null)}
        footer={null}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="建议直接为其分配角色，否则该用户登录后将看不到任何功能菜单。"
        />
        <Form form={approveForm} layout="horizontal" className="form-horizontal" labelCol={{ flex: "88px" }} onFinish={handleApprove}>
          {approving && (
            <Form.Item label="申请人">
              <span>{approving.name}（{approving.phone}）</span>
            </Form.Item>
          )}
          <Form.Item name="role_id" label="分配角色">
            <Select
              allowClear
              placeholder="不选则暂无菜单权限"
              options={roles.map((r) => ({ value: r.id, label: r.name }))}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button onClick={() => setApproving(null)}>取消</Button>
              <Button type="primary" htmlType="submit">通过并启用</Button>
            </div>
          </Form.Item>
        </Form>
      </Modal>

      {/* 重置密码弹窗（管理员主动重置） */}
      <Modal
        title="重置密码"
        open={!!showReset}
        onCancel={() => setShowReset(null)}
        footer={null}
      >
        <Form form={resetForm} layout="horizontal" className="form-horizontal" labelCol={{ flex: "88px" }} onFinish={handleReset}>
          <Form.Item name="password" label="新密码" rules={[{ required: true, message: "请输入新密码" }, { min: 6, message: "至少6位" }]}>
            <Input.Password placeholder="至少6位" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button onClick={() => setShowReset(null)}>取消</Button>
              <Button type="primary" htmlType="submit">确认重置</Button>
            </div>
          </Form.Item>
        </Form>
      </Modal>

      {/* 处理忘记密码申请弹窗 */}
      <Modal
        title={`设置新密码 — ${resolving?.name || ""}`}
        open={!!resolving}
        onCancel={() => setResolving(null)}
        footer={null}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="请先确认对方身份。设置后请通过可信渠道线下告知新密码，勿在群聊里发送。"
        />
        <Form form={resolveForm} layout="horizontal" className="form-horizontal" labelCol={{ flex: "88px" }} onFinish={handleResolveReset}>
          {resolving && (
            <Form.Item label="申请人">
              <span>{resolving.name}（{resolving.phone}）</span>
            </Form.Item>
          )}
          <Form.Item
            name="password"
            label="新密码"
            rules={[{ required: true, message: "请输入新密码" }, { min: 6, message: "至少6位" }]}
          >
            <Input.Password placeholder="至少6位，建议使用临时密码" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button onClick={() => setResolving(null)}>取消</Button>
              <Button type="primary" htmlType="submit">设置并关闭申请</Button>
            </div>
          </Form.Item>
        </Form>
      </Modal>

      {/* 分配角色弹窗 */}
      <Modal
        title={`分配角色 — ${assigning?.name || ""}`}
        open={!!assigning}
        onCancel={() => setAssigning(null)}
        footer={null}
      >
        <Form form={assignForm} layout="horizontal" className="form-horizontal" labelCol={{ flex: "88px" }} onFinish={handleAssignRole}>
          <Form.Item name="role_id" label="角色">
            <Select
              allowClear
              placeholder="不选则无菜单权限"
              options={roles.map((r) => ({ value: r.id, label: r.name }))}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button onClick={() => setAssigning(null)}>取消</Button>
              <Button type="primary" htmlType="submit">保存</Button>
            </div>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
