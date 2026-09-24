import { useState, useEffect, useMemo, useRef } from "react";
import {
  Card, Table, Button, Space, Tag, Modal, Form, Input, InputNumber, Select,
  Popconfirm, message, Typography, Empty, Tooltip, Alert,
} from "antd";
import type { InputRef } from "antd";
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ThunderboltOutlined,
  SearchOutlined, ReloadOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { EDUCATION_OPTIONS } from "../types";
import type { MatchProfile } from "../types";

/** 画像整体薪资区间原文（如「20-35K·13薪」）→ 统一展示 */
function profileSalaryRange(p: MatchProfile): string {
  return p.salary_range || "";
}

// 搜索条件（draft = 编辑中，applied = 已生效）
// 「画像名称」与「目标职位」本是同一个东西，已合并为「目标职位」，不再设两个筛选项
interface Filters { job_title: string; city: string; }
const EMPTY_FILTERS: Filters = { job_title: "", city: "" };

/** 画像里由 AI 提炼 / 人工核对的结构化字段（弹窗内「画像字段」区）。
 *  岗位与 JD 之外的画像内容都存这里，AI 生成后可直接核对修改，保存时一并提交。 */
interface ProfileFields {
  city: string;
  education: string;
  min_years: number | null;
  max_years: number | null;
  salary_range: string;
  industry: string;
  must_skills: string[];
  nice_skills: string[];
  requirements: string;
}

const EMPTY_FIELDS: ProfileFields = {
  city: "", education: "", min_years: null, max_years: null,
  salary_range: "", industry: "", must_skills: [], nice_skills: [], requirements: "",
};

/** 画像字段里「有值」的项数，用于提示「AI 已提炼 N 项」 */
function filledCount(f: ProfileFields): number {
  let n = 0;
  if (f.city) n++;
  if (f.education) n++;
  if (f.min_years != null) n++;
  if (f.max_years != null) n++;
  if (f.salary_range) n++;
  if (f.industry) n++;
  if (f.must_skills.length) n++;
  if (f.nice_skills.length) n++;
  if (f.requirements) n++;
  return n;
}

/** 与后端 MatchProfile 互转 */
function fieldsFromProfile(p: MatchProfile): ProfileFields {
  return {
    city: p.city || "",
    education: p.education || "",
    min_years: p.min_years ?? null,
    max_years: p.max_years ?? null,
    salary_range: p.salary_range || "",
    industry: p.industry || "",
    must_skills: p.must_skills || [],
    nice_skills: p.nice_skills || [],
    requirements: p.requirements || "",
  };
}

