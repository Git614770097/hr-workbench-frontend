import { useState, useEffect } from "react";
import { Card, Table, Button, Space, Tag, Popconfirm, message, Modal, Form, Input, Checkbox, Typography } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { api } from "../api";
import type { Role } from "../types";
import { MENU_PERMISSIONS } from "../types";

export default function Roles() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Role | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [form] = Form.useForm();

  const fetchRoles = async () => {
    try {
      setRoles(await api.getRoles());
    } catch (err) {
      message.error((err as Error).message);
    }
    setLoading(false);
  };

  useEffect(() => { fetchRoles(); }, []);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ permissions: ["talents", "templates"] });
    setShowModal(true);
  };

  const openEdit = (role: Role) => {
    setEditing(role);
    form.setFieldsValue({ name: role.name, permissions: role.permissions });
    setShowModal(true);
  };

  const handleSubmit = async (values: { name: string; permissions: string[] }) => {
    try {
      const permissions = values.permissions || [];
      if (editing) {
        await api.updateRole(editing.id, { name: values.name, permissions });
        message.success("角色已更新");
      } else {
        await api.createRole({ name: values.name, permissions });
        message.success("角色已创建");
      }
      setShowModal(false);
      fetchRoles();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleDelete = async (role: Role) => {
    try {
      await api.deleteRole(role.id);
      message.success(`已删除角色「${role.name}」`);
      fetchRoles();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const columns = [
    {
      title: "角色名",
      dataIndex: "name",
      key: "name",
      render: (v: string) => <strong>{v}</strong>,
    },
    {
      title: "可见菜单",
      dataIndex: "permissions",
      key: "permissions",
      render: (perms: string[]) => (
        <Space size={4} wrap>
          {perms.map((p) => {
            const def = MENU_PERMISSIONS.find((m) => m.key === p);
            return def ? <Tag key={p} color="blue">{def.label}</Tag> : null;
          })}
          {perms.length === 0 && <Typography.Text type="secondary">无任何菜单</Typography.Text>}
        </Space>
      ),
    },
    {
      title: "操作",
      key: "action",
      width: 160,
      render: (_: unknown, record: Role) => (
        <Space>
          <Button type="link" size="small" onClick={() => openEdit(record)}>编辑</Button>
          <Popconfirm title={`确认删除角色「${record.name}」？`} onConfirm={() => handleDelete(record)}>
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", marginBottom: 16 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建角色</Button>
      </div>

      <Card>
        <Table className="profiles-table" columns={columns} dataSource={roles} rowKey="id" loading={loading} pagination={false} />
        <div style={{ marginTop: 12, fontSize: 12 }}>
          <Typography.Text type="secondary">
            说明：管理员拥有全部菜单权限，不受角色限制；「用户管理」仅管理员可见，普通角色即使勾选也不会生效。
          </Typography.Text>
        </div>
      </Card>

      <Modal
        title={editing ? "编辑角色" : "新建角色"}
        open={showModal}
        onCancel={() => setShowModal(false)}
        footer={null}
        destroyOnClose
      >
        <Form form={form} layout="horizontal" className="form-horizontal" labelCol={{ flex: "72px" }} onFinish={handleSubmit}>
          <Form.Item name="name" label="角色名" rules={[{ required: true, message: "请输入角色名" }]}>
            <Input placeholder="例如：招聘专员" maxLength={20} />
          </Form.Item>
          <Form.Item name="permissions" label="可见菜单">
            <Checkbox.Group style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {MENU_PERMISSIONS.filter((m) => m.key !== "users").map((m) => (
                <Checkbox key={m.key} value={m.key}>{m.label}</Checkbox>
              ))}
            </Checkbox.Group>
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button onClick={() => setShowModal(false)}>取消</Button>
              <Button type="primary" htmlType="submit">{editing ? "保存" : "创建"}</Button>
            </div>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
