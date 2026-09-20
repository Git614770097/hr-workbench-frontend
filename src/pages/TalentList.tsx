import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  Card, Table, Input, InputNumber, Select, Button, Space, Tag, Typography,
  Popconfirm, message,
} from "antd";
import {
  DeleteOutlined, ImportOutlined, FilePdfOutlined,
  SearchOutlined, ReloadOutlined, DownOutlined, UpOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import type { Talent, User } from "../types";
import { STATUS_LABELS, STATUS_COLORS, EDUCATION_OPTIONS } from "../types";
import ImportModal from "../components/ImportModal";
import ResumePreviewModal from "../components/ResumePreviewModal";

// 搜索条件（draft = 编辑中，applied = 已生效）
interface Filters {
  name: string;
  phone: string;
  email: string;
  age: number | null;
  education: string;
  school: string;
  years: number | null;
  city: string;
  title: string;
  status: string;
  owner_id: string;
}

const EMPTY_FILTERS: Filters = {
  name: "", phone: "", email: "", age: null, education: "", school: "",
  years: null, city: "", title: "", status: "", owner_id: "",
};

// 收起时展示的字段数（一行 3 个 × 2 行）
const COLLAPSED_COUNT = 6;

export default function TalentList() {
  const [talents, setTalents] = useState<Talent[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [expanded, setExpanded] = useState(false);

  // 弹窗状态
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [previewTalent, setPreviewTalent] = useState<Talent | null>(null);

  const currentUser: User | null = (() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  })();
  const isAdmin = currentUser?.role === "admin";

  const fetchTalents = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { page, limit: 20 };
      if (applied.name) params.name = applied.name;
      if (applied.phone) params.phone = applied.phone;
      if (applied.email) params.email = applied.email;
      if (applied.age != null) params.age = applied.age;
      if (applied.education) params.education = applied.education;
      if (applied.school) params.school = applied.school;
      if (applied.years != null) params.years = applied.years;
      if (applied.city) params.city = applied.city;
      if (applied.title) params.title = applied.title;
      if (applied.status) params.status = applied.status;
      if (applied.owner_id) params.owner_id = applied.owner_id;
      const res = await api.getTalents(params);
      setTalents(res.items);
      setTotal(res.total);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, [page, applied]);

  useEffect(() => {
    fetchTalents();
  }, [fetchTalents]);

  useEffect(() => {
    if (isAdmin) {
      api.getUsers().then((u) => setUsers(u)).catch(() => {});
    }
  }, [isAdmin]);

  // 登录后从 /auth/me 获取用户信息存入 localStorage
  useEffect(() => {
    api.me().then((u) => localStorage.setItem("user", JSON.stringify(u))).catch(() => {});
  }, []);

  const setField = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const handleSearch = () => {
    setPage(1);
    setApplied({ ...draft });
  };

  const handleReset = () => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setPage(1);
  };

  const handleDelete = async (id: string, name: string) => {
    try {
      await api.deleteTalent(id);
      message.success(`已删除「${name}」`);
      fetchTalents();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  // ---- 搜索字段定义（label 左 + 控件右，一行 3 个）----
  const controlStyle: React.CSSProperties = { width: "100%" };
  const fieldDefs: { key: string; label: string; control: React.ReactNode }[] = [
    { key: "name", label: "姓名", control: <Input style={controlStyle} placeholder="请输入姓名" value={draft.name} onChange={(e) => setField("name", e.target.value)} onPressEnter={handleSearch} allowClear /> },
    { key: "phone", label: "手机号", control: <Input style={controlStyle} placeholder="请输入手机号" value={draft.phone} onChange={(e) => setField("phone", e.target.value)} onPressEnter={handleSearch} allowClear /> },
    { key: "email", label: "邮箱", control: <Input style={controlStyle} placeholder="请输入邮箱" value={draft.email} onChange={(e) => setField("email", e.target.value)} onPressEnter={handleSearch} allowClear /> },
    { key: "age", label: "年龄", control: <InputNumber style={controlStyle} value={draft.age} onChange={(v) => setField("age", v ?? null)} min={16} max={80} placeholder="请输入年龄" /> },
    { key: "education", label: "学历", control: <Select style={controlStyle} value={draft.education || undefined} onChange={(v) => setField("education", v || "")} allowClear placeholder="请选择学历" options={EDUCATION_OPTIONS.map((e) => ({ label: e, value: e }))} /> },
    { key: "school", label: "院校", control: <Input style={controlStyle} placeholder="请输入院校" value={draft.school} onChange={(e) => setField("school", e.target.value)} onPressEnter={handleSearch} allowClear /> },
    { key: "years", label: "年限", control: <InputNumber style={controlStyle} value={draft.years} onChange={(v) => setField("years", v ?? null)} min={0} max={50} placeholder="请输入年限" /> },
    { key: "city", label: "城市", control: <Input style={controlStyle} placeholder="请输入城市" value={draft.city} onChange={(e) => setField("city", e.target.value)} onPressEnter={handleSearch} allowClear /> },
    { key: "title", label: "职位", control: <Input style={controlStyle} placeholder="请输入职位" value={draft.title} onChange={(e) => setField("title", e.target.value)} onPressEnter={handleSearch} allowClear /> },
    { key: "status", label: "状态", control: <Select style={controlStyle} value={draft.status || undefined} onChange={(v) => setField("status", v || "")} allowClear placeholder="请选择状态" options={Object.entries(STATUS_LABELS).map(([k, v]) => ({ label: v, value: k }))} /> },
    ...(isAdmin && users.length > 0
      ? [{ key: "owner_id", label: "创建人", control: <Select style={controlStyle} value={draft.owner_id || undefined} onChange={(v) => setField("owner_id", v || "")} allowClear placeholder="请选择创建人" options={users.map((u) => ({ label: u.name, value: u.id }))} /> }]
      : []),
  ];

  const visibleDefs = expanded ? fieldDefs : fieldDefs.slice(0, COLLAPSED_COUNT);

  const columns = [
    {
      title: "姓名",
      dataIndex: "name",
      key: "name",
      width: 100,
      fixed: "left" as const,
      render: (text: string, record: Talent) => (
        <Link to={`/talents/${record.id}`} style={{ fontWeight: 600 }}>{text}</Link>
      ),
    },
    { title: "手机号", dataIndex: "phone", key: "phone", width: 120, render: (v: string) => v || "—" },
    { title: "邮箱", dataIndex: "email", key: "email", width: 180, render: (v: string) => v || "—" },
    { title: "年龄", dataIndex: "age", key: "age", width: 70, render: (v: number | null) => (v != null ? v : "—") },
    { title: "学历", dataIndex: "education", key: "education", width: 90, render: (v: string) => v || "—" },
    { title: "院校", dataIndex: "school", key: "school", width: 140, render: (v: string) => v || "—" },
    {
      title: "年限", dataIndex: "years_experience", key: "years_experience", width: 70,
      render: (v: number | null) => (v != null ? `${v}年` : "—"),
    },
    { title: "城市", dataIndex: "city", key: "city", width: 80, render: (v: string) => v || "—" },
    { title: "职位", dataIndex: "current_title", key: "current_title", width: 130, render: (v: string) => v || "—" },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 100,
      render: (status: string) => (
        <Tag color={STATUS_COLORS[status] || "default"}>
          {STATUS_LABELS[status] || status}
        </Tag>
      ),
    },
    ...(isAdmin ? [{
      title: "创建人",
      dataIndex: "owner_name",
      key: "owner_name",
      width: 90,
      render: (v: string) => v || "—",
    }] : []),
    {
      title: "操作",
      key: "action",
      width: 110,
      fixed: "right" as const,
      render: (_: any, record: Talent) => (
        <Space size="small">
          {record.resume_url && (
            <Button
              type="link" size="small" icon={<FilePdfOutlined />}
              title="预览简历"
              onClick={() => setPreviewTalent(record)}
            />
          )}
          <Popconfirm title="确认删除？所有关联数据将被清除。" onConfirm={() => handleDelete(record.id, record.name)}>
            <Button type="link" size="small" danger icon={<DeleteOutlined />} title="删除" />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {/* 顶部搜索区域：label 左 + 控件右，一行 3 个，超过两行可展开/收起 */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px 24px" }}>
          {visibleDefs.map((d) => (
            <div key={d.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 44, flexShrink: 0, textAlign: "right", fontSize: 13, color: "#666" }}>
                {d.label}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>{d.control}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, marginTop: 12 }}>
          <Button icon={<ReloadOutlined />} onClick={handleReset}>重置</Button>
          <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>搜索</Button>
          {fieldDefs.length > COLLAPSED_COUNT && (
            <Button type="link" size="small" onClick={() => setExpanded(!expanded)}>
              {expanded ? <>收起 <UpOutlined /></> : <>展开 <DownOutlined /></>}
            </Button>
          )}
        </div>
      </Card>

      <Card>
        {/* 列表左上角：导入按钮 */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <Button icon={<ImportOutlined />} onClick={() => setImportModalOpen(true)}>导入</Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            共 {total} 位人才
          </Typography.Text>
        </div>
        <Table
          columns={columns}
          dataSource={talents}
          rowKey="id"
          loading={loading}
          scroll={{ x: 1200 }}
          pagination={{
            current: page,
            total,
            pageSize: 20,
            onChange: (p) => setPage(p),
            showTotal: (t) => `共 ${t} 位人才`,
          }}
        />
      </Card>

      {/* 批量导入弹窗 */}
      <ImportModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onSuccess={fetchTalents}
      />

      {/* 简历预览弹窗（PDF 原生渲染保留格式；Word 在线转 HTML 查看，不下载） */}
      <ResumePreviewModal talent={previewTalent} onClose={() => setPreviewTalent(null)} />
    </div>
  );
}
