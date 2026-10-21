import { useState, useEffect, useCallback } from "react";
import {
  Card, Table, Button, Tag, Modal, Form, Input, Select, Tabs,
  message, Popconfirm, Space, Typography, Checkbox, Alert,
} from "antd";
import {
  PlusOutlined, ReloadOutlined, KeyOutlined, UserDeleteOutlined, TeamOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import { MENU_PERMISSIONS } from "../types";
import type { User } from "../types";

interface Member {
  id: string; phone: string; name: string; status: string | null;
  role_id: string | null; role_name: string | null;
  created_at: string; must_change_password: number;
}
interface TeamRole { id: string; name: string; permissions: string[]; owner_id: string | null }

// 超管专属菜单（与后端 team.ts ADMIN_ONLY_KEYS 一致），建角色时不允许勾选
const ADMIN_ONLY_KEYS = new Set(["users"]);

export default function Team() {
  const currentUser: User | null = (() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  })();

  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [roles, setRoles] = useState<TeamRole[]>([]);

  const [memberModal, setMemberModal] = useState(false);
  const [memberForm] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const [roleModal, setRoleModal] = useState(false);
  const [roleEditing, setRoleEditing] = useState<TeamRole | null>(null);
  const [roleForm] = Form.useForm();

  const [pwdModal, setPwdModal] = useState<Member | null>(null);
  const [pwdForm] = Form.useForm();

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [m, r] = await Promise.all([api.getTeamMembers(), api.getTeamRoles()]);
      setMembers((m as any).items || []);
      setRoles((r as any).items || []);
    } catch (err) {
      message.error((err as Error).message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleCreateMember = async (v: any) => {
    setSaving(true);
    try {
      await api.createTeamMember(v);
      message.success(`子用户「${v.name}」已创建，首次登录需修改密码`);
      setMemberModal(false);
      memberForm.resetFields();
      fetchAll();
    } catch (err) {
      message.error((err as Error).message);
    }
    setSaving(false);
  };

  const handleSaveRole = async (v: any) => {
    setSaving(true);
    try {
      if (roleEditing) {
        await api.updateTeamRole(roleEditing.id, v);
        message.success("角色已更新");
      } else {
        await api.createTeamRole(v);
        message.success("角色已创建");
      }
      setRoleModal(false);
      setRoleEditing(null);
      roleForm.resetFields();
      fetchAll();
    } catch (err) {
      message.error((err as Error).message);
    }
    setSaving(false);
  };

  const handleAssignRole = async (m: Member, roleId: string | null) => {
    try {
      await api.updateTeamMember(m.id, { role_id: roleId });
      message.success(roleId ? `已分配角色给「${m.name}」` : `已清空「${m.name}」的角色`);
      fetchAll();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleToggleStatus = async (m: Member) => {
    const next = m.status === "disabled" ? "active" : "disabled";
    try {
      await api.updateTeamMember(m.id, { status: next });
      message.success(next === "disabled" ? `已停用「${m.name}」` : `已启用「${m.name}」`);
      fetchAll();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleRemove = async (m: Member) => {
    try {
      await api.removeTeamMember(m.id);
      message.success(`已将「${m.name}」移出团队，其数据对团队不再可见`);
      fetchAll();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleResetPwd = async (v: any) => {
    if (!pwdModal) return;
    setSaving(true);
    try {
      await api.resetTeamMemberPassword(pwdModal.id, v.password);
      message.success("密码已重置，成员下次登录需修改");
      setPwdModal(null);
      pwdForm.resetFields();
    } catch (err) {
      message.error((err as Error).message);
    }
    setSaving(false);
  };

  const roleOptions = roles.map((r) => ({ label: r.name, value: r.id }));
  // 建角色可选的菜单 = 全量菜单 - 超管专属
  const assignableMenus = MENU_PERMISSIONS.filter((m) => !ADMIN_ONLY_KEYS.has(m.key));

  const memberColumns = [
    { title: "姓名", dataIndex: "name", key: "name", render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
    { title: "手机号", dataIndex: "phone", key: "phone", render: (v: string | null) => v || "-" },
    {
      title: "角色", dataIndex: "role_id", key: "role",
      render: (_: string | null, m: Member) => (
        <Select
          style={{ minWidth: 180 }}
          placeholder="未分配（无菜单权限）"
          value={m.role_id || undefined}
          options={roleOptions}
          allowClear
          onChange={(v) => handleAssignRole(m, v || null)}
        />
      ),
    },
    {
      title: "状态", dataIndex: "status", key: "status", width: 90,
      render: (v: string | null, m: Member) => (
        <Tag color={v === "disabled" ? "red" : "green"}>{v === "disabled" ? "已停用" : "正常"}</Tag>
      ),
    },
    {
      title: "操作", key: "actions", width: 230,
      render: (_: any, m: Member) => (
        <Space size={0}>
          <Button type="link" size="small" icon={<KeyOutlined />} onClick={() => { setPwdModal(m); pwdForm.resetFields(); }}>重置密码</Button>
          <Button type="link" size="small" onClick={() => handleToggleStatus(m)}>
            {m.status === "disabled" ? "启用" : "停用"}
          </Button>
          <Popconfirm
            title={`将「${m.name}」移出团队？`}
            description="移出后其数据对团队不可见，账号本身保留"
            onConfirm={() => handleRemove(m)}
          >
            <Button type="link" size="small" danger icon={<UserDeleteOutlined />}>移出</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const roleColumns = [
    { title: "角色名称", dataIndex: "name", key: "name", render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
    {
      title: "菜单权限", dataIndex: "permissions", key: "perms",
      render: (v: string[]) => (
        <Space size={4} wrap>
          {v.length === 0 && <Typography.Text type="secondary">无任何菜单</Typography.Text>}
          {v.map((k) => {
            const meta = MENU_PERMISSIONS.find((m) => m.key === k);
            return <Tag key={k}>{meta?.label || k}</Tag>;
          })}
        </Space>
      ),
    },
    {
      title: "来源", dataIndex: "owner_id", key: "owner", width: 90,
      render: (v: string | null) => (v ? <Tag>自建</Tag> : <Tag color="blue">全局</Tag>),
    },
    {
      title: "操作", key: "actions", width: 140,
      render: (_: any, r: TeamRole) => (
        <Space size={0}>
          <Button type="link" size="small" onClick={() => {
            setRoleEditing(r);
            roleForm.setFieldsValue({ name: r.name, permissions: r.permissions });
            setRoleModal(true);
          }}>编辑</Button>
          <Popconfirm title={`删除角色「${r.name}」？`} onConfirm={async () => {
            try { await api.deleteTeamRole(r.id); message.success("已删除"); fetchAll(); }
            catch (err) { message.error((err as Error).message); }
          }}>
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="page-fill">
      <Card
        style={{ marginBottom: 16 }}
        title={
          <span><TeamOutlined style={{ marginRight: 8 }} />{currentUser?.name || ""} 的团队</span>
        }
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={fetchAll}>刷新</Button>
            <Button icon={<PlusOutlined />} onClick={() => { setRoleEditing(null); roleForm.resetFields(); setRoleModal(true); }}>新建角色</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => { memberForm.resetFields(); setMemberModal(true); }}>创建子用户</Button>
          </Space>
        }
      >
        <Alert
          type="info" showIcon style={{ marginBottom: 12 }}
          message="团队成员之间共享业务数据（人才库、岗位、看板、面试、合同等），各自的操作仍归属本人；子用户首次登录需修改初始密码。"
        />
        <Tabs
          className="app-pill-tabs"
          items={[
            { key: "members", label: `团队成员（${members.length}）`, children: (
              <Table rowKey="id" columns={memberColumns} dataSource={members} loading={loading} pagination={false}
                locale={{ emptyText: "还没有团队成员，点击右上角「创建子用户」" }} />
            )},
            { key: "roles", label: `角色权限（${roles.length}）`, children: (
              <Table rowKey="id" columns={roleColumns} dataSource={roles} loading={loading} pagination={false}
                locale={{ emptyText: "还没有可用角色" }} />
            )},
          ]}
        />
      </Card>

      {/* 创建子用户 */}
      <Modal
        title="创建子用户" open={memberModal} onCancel={() => setMemberModal(false)}
        destroyOnClose footer={null} width={480}
      >
        <Form form={memberForm} layout="vertical" onFinish={handleCreateMember}>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: "请输入姓名" }]}>
            <Input placeholder="请输入姓名" />
          </Form.Item>
          <Form.Item name="phone" label="手机号" rules={[{ required: true, pattern: /^1[3-9]\d{9}$/, message: "请输入正确的手机号" }]}>
            <Input placeholder="用于登录" />
          </Form.Item>
          <Form.Item name="password" label="初始密码" rules={[{ required: true, min: 6, message: "至少 6 位" }]}>
            <Input.Password placeholder="至少 6 位，首次登录需修改" />
          </Form.Item>
          <Form.Item name="role_id" label="角色（决定可见菜单）">
            <Select placeholder="可稍后分配" options={roleOptions} allowClear />
          </Form.Item>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button onClick={() => setMemberModal(false)}>取消</Button>
            <Button type="primary" htmlType="submit" loading={saving}>创建</Button>
          </div>
        </Form>
      </Modal>

      {/* 新建/编辑角色 */}
      <Modal
        title={roleEditing ? `编辑角色 - ${roleEditing.name}` : "新建角色"}
        open={roleModal} onCancel={() => { setRoleModal(false); setRoleEditing(null); }} destroyOnClose footer={null} width={560}
      >
        <Form form={roleForm} layout="vertical" onFinish={handleSaveRole}>
          <Form.Item name="name" label="角色名称" rules={[{ required: true, message: "请输入角色名称" }]}>
            <Input placeholder="如：招聘专员" />
          </Form.Item>
          <Form.Item name="permissions" label="菜单权限">
            <Checkbox.Group
              style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}
              options={assignableMenus.map((m) => ({ label: m.label, value: m.key }))}
            />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            全局角色为超管创建、团队通用；自建角色仅本团队使用。用户管理等超管菜单不可授予。
          </Typography.Paragraph>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button onClick={() => { setRoleModal(false); setRoleEditing(null); }}>取消</Button>
            <Button type="primary" htmlType="submit" loading={saving}>{roleEditing ? "保存" : "创建"}</Button>
          </div>
        </Form>
      </Modal>

      {/* 重置密码 */}
      <Modal
        title={pwdModal ? `重置密码 - ${pwdModal.name}` : "重置密码"}
        open={!!pwdModal} onCancel={() => setPwdModal(null)} destroyOnClose footer={null} width={420}
      >
        <Form form={pwdForm} layout="vertical" onFinish={handleResetPwd}>
          <Form.Item name="password" label="新密码" rules={[{ required: true, min: 6, message: "至少 6 位" }]}>
            <Input.Password placeholder="至少 6 位，成员下次登录需修改" />
          </Form.Item>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button onClick={() => setPwdModal(null)}>取消</Button>
            <Button type="primary" htmlType="submit" loading={saving}>重置</Button>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
