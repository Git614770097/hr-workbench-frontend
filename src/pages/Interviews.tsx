import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import {
  Card, Table, Input, Select, Button, Space, Tag, Modal, Form, message,
  DatePicker, InputNumber, Alert, Typography, Popconfirm, Empty, Rate, Tooltip, Tabs,
  Dropdown,
} from "antd";
import {
  SearchOutlined, ReloadOutlined, PlusOutlined, VideoCameraOutlined,
  EnvironmentOutlined, PhoneOutlined, CalendarOutlined, ClockCircleOutlined,
  FieldTimeOutlined, CheckCircleOutlined, InfoCircleOutlined, UserOutlined,
  RobotOutlined, CloseCircleOutlined, VideoCameraAddOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api";
import type { Interview } from "../types";
import {
  INTERVIEW_ROUND_LABELS, INTERVIEW_MODE_LABELS,
  INTERVIEW_STATUS_LABELS, INTERVIEW_RESULT_LABELS, STAGE_META,
} from "../types";
import AnimatedNumber from "../components/AnimatedNumber";
import AiResultCard from "../components/AiResultCard";
import { useDismissible } from "../hooks/useDismissible";
import { useIdentityProfile } from "../useIdentity";
import { termFor } from "../identityProfiles";

/** AI 面试问题清单（面试前准备）：问题 + 考察点，可整单复制 */
function InterviewQuestionsPanel({ talentId, jobId }: { talentId?: string; jobId?: string | null }) {
  if (!talentId) {
    return <Empty description="请先在「基础信息」Tab 选择候选人" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  return (
    <AiResultCard
      title="AI 面试问题清单"
      hint="点「生成」，AI 会结合该候选人的简历/档案与目标岗位要求，给出针对性问题与考察点。"
      fetchOnMount={async () => {
        const r = await api.aiInterviewQuestionsGet(talentId);
        return (r?.data ? { ...r.data, _persisted: true } : null) as Record<string, unknown> | null;
      }}
      onGenerate={async () =>
        (await api.aiInterviewQuestions(talentId, jobId ?? null)) as unknown as Record<string, unknown>
      }
      toText={(d) => {
        const qs = (d as { questions?: { q: string; focus: string }[] }).questions || [];
        return qs.map((x, i) => `${i + 1}. ${x.q}\n   考察：${x.focus}`).join("\n");
      }}
      render={(d) => {
        const qs = (d as { questions?: { q: string; focus: string }[] }).questions || [];
        return (
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13 }}>
            {qs.map((x, i) => (
              <li key={i} style={{ marginBottom: 8 }}>
                <div>{x.q}</div>
                {x.focus ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>考察：{x.focus}</Typography.Text>
                ) : null}
              </li>
            ))}
          </ol>
        );
      }}
    />
  );
}

/** AI 综合评估（多轮）：汇总各轮面试 + 部门意见，给出录用建议 */
function CandidateSummaryPanel({ talentId, jobId }: { talentId?: string; jobId?: string | null }) {
  if (!talentId) {
    return <Empty description="请先在「基础信息」Tab 选择候选人" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  return (
    <AiResultCard
      title="AI 综合评估（汇总多轮）"
      hint="点「生成」，AI 会汇总该候选人各轮面试评价与用人部门意见，给出结构化结论与录用建议。需至少已填写一轮评价。"
      fetchOnMount={async () => {
        const r = await api.aiCandidateSummaryGet(talentId);
        return (r?.data ? { ...r.data, _persisted: true } : null) as Record<string, unknown> | null;
      }}
      onGenerate={async () =>
        (await api.aiCandidateSummary(talentId, jobId ?? null)) as unknown as Record<string, unknown>
      }
      toText={(d) => {
        const r = d as import("../types").AiCandidateSummary;
        const lines = [r.summary];
        if (r.strengths?.length) lines.push(`优势：\n${r.strengths.map((x) => `· ${x}`).join("\n")}`);
        if (r.risks?.length) lines.push(`风险：\n${r.risks.map((x) => `· ${x}`).join("\n")}`);
        if (r.recommendation) lines.push(`推荐级别：${r.recommendation}`);
        if (r.suggested_result) lines.push(`建议结论：${r.suggested_result}`);
        return lines.filter(Boolean).join("\n\n");
      }}
      render={(d) => {
        const r = d as import("../types").AiCandidateSummary;
        const recColor =
          r.recommendation === "强烈推荐" ? "green" : r.recommendation === "推荐" ? "blue" : r.recommendation === "可考虑" ? "orange" : "red";
        return (
          <div style={{ fontSize: 13 }}>
            <div style={{ marginBottom: 8 }}>{r.summary}</div>
            <Space size={6} wrap style={{ marginBottom: 8 }}>
              {r.recommendation ? <Tag color={recColor}>{r.recommendation}</Tag> : null}
              {r.suggested_result ? (
                <Tag>{({ pass: "建议通过", fail: "建议不通过", pending: "建议待定" } as Record<string, string>)[r.suggested_result] || r.suggested_result}</Tag>
              ) : null}
              {r.rounds ? <Tag>{`基于 ${r.rounds} 轮评价`}</Tag> : null}
            </Space>
            {r.strengths?.length ? (
              <div style={{ marginBottom: 6 }}>
                <Typography.Text strong style={{ fontSize: 12, color: "#389e0d" }}>优势</Typography.Text>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18, color: "#4b5563" }}>
                  {r.strengths.map((x, i) => <li key={i}>{x}</li>)}
                </ul>
              </div>
            ) : null}
            {r.risks?.length ? (
              <div>
                <Typography.Text strong style={{ fontSize: 12, color: "#d4380d" }}>风险</Typography.Text>
                <ul style={{ margin: "4px 0 0", paddingLeft: 18, color: "#4b5563" }}>
                  {r.risks.map((x, i) => <li key={i}>{x}</li>)}
                </ul>
              </div>
            ) : null}
          </div>
        );
      }}
    />
  );
}