/** 列表页：管理「职位画像」——每个画像 = 目标职位 + 招聘需求 + AI 提炼的整体要求字段 */
export default function Profiles() {
  const navigate = useNavigate();
  const [list, setList] = useState<MatchProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<MatchProfile | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [jd, setJd] = useState("");
  const [genJd, setGenJd] = useState(false);
  const [generating, setGenerating] = useState(false);
  // 目标职位的受控值：不依赖 form.getFieldValue 取「AI 生成 JD」的入参
  const [jobTitleState, setJobTitleState] = useState("");
  // 「AI 生成 JD」的常驻状态提示（不依赖 3 秒即消失的 message，弹窗里一定能看到）
  const [jdHint, setJdHint] = useState<{ type: "loading" | "success" | "error" | "warning"; text: string } | null>(null);
  const inputRef = useRef<InputRef>(null);
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  // 画像字段区：AI 生成画像后在此展示可编辑的结构化字段
  const [fields, setFields] = useState<ProfileFields>(EMPTY_FIELDS);
  const [form] = Form.useForm();

  const load = async () => {
    setLoading(true);
    try {
      setList(await api.getMatchProfiles());
    } catch (err) {
      message.error((err as Error).message);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const setField = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const handleSearch = () => setApplied({ ...draft });
  const handleReset = () => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
  };

  // 画像数据量小，直接在前端按条件过滤（不入后端）
  const filtered = useMemo(() => {
    const kw = (s: string) => s.trim().toLowerCase();
    return list.filter((p) => {
      // 「目标职位」与旧的「画像名称」已合并，老数据可能只填过 name，这里一起匹配
      if (applied.job_title && !(p.job_title || p.name || "").toLowerCase().includes(kw(applied.job_title))) return false;
      if (applied.city && !(p.city || "").includes(applied.city.trim())) return false;
      return true;
    });
  }, [list, applied]);

  const setFieldOf = <K extends keyof ProfileFields>(key: K, value: ProfileFields[K]) =>
    setFields((f) => ({ ...f, [key]: value }));

  const openCreate = () => {
    setEditing(null);
    setJd("");
    setGenJd(false);
    setJobTitleState("");
    setJdHint(null);
    setFields(EMPTY_FIELDS);
    form.resetFields();
    setOpen(true);
  };

  const openEdit = (p: MatchProfile) => {
    setEditing(p);
    setJd(p.jd_raw || "");
    setGenJd(false);
    setJobTitleState(p.job_title || p.name || "");
    setJdHint(null);
    setFields(fieldsFromProfile(p));
    form.resetFields();
    form.setFieldsValue({ job_title: p.job_title || p.name });
    setOpen(true);
  };

  // 第一步：填了职位 → AI 起草一份完整 JD（可人工修改）
  // ⚠️ 职位取值优先用受控 state（jobTitleState），form.getFieldValue 只作兜底：
  //    嵌套 noStyle Form.Item 在某些 antd/React 组合下取值不稳定，
  //    一旦取到空值就会静默 return，表现为「点了按钮没反应」。
  const handleGenJd = async () => {
    const fromForm = (form.getFieldValue("job_title") as string) || "";
    const jobTitle = (jobTitleState || fromForm).trim();
    if (!jobTitle) {
      setJdHint({ type: "warning", text: "请先填写目标职位，再点「AI 生成 JD」" });
      message.warning("请先填写目标职位");
      inputRef.current?.focus();
      return;
    }
    setGenJd(true);
    setJdHint({ type: "loading", text: `正在为「${jobTitle}」起草招聘 JD（约 5 秒）…` });
    try {
      const r = await api.generateJd(jobTitle);
      const text = (r.jd || "").trim();
      if (!text) {
        setJdHint({ type: "error", text: "AI 返回了空内容，请重试" });
        message.error("AI 返回了空内容，请重试");
        return;
      }
      setJd(text);
      setJdHint({ type: "success", text: `JD 已生成（${text.length} 字），可直接用或修改；再点「AI 生成画像」提炼下方字段` });
      message.success(`JD 已生成（${text.length} 字）`);
    } catch (err) {
      const msg = (err as Error).message;
      setJdHint({ type: "error", text: `生成失败：${msg}` });
      message.error(msg);
    } finally {
      setGenJd(false);
    }
  };

  // 第二步：JD → 画像字段（提炼结果显示在 JD 下方的「画像字段」区，可核对修改后再保存）
  const handleGenerate = async () => {
    if (jd.trim().length < 10) {
      message.warning("请先填写招聘需求（可点上方「AI 生成 JD」自动起草）");
      return;
    }
    setGenerating(true);
    try {
      const p = await api.generateMatchProfile(jd);
      const nextJob = (p.job_title || jobTitleState).trim();
      if (nextJob && !jobTitleState) {
        setJobTitleState(nextJob);
        form.setFieldsValue({ job_title: nextJob });
      }
      const next = fieldsFromProfile(p);
      setFields(next);
      const n = filledCount(next);
      message.success(
        n > 0
          ? `画像已生成，下方提炼出 ${n} 项字段（技能 ${next.must_skills.length} 个 / 加分 ${next.nice_skills.length} 个），请核对后保存`
          : "AI 未能从这段招聘需求里提炼出字段，请检查内容或手动填写"
      );
    } catch (err) {
      message.error((err as Error).message);
    }
    setGenerating(false);
  };

  const handleSave = async () => {
    const jobTitle = ((jobTitleState || (form.getFieldValue("job_title") as string) || "") as string).trim();
    if (!jobTitle) {
      message.error("请填写目标职位");
      return;
    }
    setSaving(true);
    try {
      // 画像 = 「职位 + JD + 结构化字段」，字段全部取自画像字段区
      const payload: Partial<MatchProfile> = {
        name: jobTitle,
        job_title: jobTitle,
        jd_raw: jd.slice(0, 4000),
        city: fields.city,
        education: fields.education,
        min_years: fields.min_years,
        max_years: fields.max_years,
        salary_range: fields.salary_range,
        industry: fields.industry,
        must_skills: fields.must_skills,
        nice_skills: fields.nice_skills,
        requirements: fields.requirements,
      };
      if (editing?.id) {
        await api.updateMatchProfile(editing.id, payload);
        message.success("画像已更新");
      } else {
        await api.createMatchProfile(payload);
        message.success("画像已创建");
      }
      setOpen(false);
      await load();
    } catch (err) {
      message.error((err as Error).message);
    }
    setSaving(false);
  };

  const handleDelete = async (p: MatchProfile) => {
    if (!p.id) return;
    try {
      await api.deleteMatchProfile(p.id);
      message.success("画像已删除");
      await load();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const columns = [
    {
      title: "目标职位",
      dataIndex: "job_title",
      key: "job_title",
      width: 200,
      fixed: "left" as const,
      render: (v: string, r: MatchProfile) => (
        <a
          style={{ fontWeight: 600 }}
          onClick={() => navigate("/match", { state: { profileId: r.id } })}
        >
          {v || r.name || "未命名"}
        </a>
      ),
    },
    {
      title: "城市",
      key: "city",
      width: 130,
      render: (_: unknown, r: MatchProfile) => r.city || "—",
    },
    {
      title: "学历 / 年限",
      key: "edu_years",
      width: 160,
      render: (_: unknown, r: MatchProfile) => {
        const yrs =
          r.min_years == null && r.max_years == null
            ? "年限不限"
            : r.max_years == null
              ? `${r.min_years ?? 0} 年以上`
              : `${r.min_years ?? 0}~${r.max_years} 年`;
        return [r.education, yrs].filter(Boolean).join(" · ");
      },
    },
    {
      title: "必备技能",
      key: "skills",
      width: 260,
      render: (_: unknown, r: MatchProfile) => {
        const all = r.must_skills || [];
        if (all.length === 0) return "—";
        const shown = all.slice(0, 3);
        const rest = all.length - shown.length;
        return (
          <Space size={4} wrap>
            {shown.map((s) => <Tag key={s}>{s}</Tag>)}
            {rest > 0 && <Tooltip title={all.join("、")}><Tag>+{rest}</Tag></Tooltip>}
          </Space>
        );
      },
    },
    {
      title: "薪资范围",
      key: "salary",
      width: 140,
      render: (_: unknown, r: MatchProfile) =>
        profileSalaryRange(r) ? <span className="salary-num" style={{ color: "#c0392b", fontWeight: 600 }}>{profileSalaryRange(r)}</span> : <span style={{ color: "#c2c6cc" }}>—</span>,
    },
    { title: "更新时间", dataIndex: "updated_at", key: "updated_at", width: 160, render: (v: string) => v || "—" },
    {
      title: "操作",
      key: "actions",
      width: 200,
      fixed: "right" as const,
      render: (_: unknown, r: MatchProfile) => (
        <Space size={4}>
          <Button size="small" icon={<ThunderboltOutlined />} onClick={() => navigate("/match", { state: { profileId: r.id } })}>
            去匹配
          </Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(r)} />
          <Popconfirm title="删除这个画像？" okText="删除" cancelText="取消" onConfirm={() => handleDelete(r)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  // 搜索字段：label 左 + 控件右，一行 4 个
  const fieldStyle: React.CSSProperties = { width: "100%" };
  const searchDefs: { key: keyof Filters; label: string; node: React.ReactNode }[] = [
    { key: "job_title", label: "目标职位", node: <Input style={fieldStyle} placeholder="请输入目标职位" value={draft.job_title} onChange={(e) => setField("job_title", e.target.value)} onPressEnter={handleSearch} allowClear /> },
    { key: "city", label: "城市", node: <Input style={fieldStyle} placeholder="如：深圳" value={draft.city} onChange={(e) => setField("city", e.target.value)} onPressEnter={handleSearch} allowClear /> },
  ];

  return (
    <div className="profiles-page">
      {/* 搜索区域：只放搜索字段 */}
      <Card className="search-card" style={{ marginBottom: 16 }}>
        <div className="search-grid">
          {searchDefs.map((d) => (
            <div key={d.key} className="search-field">
              <span className="search-label">{d.label}</span>
              <div className="search-control">{d.node}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="list-card">
        {/* 布局约定：工具行左侧数据操作、右侧「重置 / 查询」 */}
        <div className="toolbar">
          <Space>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建画像</Button>
          </Space>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={handleReset}>重置</Button>
            <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>查询</Button>
          </Space>
        </div>
        <Table
          className="profiles-table"
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={filtered}
          columns={columns}
          scroll={{ x: 1220 }}
          locale={{ emptyText: <Empty description="还没有画像，点左上角「新建画像」填写目标职位" /> }}
          pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 个画像` }}
        />
      </Card>

      {/* 新建 / 编辑画像：「目标职位 + 招聘需求（JD） + AI 提炼的画像字段」 */}
      <Modal
        title={editing ? "编辑画像" : "新建画像"}
        open={open}
        onCancel={() => setOpen(false)}
        width={820}
        getContainer={() => document.body}
        zIndex={1050}
        styles={{ body: { maxHeight: "70vh", overflowY: "auto" } }}
        footer={
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              「AI 生成画像」会把招聘需求提炼成下方字段，核对修改后保存即可
            </Typography.Text>
            <Space>
              <Button onClick={() => setOpen(false)}>取消</Button>
              <Button type="primary" loading={saving} onClick={handleSave}>保存</Button>
            </Space>
          </div>
        }
      >
        <Form form={form} layout="horizontal" className="form-horizontal" labelCol={{ flex: "88px" }}>
          {/* 第一步：先填职位 → AI 起草 JD
              用受控 state 直连 Input：不再用 Form.Item name + noStyle 取值，
              避免嵌套 Field 取值不稳定导致「点了按钮没反应」。 */}
          <Form.Item label="目标职位" required style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <Input
                ref={inputRef}
                placeholder="如：前端开发工程师"
                value={jobTitleState}
                onChange={(e) => {
                  setJobTitleState(e.target.value);
                  form.setFieldsValue({ job_title: e.target.value });
                }}
                onPressEnter={handleGenJd}
                style={{ flex: 1, minWidth: 0 }}
              />
              <Button
                type="primary"
                ghost
                icon={<ThunderboltOutlined />}
                loading={genJd}
                onClick={handleGenJd}
                style={{ flexShrink: 0 }}
              >
                {genJd ? "生成中…" : "AI 生成 JD"}
              </Button>
            </div>
          </Form.Item>

          {/* 第二步：核对 / 修改 JD */}
          <Form.Item label="招聘需求" extra="先「AI 生成 JD」起草，再「AI 生成画像」把需求提炼成下方字段">
            <div style={{ background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: 8, padding: 8 }}>
              <Input.TextArea
                rows={10}
                value={jd}
                onChange={(e) => setJd(e.target.value)}
                placeholder="填写目标职位后，点上方「AI 生成 JD」自动起草招聘需求；也可以直接粘贴现成的 JD"
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {jd.trim() ? `当前 ${jd.trim().length} 字` : "还没有内容"}
                </Typography.Text>
                <Button
                  type="primary"
                  size="small"
                  icon={<ThunderboltOutlined />}
                  loading={generating}
                  onClick={handleGenerate}
                >
                  AI 生成画像
                </Button>
              </div>
              {/* 常驻状态提示：消息 toast 会消失，这里让「点了按钮到底发生了什么」一直可见 */}
              {jdHint && (
                <Alert
                  style={{ marginTop: 8 }}
                  type={jdHint.type === "loading" ? "info" : jdHint.type}
                  showIcon
                  message={jdHint.text}
                />
              )}
            </div>
          </Form.Item>

          {/* 第三步：画像字段（AI 提炼结果的落点，可直接核对修改） */}
          <div
            style={{
              border: "1px solid #e5e7eb", borderRadius: 8, padding: "12px 12px 0",
              background: "#fcfcfd", marginBottom: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <Typography.Text strong style={{ fontSize: 13 }}>画像字段</Typography.Text>
              {filledCount(fields) > 0 ? (
                <Tag color="green">已填 {filledCount(fields)} 项</Tag>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  点上方「AI 生成画像」自动提炼，也可直接手填
                </Typography.Text>
              )}
            </div>

            <div className="form-grid">
              <Form.Item label="工作城市">
                <Input
                  placeholder="如：深圳"
                  value={fields.city}
                  onChange={(e) => setFieldOf("city", e.target.value)}
                />
              </Form.Item>
              <Form.Item label="学历门槛">
                <Select
                  allowClear
                  placeholder="不限"
                  value={fields.education || undefined}
                  onChange={(v) => setFieldOf("education", v || "")}
                  options={EDUCATION_OPTIONS.map((e) => ({ label: e, value: e }))}
                />
              </Form.Item>
              <Form.Item label="年限下限">
                <InputNumber
                  min={0} max={40} style={{ width: "100%" }} addonAfter="年" placeholder="不限"
                  value={fields.min_years}
                  onChange={(v) => setFieldOf("min_years", v ?? null)}
                />
              </Form.Item>
              <Form.Item label="年限上限">
                <InputNumber
                  min={0} max={40} style={{ width: "100%" }} addonAfter="年" placeholder="不限"
                  value={fields.max_years}
                  onChange={(v) => setFieldOf("max_years", v ?? null)}
                />
              </Form.Item>
              <Form.Item label="薪资范围">
                <Input
                  placeholder="如：20-35K·13薪"
                  value={fields.salary_range}
                  onChange={(e) => setFieldOf("salary_range", e.target.value)}
                />
              </Form.Item>
              <Form.Item label="行业背景">
                <Input
                  placeholder="如：互联网 / SaaS"
                  value={fields.industry}
                  onChange={(e) => setFieldOf("industry", e.target.value)}
                />
              </Form.Item>
              <Form.Item label="必备技能">
                <Select
                  mode="tags" open={false} tokenSeparators={[",", "，"]}
                  placeholder="如：React、TypeScript"
                  value={fields.must_skills}
                  onChange={(v) => setFieldOf("must_skills", v)}
                />
              </Form.Item>
              <Form.Item label="加分技能">
                <Select
                  mode="tags" open={false} tokenSeparators={[",", "，"]}
                  placeholder="如：Node.js"
                  value={fields.nice_skills}
                  onChange={(v) => setFieldOf("nice_skills", v)}
                />
              </Form.Item>
              <span className="form-row-filler" />
              <Form.Item label="其它要求" className="span-all">
                <Input.TextArea
                  rows={2}
                  placeholder="软性素质、管理经验等补充要求"
                  value={fields.requirements}
                  onChange={(e) => setFieldOf("requirements", e.target.value)}
                />
              </Form.Item>
            </div>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
