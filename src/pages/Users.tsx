import { useState, useEffect } from "react";
import {
  Card, Table, Button, Space, Tag, Popconfirm, message, Modal, Form, Input, Tooltip,
} from "antd";
import { PlusOutlined, DeleteOutlined, KeyOutlined } from "@ant-design/icons";
import { api } from "../api";
import { ROLE_LABELS } from "../types";

interface UserRow {
  id: string;
  phone: string;
  name: string;
  role: string;
  created_at: string;
}

export default function Users() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showReset, setShowReset] = useState<string | null>(null);
  const [createForm] = Form.useForm();
  const [resetForm] = Form.useForm();

  const fetchUsers = async () => {
    try {
      const res = await api.getUsers();
      setUsers(res);
    } catch (err) {
      message.error((err as Error).message);
    }
    setLoading(false);
  };

  useEffect(() => { fetchUsers(); }, []);

  const handleCreate = async (values: { phone: string; name: string; password: string }) => {
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

  const columns = [
    {
      title: "姓名",
      dataIndex: "name",
      key: "name",
      render: (text: string) => <strong>{text}</strong>,
    },
    {
      title: "手机号",
      dataIndex: "phone",
      key: "phone",
    },
    {
      title: "角色",
      dataIndex: "role",
      key: "role",
      width: 100,
      render: (role: string) => (
        <Tag color={role === "admin" ? "gold" : "blue"}>
          {ROLE_LABELS[role] || role}
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
      width: 160,
      render: (_: any, record: UserRow) => (
        <Space>
          <Tooltip title="重置密码">
            <Button type="link" size="small" icon={<KeyOutlined />} onClick={() => { setShowReset(record.id); resetForm.resetFields(); }} />
          </Tooltip>
          {record.role !== "admin" && (
            <Popconfirm title="确认删除？该用户的所有数据将被清除。" onConfirm={() => handleDelete(record.id, record.name)}>
              <Button type="link" size="small" danger icon={<DeleteOutlined />}>删除</Button>
            </Popconfirm>
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

      <Card>
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
        <Form form={createForm} layout="vertical" onFinish={handleCreate}>
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
          <Form.Item style={{ marginBottom: 0 }}>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button onClick={() => setShowCreate(false)}>取消</Button>
              <Button type="primary" htmlType="submit">创建</Button>
            </div>
          </Form.Item>
        </Form>
      </Modal>

      {/* 重置密码弹窗 */}
      <Modal
        title="重置密码"
        open={!!showReset}
        onCancel={() => setShowReset(null)}
        footer={null}
      >
        <Form form={resetForm} layout="vertical" onFinish={handleReset}>
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
    </div>
  );
}
