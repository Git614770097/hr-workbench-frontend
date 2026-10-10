import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import {
  Card, Table, Input, Select, Button, Space, Tag, Modal, Form, message,
  DatePicker, InputNumber, Alert, Typography, Popconfirm, Empty, Rate, Tooltip, Tabs,
} from "antd";
import {
  SearchOutlined, ReloadOutlined, PlusOutlined, VideoCameraOutlined,
  EnvironmentOutlined, PhoneOutlined, CalendarOutlined, ClockCircleOutlined,
  FieldTimeOutlined, CheckCircleOutlined, InfoCircleOutlined, UserOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api";
import type { Interview } from "../types";
import {
  INTERVIEW_ROUND_LABELS, INTERVIEW_MODE_LABELS,
  INTERVIEW_STATUS_LABELS, INTERVIEW_RESULT_LABELS, STAGE_META,
} from "../types";
import AnimatedNumber from "../components/AnimatedNumber";
import { useDismissible } from "../hooks/useDismissible";
import { useIdentityProfile } from "../useIdentity";
import { termFor } from "../identityProfiles";

/** 面试安排 + 面试评价（挂在招聘看板的面试阶段上） */
export default function Interviews() {
  const profile = useIdentityProfile();
  const [items, setItems] = useState<Interview[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

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

  // 结果 Tag 配色
  const resultColor = (res: string | null | undefined) =>
    res === "pass" ? "green" : res === "fail" ? "red" : res === "pending" ? "gold" : "default";
  const statusColor = (s: string) =>
    s === "done" ? "green" : s === "cancelled" ? "default" : s === "no_show" ? "orange" : "blue";

  // 时间展示：今天高亮 + 已过期标注
  const timeCell = (r: Interview) => {
    if (!r.scheduled_at) return <Typography.Text type="secondary">未安排</Typography.Text>;
    const timeTxt = String(r.scheduled_at).slice(11, 16);
    if (r.is_today) {
      return (
        <Space size={6}>
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>今天</Tag>
          <span>{timeTxt}</span>
        </Space>
      );
    }
    return (
      <Space size={6}>
        <span>{String(r.scheduled_at).slice(5, 10)} {timeTxt}</span>
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
        r.job_title || <Typography.Text type="secondary">—</Typography.Text>,
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
      width: 170,
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
      render: (v: string | null) => v || <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: "状态",
      key: "status",
      width: 90,
      render: (_: unknown, r: Interview) => <Tag color={statusColor(r.status)}>{r.status_label}</Tag>,
    },
    {
      title: "评价",
      key: "result",
      width: 180,
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
      width: 120,
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
          scroll={{ x: 1240 }}
          locale={{
            emptyText: (
              <div style={{ padding: "40px 0", textAlign: "center" }}>
                <Empty
                  description={termFor(profile, "还没有面试安排")}
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  style={{ marginBottom: 16 }}
                />
                <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>安排面试</Button>
                <div style={{ marginTop: 12, color: "#999", fontSize: 12 }}>
                  {termFor(profile, "面试需挂在一条投递上：请先在「招聘看板」把候选人推进到面试阶段，再回到这里安排")}
                </div>
              </div>
            ),
          }}
          pagination={{ pageSize: 10, showSizeChanger: false, showTotal: (t) => `共 ${t} 条` }}
        />
      </Card>

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
                      <Form.Item name="meeting_url" label="会议链接" rules={[{ required: true, message: "请填写会议链接" }]}>
                        <Input placeholder="如：飞书会议 / 腾讯会议链接" />
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
            ]}
          />
        </Form>
      </Modal>
    </div>
  );
}
