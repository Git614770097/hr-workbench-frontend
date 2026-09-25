import { useState, useEffect, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Card, Table, Button, Space, Tag, Input, Select, Popconfirm, message, Tooltip,
  Progress, Modal, Empty, Spin, Badge, Dropdown,
} from "antd";
import {
  PlusOutlined, SearchOutlined, ReloadOutlined,
  TeamOutlined, PlayCircleOutlined, PauseCircleOutlined, StopOutlined,
  CheckOutlined,
} from "@ant-design/icons";
import type { MenuProps } from "antd";
import { api } from "../api";
import type { Job, JobDetail, JobCandidate, User } from "../types";
import {
  JOB_STATUS_LABELS, JOB_STATUS_COLORS, JOB_TYPE_LABELS, PRIORITY_LABELS,
  PRIORITY_COLORS, PIPELINE_STAGES, STAGE_META,
} from "../types";
import JobFormModal from "../components/JobFormModal";
import AddToPipelineModal from "../components/AddToPipelineModal";

const PAGE_SIZE = 10;

export default function Jobs() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);

  const [draftQ, setDraftQ] = useState("");
  const [draftStatus, setDraftStatus] = useState("");
  const [draftPriority, setDraftPriority] = useState("");
  const [draftOwner, setDraftOwner] = useState("");
  const [applied, setApplied] = useState({ q: "", status: "", priority: "", owner_id: "" });

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [presetJobId, setPresetJobId] = useState<string | null>(null);

  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const currentUser: User | null = (() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  })();
  const isAdmin = currentUser?.role === "admin";

  const fetchJobs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getJobs({
        page, limit: PAGE_SIZE,
        q: applied.q, status: applied.status,
        priority: applied.priority, owner_id: applied.owner_id,
      });
      setJobs(res.items);
      setTotal(res.total);
    } catch (err) {
      message.error((err as Error).message);
    }
    setLoading(false);
  }, [page, applied]);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  useEffect(() => {
    if (isAdmin) api.getUsers().then(setUsers).catch(() => {});
  }, [isAdmin]);

  const handleSearch = () => {
    setPage(1);
    setApplied({ q: draftQ, status: draftStatus, priority: draftPriority, owner_id: draftOwner });
  };

  const handleReset = () => {
    setDraftQ(""); setDraftStatus(""); setDraftPriority(""); setDraftOwner("");
    setApplied({ q: "", status: "", priority: "", owner_id: "" });
    setPage(1);
  };

  // 快速切换岗位状态（在招 ⇄ 暂停 / 关闭）
  const quickStatus = async (job: Job, status: string) => {
    try {
      await api.updateJob(job.id, { status } as Partial<Job>);
      message.success(`「${job.title}」已${JOB_STATUS_LABELS[status]}`);
      fetchJobs();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleDelete = async (job: Job) => {
    try {
      await api.deleteJob(job.id);
      message.success(`已删除「${job.title}」`);
      fetchJobs();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const openDetail = async (job: Job) => {
    setDetailLoading(true);
    setDetail({ ...job, candidates: [], stage_counts: {} } as JobDetail);
    try {
      const d = await api.getJob(job.id);
      setDetail(d);
    } catch (err) {
      message.error((err as Error).message);
      setDetail(null);
    }
    setDetailLoading(false);
  };

  // 切换状态菜单：当前状态项打勾置灰不可点，其余为可执行动作。
  // 图标语义：在招=播放、暂停=暂停、关闭=停止；菜单外观用「开关」而非导出图标。
  const statusMenu = (job: Job): MenuProps["items"] =>
    (["open", "paused", "closed"] as const).map((s) => {
      const isCurrent = s === job.status;
      return {
        key: s,
        disabled: isCurrent,
        label: isCurrent
          ? `${JOB_STATUS_LABELS[s]}（当前）`
          : s === "open" ? "设为在招" : s === "paused" ? "暂停招聘" : "关闭岗位",
        icon: isCurrent
          ? <CheckOutlined />
          : s === "open" ? <PlayCircleOutlined /> : s === "paused" ? <PauseCircleOutlined /> : <StopOutlined />,
      };
    });

  const columns = [
    {
      title: "岗位名称",
      dataIndex: "title",
      key: "title",
      width: 200,
      render: (v: string, r: Job) => (
        <a onClick={() => openDetail(r)} style={{ fontWeight: 600 }}>{v}</a>
      ),
    },
    { title: "部门", dataIndex: "department", key: "department", width: 110, render: (v: string) => v || "—" },
    { title: "城市", dataIndex: "city", key: "city", width: 90, render: (v: string) => v || "—" },
    {
      title: "类型", dataIndex: "job_type", key: "job_type", width: 80,
      render: (v: string) => JOB_TYPE_LABELS[v] || v,
    },
    {
      title: "招聘进度", key: "progress", width: 150,
      render: (_: any, r: Job) => {
        const done = r.hired || 0;
        const hc = r.headcount || 1;
        const pct = Math.min(100, Math.round((done / hc) * 100));
        return (
          <Tooltip title={`已入职 ${done} / 需求 ${hc}，流程中 ${r.active_count || 0} 人`}>
            <div style={{ minWidth: 110 }}>
              <Progress
                percent={pct} size="small"
                strokeColor={pct >= 100 ? "#10b981" : "#3b82f6"}
                format={() => `${done}/${hc}`}
              />
            </div>
          </Tooltip>
        );
      },
    },
    {
      title: "流程中", dataIndex: "active_count", key: "active_count", width: 90,
      render: (v: number, r: Job) => (
        <a onClick={() => openDetail(r)}>
          <Badge count={v || 0} showZero color={(v || 0) > 0 ? "#3b82f6" : "#d9d9d9"} overflowCount={999} />
        </a>
      ),
    },
    {
      title: "紧急度", dataIndex: "priority", key: "priority", width: 90,
      render: (v: string) => <Tag color={PRIORITY_COLORS[v] || "default"}>{PRIORITY_LABELS[v] || v}</Tag>,
    },
    {
      title: "状态", dataIndex: "status", key: "status", width: 90,
      render: (v: string) => <Tag color={JOB_STATUS_COLORS[v] || "default"}>{JOB_STATUS_LABELS[v] || v}</Tag>,
    },
    { title: "薪资", dataIndex: "salary_range", key: "salary_range", width: 130, render: (v: string) => v || "—" },
    ...(isAdmin ? [{
      title: "创建人", dataIndex: "owner_name", key: "owner_name", width: 100,
      render: (v: string) => v || "—",
    }] : []),
    {
      title: "操作", key: "action", width: 300, fixed: "right" as const,
      render: (_: any, r: Job) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => { setPresetJobId(r.id); setAddOpen(true); }}>
            添加候选人
          </Button>
          <Button type="link" size="small" onClick={() => navigate(`/profiles?job_id=${r.id}`)}>生成画像</Button>
          <Button type="link" size="small" onClick={() => { setEditingId(r.id); setFormOpen(true); }}>编辑</Button>
          <Dropdown
            menu={{ items: statusMenu(r), onClick: ({ key }) => quickStatus(r, key), selectable: true, selectedKeys: [r.status] }}
            trigger={["click"]}
          >
            <Button type="link" size="small">切换状态</Button>
          </Dropdown>
          <Popconfirm
            title="确认删除该岗位？"
            description="岗位下的候选人关联会被清除，人才档案保留。"
            onConfirm={() => handleDelete(r)}
          >
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Card className="search-card" style={{ marginBottom: 16 }}>
        {/* 布局约定（全站统一）：搜索 Card 只放字段（label 左 / 控件右，一行 4 个）；
            筛选条件超过 4 个时自动换行，不另起按钮行。 */}
        <div className="search-grid">
          <Field label="岗位">
            <Input
              placeholder="岗位名称 / 部门 / 职责" value={draftQ}
              onChange={(e) => setDraftQ(e.target.value)} onPressEnter={handleSearch} allowClear
            />
          </Field>
          <Field label="状态">
            <Select
              style={{ width: "100%" }} allowClear placeholder="全部"
              value={draftStatus || undefined} onChange={(v) => setDraftStatus(v || "")}
              options={Object.entries(JOB_STATUS_LABELS).map(([k, v]) => ({ label: v, value: k }))}
            />
          </Field>
          <Field label="紧急度">
            <Select
              style={{ width: "100%" }} allowClear placeholder="全部"
              value={draftPriority || undefined} onChange={(v) => setDraftPriority(v || "")}
              options={Object.entries(PRIORITY_LABELS).map(([k, v]) => ({ label: v, value: k }))}
            />
          </Field>
          {isAdmin ? (
            <Field label="创建人">
              <Select
                style={{ width: "100%" }} allowClear placeholder="全部"
                value={draftOwner || undefined} onChange={(v) => setDraftOwner(v || "")}
                options={users.map((u) => ({ label: u.name, value: u.id }))}
              />
            </Field>
          ) : <div />}
        </div>
      </Card>

      <Card className="list-card">
        {/* 布局约定（全站统一）：查询区的「重置/查询」与工具栏的「新增」放在同一列、
            同一条竖线上，用 grid 的透明占位格把按钮推到第 4 列，形成对齐的右侧操作区。 */}
        <div className="toolbar">
          <Space>
            <Button
              type="primary" icon={<PlusOutlined />}
              onClick={() => { setEditingId(null); setFormOpen(true); }}
            >
              新增岗位
            </Button>
            <Link to="/pipeline">
              <Button icon={<TeamOutlined />}>查看招聘流程</Button>
            </Link>
          </Space>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={handleReset}>重置</Button>
            <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>查询</Button>
          </Space>
        </div>

        <Table
          className="profiles-table"
          columns={columns}
          dataSource={jobs}
          rowKey="id"
          loading={loading}
          scroll={{ x: 1500 }}
          pagination={{
            current: page,
            total,
            pageSize: PAGE_SIZE,
            onChange: (p) => setPage(p),
            showTotal: (t) => `共 ${t} 个岗位`,
          }}
        />
      </Card>

      {/* 新增 / 编辑岗位 */}
      <JobFormModal
        open={formOpen}
        jobId={editingId}
        onClose={() => setFormOpen(false)}
        onSuccess={fetchJobs}
      />

      {/* 岗位添加候选人 */}
      <AddToPipelineModal
        open={addOpen}
        presetJobId={presetJobId}
        onClose={() => { setAddOpen(false); setPresetJobId(null); }}
        onSuccess={fetchJobs}
      />

      {/* 岗位详情：候选人列表 */}
      <Modal
        title={detail ? `${detail.title} · 候选人` : "岗位候选人"}
        open={!!detail}
        onCancel={() => setDetail(null)}
        footer={<Button onClick={() => setDetail(null)}>关闭</Button>}
        width={900}
      >
        {detailLoading ? (
          <div style={{ textAlign: "center", padding: "3rem" }}><Spin size="large" /></div>
        ) : detail ? (
          <>
            <Space wrap size={[8, 8]} style={{ marginBottom: 16 }}>
              <Tag color={JOB_STATUS_COLORS[detail.status]}>{JOB_STATUS_LABELS[detail.status]}</Tag>
              {detail.department && <Tag>{detail.department}</Tag>}
              {detail.city && <Tag>{detail.city}</Tag>}
              <Tag>{JOB_TYPE_LABELS[detail.job_type] || detail.job_type}</Tag>
              <Tag color="blue">HC {detail.headcount}</Tag>
              {detail.salary_range && <Tag color="gold">{detail.salary_range}</Tag>}
            </Space>

            {/* 各阶段人数 */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
              {PIPELINE_STAGES.map((s) => {
                const n = detail.stage_counts[s.key] || 0;
                return (
                  <div
                    key={s.key}
                    style={{
                      padding: "4px 10px", borderRadius: 8, background: s.bg,
                      color: s.color, fontSize: 12, fontWeight: 600,
                      opacity: n === 0 ? 0.45 : 1,
                    }}
                  >
                    {s.label} {n}
                  </div>
                );
              })}
            </div>

            {(detail.description || detail.requirements) && (
              <div className="job-meta" style={{ marginBottom: 16 }}>
                {detail.description && (
                  <div><b>岗位职责：</b>{detail.description}</div>
                )}
                {detail.requirements && (
                  <div style={{ marginTop: 6 }}><b>任职要求：</b>{detail.requirements}</div>
                )}
              </div>
            )}

            {detail.candidates.length === 0 ? (
              <Empty description="该岗位还没有候选人" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Table
                rowKey="link_id"
                dataSource={detail.candidates as JobCandidate[]}
                size="small"
                pagination={false}
                scroll={{ y: 340 }}
                columns={[
                  {
                    title: "姓名", dataIndex: "name", width: 110,
                    render: (v: string, r: JobCandidate) => (
                      <Link to={`/talents/${r.talent_id}`} style={{ fontWeight: 600 }}>{v}</Link>
                    ),
                  },
                  {
                    title: "阶段", dataIndex: "stage", width: 100,
                    render: (v: string) => {
                      const m = STAGE_META[v];
                      return <Tag color={m?.color} style={{ marginInlineEnd: 0 }}>{m?.label || v}</Tag>;
                    },
                  },
                  { title: "职位", dataIndex: "current_title", width: 140, render: (v: string) => v || "—" },
                  { title: "公司", dataIndex: "current_company", width: 160, render: (v: string) => v || "—" },
                  {
                    title: "年限", dataIndex: "years_experience", width: 70,
                    render: (v: number | null) => (v != null ? `${v}年` : "—"),
                  },
                  { title: "学历", dataIndex: "education", width: 90, render: (v: string) => v || "—" },
                  { title: "城市", dataIndex: "city", width: 80, render: (v: string) => v || "—" },
                  { title: "手机号", dataIndex: "phone", width: 130, render: (v: string) => v || "—" },
                ]}
              />
            )}
          </>
        ) : null}
      </Modal>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="search-field">
      <span className="search-label">{label}</span>
      <div className="search-control">{children}</div>
    </div>
  );
}
