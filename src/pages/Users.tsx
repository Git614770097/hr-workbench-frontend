import { useState, useEffect, useMemo } from "react";
import {
  Card, Table, Button, Space, Tag, Popconfirm, message, Modal, Form, Input, Tooltip, Select, Alert, Badge,
} from "antd";
import {
  KeyOutlined, UserAddOutlined, CheckOutlined, StopOutlined,
  ClockCircleOutlined, LockOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import { ROLE_LABELS } from "../types";
import type { Role, UserRow } from "../types";
import { fmtDateTime, fmtDate } from "../utils/time";

/** 账号状态展示元数据：审批通过的用户不展示状态列内容，保持表格干净 */
const STATUS_OPTIONS = [
  { value: "active", label: "在职" },
  { value: "pending", label: "待审批" },
  { value: "rejected", label: "已拒绝" },
];

/** 角色筛选里的两个虚拟项（不是真实角色 id，用 __ 前缀区分） */
const ROLE_ALL = "";
const ROLE_ADMIN = "__admin";
const ROLE_NONE = "__none";

const EMPTY_QUERY = { keyword: "", role: ROLE_ALL, status: ROLE_ALL };

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

/** 会员状态展示：未开通 / 有效至 X / 已过期 X */
function memberState(paidUntil: string | null | undefined): { status: "none" | "active" | "expired"; label: string } {
  if (!paidUntil) return { status: "none", label: "未开通" };
  const d = new Date(paidUntil.includes("T") || paidUntil.includes("Z") ? paidUntil : paidUntil.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return { status: "none", label: "未开通" };
  // 早期/存量用户回填的远未来有效期（如 2099）视为长期有效
  if (d.getTime() > Date.now() && d.getFullYear() > 2090) {
    return { status: "active", label: "长期有效" };
  }
  return d.getTime() > Date.now()
    ? { status: "active", label: `有效至 ${fmtDate(paidUntil)}` }
    : { status: "expired", label: `已过期 ${fmtDate(paidUntil)}` };
}

export default function Users() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [pending, setPending] = useState<UserRow[]>([]);
  const [resets, setResets] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [showReset, setShowReset] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<UserRow | null>(null);
  const [approving, setApproving] = useState<UserRow | null>(null);
  const [resolving, setResolving] = useState<UserRow | null>(null);
  const [resetForm] = Form.useForm();
  const [assignForm] = Form.useForm();
  const [approveForm] = Form.useForm();
  const [resolveForm] = Form.useForm();
  // ---- 会员开通 / 续期 ----
  const [membering, setMembering] = useState<UserRow | null>(null);
  const [memberMonths, setMemberMonths] = useState(12);
  const [memberDate, setMemberDate] = useState("");

  // ---- 搜索区（约定与其它列表页一致：输入时不立即过滤，点「查询」才应用）----
  const [draft, setDraft] = useState(EMPTY_QUERY);
  const [query, setQuery] = useState(EMPTY_QUERY);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const roleOptions = [
    { value: ROLE_ADMIN, label: "管理员" },
    { value: ROLE_NONE, label: "未分配角色" },
    ...roles.map((r) => ({ value: r.id, label: r.name })),
  ];

  const filtered = useMemo(() => {
    const kw = query.keyword.trim().toLowerCase();
    return users.filter((u) => {
      if (kw && !`${u.name} ${u.phone}`.toLowerCase().includes(kw)) return false;
      if (query.role === ROLE_ADMIN && u.role !== "admin") return false;
      if (query.role === ROLE_NONE && (u.role === "admin" || u.role_id)) return false;
      if (query.role && query.role !== ROLE_ADMIN && query.role !== ROLE_NONE && u.role_id !== query.role) {
        return false;
      }
      if (query.status && (u.status || "active") !== query.status) return false;
      return true;
    });
  }, [users, query]);

  const applyQuery = () => { setQuery(draft); setPage(1); };
  const resetQuery = () => { setDraft(EMPTY_QUERY); setQuery(EMPTY_QUERY); setPage(1); };
  const hasQuery = !!query.keyword || !!query.role || !!query.status;

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

  /** 开通 / 续期：填了指定日期则按日期设定，否则按所选月数顺延 */
  const handleSetMember = async () => {
    if (!membering) return;
    try {
      if (memberDate.trim()) {
        await api.setMembership(membering.id, { paid_until: memberDate.trim() });
        message.success(`已为「${membering.name}」设定会员有效期`);
      } else {
        await api.setMembership(membering.id, { months: memberMonths });
        message.success(`已为「${membering.name}」开通 / 续期 ${memberMonths} 个月`);
      }
      setMembering(null);
      setMemberDate("");
      setMemberMonths(12);
      fetchUsers();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  /** 清空会员（退款 / 撤销） */
  const handleClearMember = async (record: UserRow) => {
    try {
      await api.setMembership(record.id, { clear: true });
      message.success(`已清空「${record.name}」的会员`);
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
      render: (v: string) => fmtDateTime(v),
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
      render: (v: string) => fmtDateTime(v),
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
      render: (v: string) => fmtDateTime(v),
    },
    {
      title: "会员",
      dataIndex: "paid_until",
      key: "paid_until",
      width: 160,
      render: (v: string | null, record: UserRow) => {
        if (record.status === "frozen") return <Tag color="orange">已冻结（只读）</Tag>;
        // 管理员本就长期有效：不需要会员、永不冻结
        if (record.role === "admin") return <Tag color="green">长期有效</Tag>;
        const st = memberState(record.paid_until);
        if (st.status === "active") return <Tag color="green">{st.label}</Tag>;
        if (st.status === "expired") return <Tag color="red">{st.label}</Tag>;
        return <Tag>未开通</Tag>;
      },
    },
    {
      title: "操作",
      key: "action",
      width: 200,
      render: (_: unknown, record: UserRow) => {
        // 长期有效（如 2099 回填、或管理员本就长期有效）且未到期 → 无需重复开通，禁用「开通」
        const st = memberState(record.paid_until);
        const openDisabled = (st.status === "active" && st.label === "长期有效") || record.role === "admin";
        return (
        <Space size={4}>
          <Button
            type="link"
            size="small"
            disabled={openDisabled}
            title={openDisabled ? "该用户已长期有效，无需重复开通" : undefined}
            onClick={() => { if (openDisabled) return; setMembering(record); setMemberMonths(12); setMemberDate(""); }}
          >开通</Button>
          {record.paid_until ? (
            <Popconfirm
              title={`清空「${record.name}」的会员有效期？`}
              description="清空后该用户恢复为未开通状态。"
              onConfirm={() => handleClearMember(record)}
            >
              <Button type="link" size="small" danger>清空</Button>
            </Popconfirm>
          ) : null}
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
        );
      },
    },
  ];

  return (
    <div className="profiles-page">
      {pending.length > 0 && (
        <Card
          className="list-card"
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
            className="profiles-table"
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
          className="list-card"
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
            className="profiles-table"
            columns={resetColumns}
            dataSource={resets}
            rowKey="id"
            pagination={false}
            size="small"
          />
        </Card>
      )}

      {/* 顶部搜索区域：label 左 + 控件右，一行 4 个（复用全站 search-card 约定类） */}
      <Card className="search-card" style={{ marginBottom: 16 }}>
        <div className="search-grid">
          <div className="search-field">
            <span className="search-label">关键词</span>
            <div className="search-control">
              <Input
                allowClear
                style={{ width: "100%" }}
                placeholder="姓名 / 手机号"
                value={draft.keyword}
                onChange={(e) => setDraft({ ...draft, keyword: e.target.value })}
                onPressEnter={applyQuery}
              />
            </div>
          </div>
          <div className="search-field">
            <span className="search-label">角色</span>
            <div className="search-control">
              <Select
                allowClear
                style={{ width: "100%" }}
                placeholder="全部角色"
                value={draft.role || undefined}
                options={roleOptions}
                onChange={(v) => setDraft({ ...draft, role: v ?? ROLE_ALL })}
              />
            </div>
          </div>
          <div className="search-field">
            <span className="search-label">账号状态</span>
            <div className="search-control">
              <Select
                allowClear
                style={{ width: "100%" }}
                placeholder="全部状态"
                value={draft.status || undefined}
                options={STATUS_OPTIONS}
                onChange={(v) => setDraft({ ...draft, status: v ?? ROLE_ALL })}
              />
            </div>
          </div>
        </div>
      </Card>

      <Card className="list-card">
        {/* 布局约定（全站统一）：搜索 Card 只放字段；工具行左侧是数据操作，
            右侧是「重置 / 查询」，两者对齐，不另起一行 */}
        <div className="toolbar">
          <span style={{ flex: 1 }} />
          <Space>
            <Button onClick={resetQuery}>重置</Button>
            <Button type="primary" onClick={applyQuery}>查询</Button>
          </Space>
        </div>
        <Table
          className="profiles-table"
          columns={columns}
          dataSource={filtered}
          rowKey="id"
          loading={loading}
          pagination={{
            current: page,
            pageSize,
            total: filtered.length,
            onChange: (p, ps) => { setPage(p); setPageSize(ps); },
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50],
            showTotal: (t) => `共 ${t} 个账号`,
          }}
          locale={{ emptyText: hasQuery ? "没有符合筛选条件的账号" : "暂无账号" }}
        />
      </Card>

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

      {/* 会员开通 / 续期弹窗 */}
      <Modal
        title={`会员开通 / 续期 — ${membering?.name || ""}`}
        open={!!membering}
        onCancel={() => setMembering(null)}
        footer={null}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="用户扫码付款后，在此确认收款并开通。续费会在当前有效期基础上顺延；已过期或从未开通则从今天起算。"
        />
        <div style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 6 }}>续费时长</div>
          <Select
            value={memberMonths}
            onChange={setMemberMonths}
            style={{ width: "100%" }}
            options={[
              { value: 1, label: "1 个月" },
              { value: 3, label: "3 个月" },
              { value: 12, label: "12 个月（1 年）" },
            ]}
          />
        </div>
        <div style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 6 }}>或指定到期日（YYYY-MM-DD，留空则按上方时长）</div>
          <Input value={memberDate} onChange={(e) => setMemberDate(e.target.value)} placeholder="例如 2027-09-28" />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={() => setMembering(null)}>取消</Button>
          <Button type="primary" onClick={handleSetMember}>确认开通</Button>
        </div>
      </Modal>
    </div>
  );
}