/** 面试安排 + 面试评价（挂在招聘看板的面试阶段上） */
export default function Interviews() {
  const profile = useIdentityProfile();
  const [items, setItems] = useState<Interview[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creatingMeeting, setCreatingMeeting] = useState(false);

  // 搜索：草稿态 + 生效态分离（点「查询」才生效，与全站列表页一致）
  const [draftKeyword, setDraftKeyword] = useState("");
  const [keyword, setKeyword] = useState("");
  const [draftStatus, setDraftStatus] = useState<string | undefined>();
  const [status, setStatus] = useState<string | undefined>();
  const [draftRound, setDraftRound] = useState<string | undefined>();
  const [round, setRound] = useState<string | undefined>();
  const [draftMode, setDraftMode] = useState<string | undefined>();
  const [modeFilter, setModeFilter] = useState<string | undefined>();

  // 新建 / 编辑 / 评价 共用一个弹窗
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Interview | null>(null);
  const [form] = Form.useForm();
  const formMode = Form.useWatch("mode", form);

  // 候选人 / 应聘职位下拉：面试必须挂到某条「投递」才能进看板，
  // 所以候选人用可搜索下拉选，职位从其投递记录里挑（不能让用户手填 ID 或名称）。
  const [talentOptions, setTalentOptions] = useState<{ label: string; value: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [linkOptions, setLinkOptions] = useState<{ label: string; value: string; jobId: string }[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(false);
  // AI 辅助面板需要「当前选中的候选人 + 岗位」；用 watch 保持响应式（切人即时刷新）。
  // 注意必须写在 linkOptions 声明之后（TS 块级作用域：先声明后使用）。
  const watchTalentId = Form.useWatch("talent_id", form) as string | undefined;
  const watchLinkId = Form.useWatch("talent_job_id", form) as string | undefined;
  const watchJobId =
    editing?.job_id ?? linkOptions.find((o) => o.value === watchLinkId)?.jobId ?? null;
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const intro = useDismissible("interviews.intro");

  const searchTalents = useCallback(async (q: string) => {
    setSearching(true);
    try {
      const r = await api.getTalents({ q, page: 1, limit: 20 });
      setTalentOptions(r.items.map((t) => ({ label: t.phone ? `${t.name}（${t.phone}）` : t.name, value: t.id })));
    } catch { /* 搜索失败不打断输入 */ } finally {
      setSearching(false);
    }
  }, []);

  const debouncedSearch = useCallback((q: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => searchTalents(q), 300);
  }, [searchTalents]);

  /** 载入某候选人的投递列表（talent_jobs）：面试挂在投递上，看板卡片才会显示「面试 日期」 */
  const loadLinks = useCallback(async (tid: string) => {
    setLoadingLinks(true);
    try {
      const d = await api.getTalent(tid);
      setLinkOptions(d.pipeline.map((p) => ({
        label: `${p.job_title}（${STAGE_META[p.stage]?.label || p.stage}）`,
        value: p.id,
        jobId: p.job_id,
      })));
    } catch {
      setLinkOptions([]);
    } finally {
      setLoadingLinks(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getInterviews({
        status: status || undefined,
      });
      setItems(r.items);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  const handleSearch = () => {
    setKeyword(draftKeyword.trim());
    setStatus(draftStatus);
    setRound(draftRound);
    setModeFilter(draftMode);
  };
  const handleReset = () => {
    setDraftKeyword(""); setKeyword("");
    setDraftStatus(undefined); setStatus(undefined);
    setDraftRound(undefined); setRound(undefined);
    setDraftMode(undefined); setModeFilter(undefined);
  };

  // 前端细筛：状态由后端过滤，关键字 / 轮次 / 方式在前端筛（后端未提供这两个参数）
  const filtered = useMemo(() => {
    const kw = keyword.toLowerCase();
    return items.filter((r) => {
      if (round && r.round !== round) return false;
      if (modeFilter && r.mode !== modeFilter) return false;
      if (!kw) return true;
      return (
        (r.talent_name || "").toLowerCase().includes(kw) ||
        (r.job_title || "").toLowerCase().includes(kw) ||
        (r.interviewer || "").toLowerCase().includes(kw)
      );
    });
  }, [items, keyword, round, modeFilter]);

  // 统计：总数 / 今天 / 待面试 / 评价通过
  const stats = useMemo(() => ({
    total: items.length,
    today: items.filter((r) => r.is_today).length,
    waiting: items.filter((r) => r.status === "scheduled").length,
    passed: items.filter((r) => r.result === "pass" && r.dept_result === "pass").length,
  }), [items]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setLinkOptions([]);
    searchTalents("");
    form.setFieldsValue({
      round: "interview1",
      mode: "online",
      duration: 60,
      status: "scheduled",
    } as any);
    setOpen(true);
  };

  // 一键创建飞书会议：按表单里的面试时长预约，链接自动回填「会议链接」。
  // 会议归属人是当前用户（飞书要求登记），所以必须先完成飞书绑定；失败原因
  // （未配置应用 / 未绑定 / 应用缺视频会议权限）由后端说清楚，这里原样提示。
  const createFeishuMeeting = async () => {
    const talentId = form.getFieldValue("talent_id") as string | undefined;
    const talentLabel = talentOptions.find((o) => o.value === talentId)?.label || "";
    const minutes = Number(form.getFieldValue("duration")) || 60;
    setCreatingMeeting(true);
    try {
      const r = await api.createFeishuMeeting({ topic: `面试：${talentLabel || "候选人"}`, minutes });
      form.setFieldValue("meeting_url", r.url);
      message.success(
        r.password ? `飞书会议已创建，链接已填入（入会密码 ${r.password}）` : "飞书会议已创建，链接已填入"
      );
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setCreatingMeeting(false);
    }
  };

  const openEdit = (row: Interview) => {
    setEditing(row);
    form.resetFields();
    // 先塞一条占位选项，避免下拉在投递列表加载完成前把 UUID 直接显示出来
    setLinkOptions(
      row.talent_job_id
        ? [{ label: row.job_title || "应聘职位", value: row.talent_job_id, jobId: row.job_id || "" }]
        : []
    );
    loadLinks(row.talent_id);
    form.setFieldsValue({
      talent_id: row.talent_id,
      talent_job_id: row.talent_job_id ?? undefined,
      round: row.round,
      mode: row.mode,
      scheduled_at: row.scheduled_at ? dayjs(row.scheduled_at) : null,
      duration: row.duration,
      location: row.location,
      meeting_url: row.meeting_url,
      interviewer: row.interviewer,
      status: row.status,
      result: row.result,
      score: row.score,
      evaluation: row.evaluation,
      dept_result: row.dept_result,
      dept_score: row.dept_score,
      dept_evaluation: row.dept_evaluation,
    } as any);
    setOpen(true);
  };

  const handleSave = async () => {
    let v: any;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    const payload = {
      ...v,
      // 岗位 ID 由所选投递派生，保证 interview.job_id 与 talent_jobs 一致（列表「应聘岗位」列要用）
      job_id: linkOptions.find((l) => l.value === v.talent_job_id)?.jobId ?? null,
      scheduled_at: v.scheduled_at ? dayjs(v.scheduled_at).format("YYYY-MM-DD HH:mm") : null,
    };
    setSaving(true);
    try {
      const r = editing
        ? await api.updateInterview(editing.id, payload)
        : await api.createInterview(payload);
      const stageLabel = r.advanced_to ? (STAGE_META[r.advanced_to]?.label || r.advanced_to) : null;
      message.success(
        (editing ? "面试安排已更新" : "面试安排已创建") +
        (stageLabel ? `，候选人已自动推进到「${stageLabel}」` : "")
      );
      setOpen(false);
      load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row: Interview) => {
    try {
      await api.deleteInterview(row.id);
      message.success("已删除");
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  // ---- 行内快捷操作（免开编辑弹窗）----
  // 快捷状态：待面试 → 已完成/未到/已取消，点状态标签直接改
  const quickStatus = async (row: Interview, next: "done" | "no_show" | "cancelled") => {
    try {
      await api.quickUpdateInterview(row.id, { status: next });
      message.success(
        `「${row.talent_name}」已标记为「${INTERVIEW_STATUS_LABELS[next]}」` +
        (next === "done" ? "，可点「编辑/评价」补录评价" : "")
      );
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  // 行内改期：点列表时间列弹小窗改时间/时长
  const [resched, setResched] = useState<{ row: Interview; date: dayjs.Dayjs | null; duration: number | null } | null>(null);
  const [reschedSaving, setReschedSaving] = useState(false);
  const saveResched = async () => {
    if (!resched) return;
    setReschedSaving(true);
    try {
      await api.quickUpdateInterview(resched.row.id, {
        scheduled_at: resched.date ? resched.date.format("YYYY-MM-DD HH:mm") : null,
        duration: resched.duration ?? undefined,
      });
      message.success(`「${resched.row.talent_name}」面试时间已更新`);
      setResched(null);
      load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setReschedSaving(false);
    }
  };

  // 结果 Tag 配色
  const resultColor = (res: string | null | undefined) =>
    res === "pass" ? "green" : res === "fail" ? "red" : res === "pending" ? "gold" : "default";
  const statusColor = (s: string) =>
    s === "done" ? "green" : s === "cancelled" ? "default" : s === "no_show" ? "orange" : "blue";

  // 时间展示：今天高亮 + 已过期标注；点击直接改期（免开编辑弹窗）
  const timeCell = (r: Interview) => {
    const openResched = () =>
      setResched({ row: r, date: r.scheduled_at ? dayjs(r.scheduled_at) : null, duration: r.duration ?? 60 });
    if (!r.scheduled_at) {
      return <a onClick={openResched} style={{ fontSize: 12 }}>未安排 · 点击安排</a>;
    }
    const timeTxt = String(r.scheduled_at).slice(11, 16);
    // 时长跟在时间后展示（此前该字段填了但无处可见）
    const durationTxt = r.duration ? (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}> · {r.duration}分钟</Typography.Text>
    ) : null;
    if (r.is_today) {
      return (
        <Space size={6}>
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>今天</Tag>
          <Tooltip title="点击改期">
            <a onClick={openResched}>{timeTxt}{durationTxt}</a>
          </Tooltip>
        </Space>
      );
    }
    return (
      <Space size={6}>
        <Tooltip title="点击改期">
          <a onClick={openResched}>{String(r.scheduled_at).slice(5, 10)} {timeTxt}{durationTxt}</a>
        </Tooltip>
        {r.is_overdue ? <Tag color="red" style={{ marginInlineEnd: 0 }}>已过期</Tag> : null}
      </Space>
    );
  };

  const columns = [
    {
      title: "候选人",
      key: "talent",
      width: 120,
      render: (_: unknown, r: Interview) => (
        <Link to={`/talents/${r.talent_id}`}>{r.talent_name}</Link>
      ),
    },
    {
      title: "应聘岗位",
      key: "job",
      width: 140,
      ellipsis: true,
      render: (_: unknown, r: Interview) =>
        r.job_title || <Typography.Text type="secondary">-</Typography.Text>,
    },
    {
      title: "轮次",
      dataIndex: "round_label",
      key: "round",
      width: 80,
      render: (v: string) => <Tag color="purple">{v}</Tag>,
    },
    {
      title: "面试时间",
      key: "time",
      width: 200,
      render: (_: unknown, r: Interview) => timeCell(r),
    },
    {
      title: "方式",
      key: "mode",
      width: 90,
      render: (_: unknown, r: Interview) => {
        const icon =
          r.mode === "online" ? <VideoCameraOutlined /> :
          r.mode === "onsite" ? <EnvironmentOutlined /> : <PhoneOutlined />;
        return <Space size={6}>{icon}<span>{r.mode_label}</span></Space>;
      },
    },
    {
      title: "地点 / 会议链接",
      key: "place",
      width: 140,
      ellipsis: true,
      render: (_: unknown, r: Interview) => {
        if (r.mode === "online") {
          if (!r.meeting_url) return <Typography.Text type="secondary">未填链接</Typography.Text>;
          // 链接可能很长，列表里只展示「加入会议」，完整地址放 Tooltip，避免撑破行
          return (
            <Tooltip title={r.meeting_url}>
              <a href={r.meeting_url} target="_blank" rel="noreferrer">
                <VideoCameraOutlined /> 加入会议
              </a>
            </Tooltip>
          );
        }
        if (r.mode === "phone") return <Typography.Text type="secondary">电话联系</Typography.Text>;
        return r.location
          ? <Tooltip title={r.location}><span>{r.location}</span></Tooltip>
          : <Typography.Text type="secondary">未填地点</Typography.Text>;
      },
    },
    {
      title: "面试官",
      dataIndex: "interviewer",
      key: "interviewer",
      width: 110,
      ellipsis: true,
      render: (v: string | null) => v || <Typography.Text type="secondary">-</Typography.Text>,
    },
    {
      title: "状态",
      key: "status",
      width: 90,
      render: (_: unknown, r: Interview) => {
        // 待面试：点标签直接快捷改状态（完成/未到/取消），免进编辑弹窗
        if (r.status === "scheduled") {
          return (
            <Dropdown
              trigger={["click"]}
              menu={{
                items: [
                  { key: "done", label: "标记为已完成", icon: <CheckCircleOutlined /> },
                  { key: "no_show", label: "标记为未到", icon: <ClockCircleOutlined /> },
                  { key: "cancelled", label: "标记为已取消", icon: <CloseCircleOutlined /> },
                ],
                onClick: ({ key }) => quickStatus(r, key as "done" | "no_show" | "cancelled"),
              }}
            >
              <Tag color={statusColor(r.status)} style={{ cursor: "pointer" }} title="点击快捷更新状态">
                {r.status_label}
              </Tag>
            </Dropdown>
          );
        }
        return <Tag color={statusColor(r.status)}>{r.status_label}</Tag>;
      },
    },
    {
      title: "评价",
      key: "result",
      width: 200,
      render: (_: unknown, r: Interview) => (
        <Space direction="vertical" size={4} style={{ lineHeight: 1.4 }}>
          <Space size={4} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>面试</Typography.Text>
            {r.result
              ? <Tag color={resultColor(r.result)} style={{ marginInlineEnd: 0 }}>{r.result_label}</Tag>
              : <Typography.Text type="secondary" style={{ fontSize: 12 }}>待评价</Typography.Text>}
            {r.score ? (
              <Typography.Text style={{ fontSize: 12, color: "#faad14", letterSpacing: 1 }}>
                {"★".repeat(r.score)}
              </Typography.Text>
            ) : null}
          </Space>
          <Space size={4} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>部门</Typography.Text>
            {r.dept_result
              ? <Tag color={resultColor(r.dept_result)} style={{ marginInlineEnd: 0 }}>{r.dept_result_label}</Tag>
              : <Typography.Text type="secondary" style={{ fontSize: 12 }}>待评价</Typography.Text>}
            {r.dept_score ? (
              <Typography.Text style={{ fontSize: 12, color: "#faad14", letterSpacing: 1 }}>
                {"★".repeat(r.dept_score)}
              </Typography.Text>
            ) : null}
          </Space>
        </Space>
      ),
    },
    {
      title: "操作",
      key: "action",
      width: 150,
      fixed: "right" as const,
      render: (_: unknown, r: Interview) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => openEdit(r)}>编辑/评价</Button>
          <Popconfirm
            title="删除这条面试安排？"
            description="删除后该候选人的面试记录将一并移除。"
            onConfirm={() => handleDelete(r)}
            okText="删除"
            cancelText="取消"
          >
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="page-fill profiles-page">
      {/* 统计区：面试概况（结构与合同/社保页一致） */}
      <div className="page-stats" style={{ marginBottom: 16 }}>
        <div className="stat">
          <span className="stat-icon is-neutral"><CalendarOutlined /></span>
          <span className="stat-body">
            <span className="stat-num is-neutral">
              <AnimatedNumber value={stats.total} format={(n) => Math.round(n).toLocaleString("zh-CN")} />
            </span>
            <span className="stat-label">面试总数</span>
          </span>
        </div>
        <div className="stat">
          <span className="stat-icon is-warn"><ClockCircleOutlined /></span>
          <span className="stat-body">
            <span className="stat-num is-warn">
              <AnimatedNumber value={stats.today} format={(n) => Math.round(n).toLocaleString("zh-CN")} />
            </span>
            <span className="stat-label">今天面试</span>
          </span>
        </div>
        <div className="stat">
          <span className="stat-icon is-neutral"><FieldTimeOutlined /></span>
          <span className="stat-body">
            <span className="stat-num is-neutral">
              <AnimatedNumber value={stats.waiting} format={(n) => Math.round(n).toLocaleString("zh-CN")} />
            </span>
            <span className="stat-label">待面试</span>
          </span>
        </div>
        <div className="stat">
          <span className="stat-icon is-good"><CheckCircleOutlined /></span>
          <span className="stat-body">
            <span className="stat-num is-good">
              <AnimatedNumber value={stats.passed} format={(n) => Math.round(n).toLocaleString("zh-CN")} />
            </span>
            <span className="stat-label">双评价通过</span>
          </span>
        </div>
      </div>

      {!intro.dismissed && (
        <Alert
          type="info"
          showIcon
          closable
          style={{ marginBottom: 16 }}
          message={termFor(profile, "面试安排与评价：线上面试填会议链接、线下面试填地点；面试结束后在「编辑/评价」里分别补录「面试评价」与「用人部门评价」（结果+评分+评语）。当面试评价与用人部门评价都填「通过」时，候选人会自动推进到下一阶段（初试→复试→Offer），无需再去拖看板卡片。")}
          onClose={intro.dismiss}
        />
      )}

      {/* 搜索区（约定：只放搜索字段，label 左 / 控件右，一行 4 个） */}
      <Card className="search-card" style={{ marginBottom: 16 }}>
        <div className="search-grid">
          <div className="search-field">
            <span className="search-label">关键词</span>
            <div className="search-control">
              <Input
                allowClear
                placeholder="搜索候选人、岗位或面试官"
                value={draftKeyword}
                onChange={(e) => setDraftKeyword(e.target.value)}
                onPressEnter={handleSearch}
              />
            </div>
          </div>
          <div className="search-field">
            <span className="search-label">轮次</span>
            <div className="search-control">
              <Select
                allowClear
                placeholder="全部轮次"
                value={draftRound}
                onChange={setDraftRound}
                options={Object.entries(INTERVIEW_ROUND_LABELS).map(([value, label]) => ({ value, label }))}
              />
            </div>
          </div>
          <div className="search-field">
            <span className="search-label">面试方式</span>
            <div className="search-control">
              <Select
                allowClear
                placeholder="全部方式"
                value={draftMode}
                onChange={setDraftMode}
                options={Object.entries(INTERVIEW_MODE_LABELS).map(([value, label]) => ({ value, label }))}
              />
            </div>
          </div>
          <div className="search-field">
            <span className="search-label">状态</span>
            <div className="search-control">
              <Select
                allowClear
                placeholder="全部状态"
                value={draftStatus}
                onChange={setDraftStatus}
                options={Object.entries(INTERVIEW_STATUS_LABELS).map(([value, label]) => ({ value, label }))}
              />
            </div>
          </div>
        </div>
      </Card>

      <Card className="list-card">
        {/* 工具行：左侧数据操作，右侧重置 / 查询（查询最右） */}
        <div className="toolbar">
          <Space>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              安排面试
            </Button>
          </Space>
          <Space>
            {intro.dismissed && (
              <Button icon={<InfoCircleOutlined />} onClick={intro.restore}>说明</Button>
            )}
            <Button icon={<ReloadOutlined />} onClick={handleReset}>重置</Button>
            <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>查询</Button>
          </Space>
        </div>

        <Table<Interview>
          className="profiles-table"
          rowKey="id"
          dataSource={filtered}
          loading={loading}
          columns={columns}
          scroll={{ x: 1300 }}
          locale={{
            emptyText: (
              <div style={{ padding: "40px 0", textAlign: "center" }}>
                <Empty
                  description={termFor(profile, "还没有面试安排")}
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  style={{ marginBottom: 16 }}
                />
                <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>安排面试</Button>
                <div style={{ marginTop: 12 }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {termFor(profile, "面试需挂在一条投递上：请先在「招聘看板」把候选人推进到面试阶段，再回到这里安排")}
                  </Typography.Text>
                </div>
              </div>
            ),
          }}
          pagination={{ pageSize: 10, showSizeChanger: false, showTotal: (t) => `共 ${t} 条` }}
        />
      </Card>

      {/* 行内改期：点列表时间列直接弹小窗，免开完整编辑弹窗 */}
      <Modal
        title={`改期 · ${resched?.row.talent_name || ""}`}
        open={!!resched}
        onCancel={() => setResched(null)}
        onOk={saveResched}
        confirmLoading={reschedSaving}
        okText="保存"
        cancelText="取消"
        width={380}
        destroyOnClose
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>面试时间</Typography.Text>
            <DatePicker
              showTime={{ format: "HH:mm", minuteStep: 15 }}
              format="YYYY-MM-DD HH:mm"
              style={{ width: "100%" }}
              placeholder="选择面试时间"
              value={resched?.date ?? null}
              onChange={(d) => setResched((s) => (s ? { ...s, date: d } : s))}
            />
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 4 }}>时长（分钟）</Typography.Text>
            <InputNumber
              min={15}
              max={480}
              step={15}
              style={{ width: "100%" }}
              value={resched?.duration ?? 60}
              onChange={(v) => setResched((s) => (s ? { ...s, duration: v } : s))}
            />
          </div>
        </div>
      </Modal>

      {/* 安排 / 编辑面试：基础信息 / 面试评价 / 用人部门评价 三个 Tab */}
      <Modal
        title={editing ? "编辑面试 / 填写评价" : "安排面试"}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={handleSave}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        destroyOnClose
        width={720}
      >
        <Form form={form} layout="horizontal" className="form-horizontal" labelCol={{ flex: "88px" }} preserve={false}>
          <Tabs
            defaultActiveKey="basic"
            items={[
              {
                key: "basic",
                label: "基础信息",
                children: (
                  <>
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 16 }}
                      message="线上面试请填会议链接，线下面试请填地点；面试结束后可在「面试评价」「用人部门评价」两个 Tab 里补录结果与评语。"
                    />
                    <div className="form-grid">
                      <Form.Item name="talent_id" label="候选人" rules={[{ required: true, message: "请选择候选人" }]}>
                        <Select
                          showSearch
                          allowClear
                          disabled={!!editing}
                          placeholder="输入姓名或手机号搜索候选人"
                          filterOption={false}
                          loading={searching}
                          options={talentOptions}
                          onSearch={debouncedSearch}
                          suffixIcon={<UserOutlined />}
                          onChange={(v: string | undefined) => {
                            form.setFieldValue("talent_job_id", undefined);
                            setLinkOptions([]);
                            if (v) loadLinks(v);
                          }}
                        />
                      </Form.Item>
                      <Form.Item
                        name="talent_job_id"
                        label="应聘职位"
                        rules={[{ required: true, message: "请选择该候选人正在推进的职位" }]}
                      >
                        <Select
                          placeholder="先选候选人，再选其投递的职位"
                          loading={loadingLinks}
                          options={linkOptions}
                          notFoundContent={loadingLinks ? "加载中…" : "该候选人暂无投递，请先把他加入「招聘看板」"}
                        />
                      </Form.Item>
                    </div>
                    <div className="form-grid">
                      <Form.Item name="round" label="轮次" rules={[{ required: true }]}>
                        <Select options={Object.entries(INTERVIEW_ROUND_LABELS).map(([value, label]) => ({ value, label }))} />
                      </Form.Item>
                      <Form.Item name="mode" label="面试方式" rules={[{ required: true }]}>
                        <Select options={Object.entries(INTERVIEW_MODE_LABELS).map(([value, label]) => ({ value, label }))} />
                      </Form.Item>
                    </div>
                    <div className="form-grid">
                      <Form.Item name="scheduled_at" label="面试时间" rules={[{ required: true, message: "请选择面试时间" }]}>
                        <DatePicker
                          showTime={{ format: "HH:mm", minuteStep: 15 }}
                          format="YYYY-MM-DD HH:mm"
                          style={{ width: "100%" }}
                          placeholder="选择面试时间"
                        />
                      </Form.Item>
                      <Form.Item name="duration" label="时长(分钟)">
                        <InputNumber min={15} max={480} step={15} style={{ width: "100%" }} />
                      </Form.Item>
                    </div>
                    {formMode === "onsite" ? (
                      <Form.Item name="location" label="面试地点" rules={[{ required: true, message: "请填写面试地点" }]}>
                        <Input placeholder="如：公司 3 楼会议室 / 客户现场" />
                      </Form.Item>
                    ) : formMode === "online" ? (
                      <Form.Item
                        name="meeting_url"
                        label="会议链接"
                        rules={[{ required: true, message: "请填写会议链接" }]}
                        extra="也可以点右侧「生成飞书会议」自动创建：链接回填后直接保存即可，候选人点链接就能入会（无需安装飞书）"
                      >
                        <Input
                          placeholder="如：飞书会议 / 腾讯会议链接"
                          addonAfter={
                            <Button
                              type="link"
                              size="small"
                              style={{ paddingInline: 0 }}
                              icon={<VideoCameraAddOutlined />}
                              loading={creatingMeeting}
                              onClick={createFeishuMeeting}
                            >
                              生成飞书会议
                            </Button>
                          }
                        />
                      </Form.Item>
                    ) : null}
                    <div className="form-grid">
                      <Form.Item name="interviewer" label="面试官">
                        <Input placeholder="多人用顿号分隔，如：张三、李四" />
                      </Form.Item>
                      <Form.Item name="status" label="状态" rules={[{ required: true }]}>
                        <Select options={Object.entries(INTERVIEW_STATUS_LABELS).map(([value, label]) => ({ value, label }))} />
                      </Form.Item>
                    </div>
                  </>
                ),
              },
              {
                key: "eval",
                label: "面试评价",
                forceRender: true,
                children: (
                  <>
                    {/* AI 总结本轮评价：复用 interviews/:id/ai-summary。
                        仅编辑已保存的面试时可用（新面试还没有 id，也没内容可总结）。 */}
                    {editing && (
                      <div style={{ marginBottom: 16 }}>
                        <AiResultCard
                          title="AI 总结本轮评价"
                          hint="填完评分与评语后点「生成」，AI 会归纳成结构化总结，可一键追加到评语末尾。"
                          onGenerate={async () =>
                            (await api.aiInterviewSummary(editing.id)) as unknown as Record<string, unknown>
                          }
                          toText={(d) => {
                            const r = d as {
                              summary: string; strengths: string[]; risks: string[];
                              recommendation: string; suggested_result: string;
                            };
                            const lines = [r.summary];
                            if (r.strengths?.length) lines.push(`优势：\n${r.strengths.map((x) => `· ${x}`).join("\n")}`);
                            if (r.risks?.length) lines.push(`风险：\n${r.risks.map((x) => `· ${x}`).join("\n")}`);
                            if (r.recommendation) lines.push(`推荐级别：${r.recommendation}`);
                            return lines.filter(Boolean).join("\n\n");
                          }}
                          render={(d) => {
                            const r = d as {
                              summary: string; strengths: string[]; risks: string[];
                              recommendation: string; suggested_result: string; _ai_fallback?: boolean;
                            };
                            if (r._ai_fallback) {
                              return <Alert type="warning" showIcon message="AI 暂时不可用，未生成总结" />;
                            }
                            const recColor =
                              r.recommendation === "强烈推荐" ? "green"
                                : r.recommendation === "推荐" ? "blue"
                                  : r.recommendation === "可考虑" ? "orange" : "red";
                            return (
                              <div style={{ fontSize: 13 }}>
                                <div style={{ marginBottom: 8 }}>{r.summary}</div>
                                <Space size={6} wrap style={{ marginBottom: 8 }}>
                                  {r.recommendation ? <Tag color={recColor}>{r.recommendation}</Tag> : null}
                                  {r.suggested_result ? (
                                    <Tag>{({ pass: "建议通过", fail: "建议不通过", pending: "建议待定" } as Record<string, string>)[r.suggested_result] || r.suggested_result}</Tag>
                                  ) : null}
                                  <Button
                                    size="small"
                                    onClick={() => {
                                      const text = [
                                        r.summary,
                                        r.strengths?.length ? `优势：${r.strengths.join("；")}` : "",
                                        r.risks?.length ? `风险：${r.risks.join("；")}` : "",
                                      ].filter(Boolean).join("\n");
                                      const prev = (form.getFieldValue("evaluation") as string) || "";
                                      const next = prev ? `${prev}\n\n${text}` : text;
                                      form.setFieldValue("evaluation", next);
                                      message.success("已追加到评语末尾（保存后生效）");
                                    }}
                                  >
                                    追加到评语
                                  </Button>
                                </Space>
                                {r.strengths?.length ? (
                                  <div style={{ marginBottom: 6 }}>
                                    <Typography.Text strong style={{ fontSize: 12, color: "#389e0d" }}>优势</Typography.Text>
                                    <ul style={{ margin: "4px 0 0", paddingLeft: 18, color: "#4b5563" }}>
                                      {r.strengths.map((x, i) => <li key={i}>{x}</li>)}
                                    </ul>
                                  </div>
                                ) : null}
                                {r.risks?.length ? (
                                  <div>
                                    <Typography.Text strong style={{ fontSize: 12, color: "#d4380d" }}>风险</Typography.Text>
                                    <ul style={{ margin: "4px 0 0", paddingLeft: 18, color: "#4b5563" }}>
                                      {r.risks.map((x, i) => <li key={i}>{x}</li>)}
                                    </ul>
                                  </div>
                                ) : null}
                              </div>
                            );
                          }}
                        />
                      </div>
                    )}
                    <Form.Item name="result" label="面试结果">
                      <Select
                        allowClear
                        placeholder="待定"
                        options={Object.entries(INTERVIEW_RESULT_LABELS).map(([value, label]) => ({ value, label }))}
                      />
                    </Form.Item>
                    <Form.Item name="score" label="综合评分">
                      <Rate allowClear />
                    </Form.Item>
                    <Form.Item name="evaluation" label="评价评语">
                      <Input.TextArea rows={4} placeholder="记录面试表现、亮点与风险点" />
                    </Form.Item>
                  </>
                ),
              },
              {
                key: "dept",
                label: "用人部门评价",
                forceRender: true,
                children: (
                  <>
                    <Form.Item name="dept_result" label="部门结论">
                      <Select
                        allowClear
                        placeholder="待定"
                        options={Object.entries(INTERVIEW_RESULT_LABELS).map(([value, label]) => ({ value, label }))}
                      />
                    </Form.Item>
                    <Form.Item name="dept_score" label="部门评分">
                      <Rate allowClear />
                    </Form.Item>
                    <Form.Item name="dept_evaluation" label="部门评语">
                      <Input.TextArea rows={4} placeholder="用人部门对候选人胜任度、团队匹配度的意见" />
                    </Form.Item>
                  </>
                ),
              },
              {
                key: "ai",
                label: (
                  <span>
                    <RobotOutlined style={{ marginInlineEnd: 6 }} />
                    AI 辅助
                  </span>
                ),
                children: (
                  <Space direction="vertical" size={12} style={{ width: "100%" }}>
                    <InterviewQuestionsPanel key={watchTalentId} talentId={watchTalentId} jobId={watchJobId} />
                    <CandidateSummaryPanel key={watchTalentId} talentId={watchTalentId} jobId={watchJobId} />
                  </Space>
                ),
              },
            ]}
          />
        </Form>
      </Modal>
    </div>
  );
}
