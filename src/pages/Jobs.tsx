import { useState, useEffect, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Card, Table, Button, Space, Tag, Input, Select, Popconfirm, message, Tooltip,
  Progress, Modal, Empty, Spin, Badge, Typography, Dropdown,
} from "antd";
import {
  PlusOutlined, SearchOutlined, ReloadOutlined,
  TeamOutlined,
  DownloadOutlined, RobotOutlined, CopyOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import AiThinking from "../components/AiThinking";
import { TypeText } from "../utils/useTypewriter";
import type { Job, JobDetail, JobCandidate, User, AiJobDiagnosis } from "../types";
import { copyText as copyToClipboard } from "../utils/clipboard";
import { buildJobDiagnosisReport } from "../utils/jobReport";
import {
  JOB_STATUS_LABELS, JOB_STATUS_COLORS, PRIORITY_LABELS,
  PRIORITY_COLORS, PIPELINE_STAGES, STAGE_META, PALETTE,
} from "../types";
import JobFormModal from "../components/JobFormModal";
import AddToPipelineModal from "../components/AddToPipelineModal";
import { useDict } from "../dict";
import { downloadBlob, dateStamp, csvCell } from "../utils/file";
import { registerOnbFill } from "../components/onboardingAutoFill";

const PAGE_SIZE = 10;

export default function Jobs() {  const navigate = useNavigate();
  const { jobTypeLabels } = useDict();
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
  // 新手指引代填数据（仅新增态写入）+ 触发填充的计数
  const [jobPrefill, setJobPrefill] = useState<Record<string, any> | undefined>(undefined);
  const [jobFillToken, setJobFillToken] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [presetJobId, setPresetJobId] = useState<string | null>(null);

  // 新手指引：登记「打开空表单」与「填示例数据」两个回调
  useEffect(() => {
    return registerOnbFill("/jobs", {
      open: () => {
        setEditingId(null);
        setJobPrefill(undefined); // 打开空表单
        setFormOpen(true);
      },
      fill: () => {
        setJobPrefill({
          title: "高级前端工程师",
          department: "技术部",
          city: "深圳",
          job_type: "fulltime",
          headcount: 2,
          salary_range: "25-40K·14薪",
          education: "本科",
          experience: "3-5年",
          description: "负责核心业务系统的前端开发与体验优化，参与技术选型与性能治理。",
          requirements: "熟练掌握 React 与 TypeScript；有大型前端项目经验者优先。",
        });
        setJobFillToken((t) => t + 1); // 触发弹窗把示例写进已打开的表单
      },
    });
  }, []);

  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // AI 岗位诊断：单岗位「为什么招人慢」——结合漏斗/停留/画像；失败降级为数据提示
  const [diag, setDiag] = useState<{ loading: boolean; data: AiJobDiagnosis | null; err: string }>({
    loading: false, data: null, err: "",
  });

  // 组装诊断数据：漏斗人数 + 进行中阶段平均停留 + 终态分布 + 画像概况 + 备注样本（截断脱敏）
  // 组装逻辑抽到 utils/jobReport.ts，与「AI 助手」页共用同一份口径。
  const genDiagnosis = async () => {
    if (!detail) return;
    setDiag({ loading: true, data: null, err: "" });
    try {
      const r = await api.aiJobDiagnosis({ scope: detail.id, report: buildJobDiagnosisReport(detail) });
      setDiag({ loading: false, data: r, err: "" });
    } catch (err) {
      setDiag({ loading: false, data: null, err: (err as Error).message || "生成失败，请稍后重试" });
    }
  };

  const copyDiag = async () => {
    if (!diag.data) return;
    const text = [
      diag.data.verdict,
      "",
      ...diag.data.reasons.map((x) => `· ${x}`),
      "",
      ...diag.data.actions.map((x, i) => `${i + 1}. ${x}`),
    ].join("\n");
    const ok = await copyToClipboard(text);
    if (ok) message.success("已复制诊断全文");
    else message.error("复制失败，请手动选择文本复制");
  };

  const currentUser: User | null = (() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  })();
  const isAdmin = currentUser?.role === "admin";
  // 人才AI匹配与画像同为 profiles 权限；无权时不拉画像列表、不渲染「匹配人才」按钮
  const canProfiles = isAdmin || (currentUser?.permissions || []).includes("profiles");
  const [matchProfiles, setMatchProfiles] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    if (!canProfiles) return;
    let alive = true;
    // 只用于「有没有画像 / 按标题关联」，用轻量列表即可，不必拉 JD 原文
    api.getMatchProfilesLite()
      .then((list) => {
        if (!alive) return;
        // id 理论必填，防御性过滤；画像与岗位靠标题关联，取标题做匹配键
        setMatchProfiles(
          list
            .map((p) => ({ id: p.id || "", title: (p.job_title || p.name || "").trim() }))
            .filter((p) => p.id),
        );
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [canProfiles]);

  // 行内「AI匹配」：按岗位标题找同名画像 → 直达匹配页；没有同名画像时直接进画像创建
  // （岗位信息自动预填）——原「生成画像」按钮已合并进这里：少一步跳转，功能不丢失
  const goMatchForJob = (job: Job) => {
    const t = (job.title || "").trim().toLowerCase();
    const hit = matchProfiles.find((p) => p.title && p.title.toLowerCase() === t);
    if (hit) navigate("/match", { state: { profileId: hit.id } });
    else {
      message.info(`还没有与「${job.title}」同名的职位画像，已带你创建并预填岗位信息`);
      navigate(`/profiles?job_id=${job.id}`);
    }
  };

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
    setDiag({ loading: false, data: null, err: "" }); // 换岗位时清空上一条的 AI 诊断
    try {
      const d = await api.getJob(job.id);
      setDetail(d);
    } catch (err) {
      message.error((err as Error).message);
      setDetail(null);
    }
    setDetailLoading(false);
  };

  const columns = [
    {
      title: "岗位名称",
      dataIndex: "title",
      key: "title",
      width: 200,
      render: (v: string, r: Job) => (
        <Tooltip title="点击查看岗位详情">
          <a onClick={() => openDetail(r)} className="job-link" style={{ fontWeight: 600 }}>{v}</a>
        </Tooltip>
      ),
    },
    { title: "部门", dataIndex: "department", key: "department", width: 110, render: (v: string) => v || "-" },
    { title: "城市", dataIndex: "city", key: "city", width: 90, render: (v: string) => v || "-" },
    {
      title: "类型", dataIndex: "job_type", key: "job_type", width: 80,
      render: (v: string) => jobTypeLabels[v] || v,
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
                strokeColor={pct >= 100 ? "#10b981" : PALETTE.blue}
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
        <Tooltip title="点击查看岗位详情">
          <a onClick={() => openDetail(r)} className="job-badge-link">
            <Badge count={v || 0} showZero color={(v || 0) > 0 ? PALETTE.blue : "#d9d9d9"} overflowCount={999} />
          </a>
        </Tooltip>
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
    { title: "薪资", dataIndex: "salary_range", key: "salary_range", width: 130, render: (v: string) => v || "-" },
    ...(isAdmin ? [{
      title: "创建人", dataIndex: "owner_name", key: "owner_name", width: 100,
      render: (v: string) => v || "-",
    }] : []),
    {
      // 操作列窄化（2026-10-24）：行内只留高频「编辑/删除」，添加候选人/匹配人才
      // 收进「更多」——4 个纯文字按钮实测要 260px+ 占屏太宽；添加入口在招聘看板也有一份。
      title: "操作", key: "action", width: 175, fixed: "right" as const,
      render: (_: any, r: Job) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => { setEditingId(r.id); setFormOpen(true); }}>编辑</Button>
          <Popconfirm
            title={"确认删除该岗位？"}
            description={"岗位下的候选人关联会被清除，人才档案保留。"}
            onConfirm={() => handleDelete(r)}
          >
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                { key: "add", label: "添加候选人" },
                ...(canProfiles ? [{ key: "match", label: "匹配人才" }] : []),
              ],
              onClick: ({ key }) => {
                if (key === "add") { setPresetJobId(r.id); setAddOpen(true); }
                if (key === "match") goMatchForJob(r);
              },
            }}
          >
            <Button type="link" size="small">更多</Button>
          </Dropdown>
        </Space>
      ),
    },
  ];

  /** 导出当前筛选下的岗位列表为 CSV（含招聘进度等聚合字段） */
  const exportJobs = () => {
    if (!jobs.length) { message.warning("当前没有可导出的岗位"); return; }
    const rows: string[] = [];
    const statusLabel = draftStatus ? (JOB_STATUS_LABELS[draftStatus] || draftStatus) : "全部状态";
    const priorityLabel = draftPriority ? (PRIORITY_LABELS[draftPriority] || draftPriority) : "全部紧急度";

    rows.push("岗位列表导出");
    rows.push([`状态：${statusLabel}`, `紧急度：${priorityLabel}`, `导出时间：${new Date().toLocaleString("zh-CN")}`].map(csvCell).join(","));
    rows.push("");

    rows.push("岗位名称,部门,城市,类型,招聘进度,流程中,紧急度,状态,薪资,学历,经验,创建人,创建时间");
    for (const j of jobs) {
      rows.push([
        j.title,
        j.department || "-",
        j.city || "-",
        jobTypeLabels[j.job_type] || j.job_type,
        `${j.hired || 0}/${j.headcount || 1}`,
        j.active_count || 0,
        PRIORITY_LABELS[j.priority] || j.priority,
        JOB_STATUS_LABELS[j.status] || j.status,
        j.salary_range || "-",
        j.education || "-",
        j.experience || "-",
        j.owner_name || "-",
        j.created_at || "-",
      ].map(csvCell).join(","));
    }

    const blob = new Blob(["\ufeff" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
    downloadBlob(blob, `${"岗位列表"}_${dateStamp()}.csv`);
    message.success(`已导出 ${jobs.length} 个岗位`);
  };

  // 岗位列表区：搜索卡 + 列表卡 + 岗位相关弹窗（招聘需求已独立成页，见 /requisitions）
  const jobsPane = (
    <>
      <Card className="search-card" style={{ marginBottom: 16 }}>
        {/* 布局约定（全站统一）：搜索 Card 只放字段（label 左 / 控件右，一行 4 个）；
            筛选条件超过 4 个时自动换行，不另起按钮行。 */}
        <div className="search-grid">
          <Field label={"岗位"}>
            <Input
              placeholder={"岗位名称 / 部门 / 职责"} value={draftQ}
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
              data-onb-action="new-job"
              onClick={() => { setEditingId(null); setJobPrefill(undefined); setFormOpen(true); }}
            >
              {"新增岗位"}
            </Button>
            <Link to="/requisitions" className="btn-as-link">
              <PlusOutlined /> 提交招聘需求
            </Link>
            {/* 不要 <Link><Button/></Link>：<a> 内嵌 <button> 是非法 HTML，点击易被外层吞掉。 */}
            <Link to="/pipeline" className="btn-as-link">
              <TeamOutlined /> {"查看招聘看板"}
            </Link>
            <Button icon={<DownloadOutlined />} onClick={exportJobs}>导出</Button>
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
          scroll={{ x: 1450 }}
          locale={{
            // 空库引导：新企业第一次进来，给一个一键看效果的入口
            emptyText: (
              <div style={{ padding: "40px 0", textAlign: "center" }}>
                <Empty description={"还没有岗位"} image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginBottom: 16 }} />
                <div style={{ marginTop: 12 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{"点「新增岗位」创建第一个岗位"}</Typography.Text>
                </div>
              </div>
            ),
          }}
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
        prefill={jobPrefill}
        fillToken={jobFillToken}
        onClose={() => { setFormOpen(false); setJobPrefill(undefined); }}
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
              <Tag>{jobTypeLabels[detail.job_type] || detail.job_type}</Tag>
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
                  <div><b>{"岗位职责："}</b>{detail.description}</div>
                )}
                {detail.requirements && (
                  <div style={{ marginTop: 6 }}><b>任职要求：</b>{detail.requirements}</div>
                )}
              </div>
            )}

            {/* AI 岗位诊断：结合漏斗/停留/画像分析「为什么招人慢」；AI 失败时降级为数据提示 */}
            <div style={{ marginBottom: 16 }}>
              {diag.loading ? (
                <AiThinking steps={["正在读取岗位漏斗…", "正在定位瓶颈…", "正在生成建议…"]} />
              ) : diag.data ? (
                <div style={{ border: "1px solid #f0f0f0", borderRadius: 8, padding: 12 }}>
                  <div style={{ marginBottom: 8 }}>
                    <Tag color="geekblue" style={{ marginInlineEnd: 8 }}><RobotOutlined /> AI 诊断</Tag>
                    <b><TypeText text={diag.data.verdict} /></b>
                  </div>
                  {diag.data.reasons.map((r, i) => (
                    <div key={i} style={{ fontSize: 12, lineHeight: 1.7 }}><Typography.Text type="secondary">· <TypeText text={r} /></Typography.Text></div>
                  ))}
                  <div style={{ marginTop: 6 }}>
                    {diag.data.actions.map((a, i) => (
                      <div key={i} style={{ lineHeight: 1.8 }}>{i + 1}. <TypeText text={a} /></div>
                    ))}
                  </div>
                  <Space size={8} style={{ marginTop: 8 }}>
                    <Button size="small" icon={<CopyOutlined />} onClick={copyDiag}>复制</Button>
                    <Button size="small" type="text" icon={<RobotOutlined />} onClick={genDiagnosis}>重新生成</Button>
                    <Button size="small" type="text" onClick={() => setDiag({ loading: false, data: null, err: "" })}>收起</Button>
                  </Space>
                </div>
              ) : (
                <>
                  <Tooltip title="结合该岗位的漏斗、各阶段停留与画像，分析「为什么招人慢」并给改进建议">
                    <Button className="ai-btn" size="small" icon={<RobotOutlined />} onClick={genDiagnosis}>AI 诊断</Button>
                  </Tooltip>
                  {diag.err && (
                    <div
                      style={{
                        marginTop: 8, fontSize: 12, lineHeight: 1.7, borderRadius: 8, padding: "8px 12px",
                        color: "#ad6800", background: "#fffbe6", border: "1px solid #ffe58f",
                      }}
                    >
                      AI 暂不可用（{diag.err}）。当前共 {detail.candidates.length} 名候选人：
                      {PIPELINE_STAGES.map((s) => `${s.label} ${detail.stage_counts[s.key] || 0}`).join("、")}
                      ，可据此先自行判断。
                    </div>
                  )}
                </>
              )}
            </div>

            {detail.candidates.length === 0 ? (
              <Empty description={"该岗位还没有候选人"} image={Empty.PRESENTED_IMAGE_SIMPLE} />
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
                  { title: "职位", dataIndex: "current_title", width: 140, render: (v: string) => v || "-" },
                  { title: "公司", dataIndex: "current_company", width: 160, render: (v: string) => v || "-" },
                  {
                    title: "年限", dataIndex: "years_experience", width: 70,
                    render: (v: number | null) => (v != null ? `${v}年` : "-"),
                  },
                  { title: "学历", dataIndex: "education", width: 90, render: (v: string) => v || "-" },
                  { title: "城市", dataIndex: "city", width: 80, render: (v: string) => v || "-" },
                  { title: "手机号", dataIndex: "phone", width: 130, render: (v: string) => v || "-" },
                ]}
              />
            )}
          </>
        ) : null}
      </Modal>
    </>
  );

  return (
    <div className="page-fill profiles-page">
      {jobsPane}
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
