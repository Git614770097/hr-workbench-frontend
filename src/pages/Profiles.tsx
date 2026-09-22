import { useState, useEffect, useMemo } from "react";
import {
  Card, Table, Button, Space, Tag, Modal, Form, Input, InputNumber, Select,
  Popconfirm, message, Typography, Empty, Tooltip,
} from "antd";
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ThunderboltOutlined,
  SearchOutlined, ReloadOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { EDUCATION_OPTIONS } from "../types";
import type { MatchProfile, MatchProfileLevel } from "../types";
import { EMPTY_MATCH_LEVEL } from "../types";

/** 单个级别的薪资区间展示：min-max 元/月，缩成「xxK-xxK」 */
function salaryText(lv: MatchProfileLevel): string {
  if (lv.salary_min == null && lv.salary_max == null) return "";
  const fmt = (n: number | null) => (n == null ? "?" : Math.round(n / 1000) + "K");
  return `${fmt(lv.salary_min)}-${fmt(lv.salary_max)}`;
}

/** 画像整体薪资区间：取所有级别的最小下限 ~ 最大上限 */
function profileSalaryRange(levels: MatchProfileLevel[]): string {
  const mins = (levels || []).map((l) => l.salary_min).filter((n): n is number => n != null);
  const maxs = (levels || []).map((l) => l.salary_max).filter((n): n is number => n != null);
  if (mins.length === 0 && maxs.length === 0) return "";
  const fmt = (n: number | null) => (n == null ? "?" : Math.round(n / 1000) + "K");
  const lo = mins.length ? Math.min(...mins) : null;
  const hi = maxs.length ? Math.max(...maxs) : null;
  return `${fmt(lo)}~${fmt(hi)}`;
}

/** 级别城市去重（列表「城市」列） */
function cityText(levels: MatchProfileLevel[]): string {
  return Array.from(new Set((levels || []).map((l) => l.city).filter(Boolean))).join("、");
}

/** 级别汇总的必备技能（去重） */
function allSkills(levels: MatchProfileLevel[]): string[] {
  return Array.from(new Set((levels || []).flatMap((l) => l.must_skills || [])));
}

/** AI 生成 / 存量画像归一：画像不分级时，把「整体要求」收进唯一级别，避免要求丢失 */
function normalizeLevels(p: MatchProfile): MatchProfileLevel[] {
  if (p.levels && p.levels.length > 0) return p.levels;
  return [{
    ...EMPTY_MATCH_LEVEL,
    name: "统一标准",
    min_years: p.min_years ?? null,
    max_years: p.max_years ?? null,
    education: p.education || "",
    city: p.city || "",
    must_skills: p.must_skills || [],
    nice_skills: p.nice_skills || [],
    requirements: p.requirements || "",
    salary_note: p.salary_range || "",
    sort_order: 0,
  }];
}

// 搜索条件（draft = 编辑中，applied = 已生效）
// 「画像名称」与「目标职位」本是同一个东西，已合并为「目标职位」，不再设两个筛选项
interface Filters { job_title: string; city: string; level: string; }
const EMPTY_FILTERS: Filters = { job_title: "", city: "", level: "" };

/** 列表页：管理「职位 → 多级别」的分级画像 */
export default function Profiles() {
  const navigate = useNavigate();
  const [list, setList] = useState<MatchProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<MatchProfile | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [jd, setJd] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genJd, setGenJd] = useState(false);
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
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
      if (applied.city && !(p.levels || []).some((l) => (l.city || "").includes(applied.city.trim()))) return false;
      if (applied.level && !(p.levels || []).some((l) => (l.name || "").includes(applied.level.trim()))) return false;
      return true;
    });
  }, [list, applied]);

  const openCreate = () => {
    setEditing(null);
    setJd("");
    setGenJd(false);
    form.resetFields();
    form.setFieldsValue({ levels: [{ ...EMPTY_MATCH_LEVEL, name: "初级", sort_order: 0 }] });
    setOpen(true);
  };

  const openEdit = (p: MatchProfile) => {
    setEditing(p);
    setJd(p.jd_raw || "");
    setGenJd(false);
    form.resetFields();
    form.setFieldsValue({ job_title: p.job_title || p.name, levels: normalizeLevels(p) });
    setOpen(true);
  };

  // 第一步：填了职位 → AI 起草一份完整 JD（可人工修改后再提炼画像）
  const handleGenJd = async () => {
    const jobTitle = ((form.getFieldValue("job_title") as string) || "").trim();
    if (!jobTitle) {
      message.warning("请先填写目标职位");
      return;
    }
    setGenJd(true);
    try {
      const r = await api.generateJd(jobTitle);
      setJd(r.jd || "");
      message.success("JD 已生成，可直接用或修改后点「AI 生成画像」");
    } catch (err) {
      message.error((err as Error).message);
    }
    setGenJd(false);
  };

  // JD → 画像（含分级，AI 抽取）
  const handleGenerate = async () => {
    if (jd.trim().length < 10) {
      message.warning("请先填写招聘需求（可点上方「AI 生成 JD」自动起草）");
      return;
    }
    setGenerating(true);
    try {
      const curJob = ((form.getFieldValue("job_title") as string) || "").trim();
      const p = await api.generateMatchProfile(jd);
      form.setFieldsValue({
        job_title: p.job_title || curJob,
        levels: normalizeLevels(p),
      });
      message.success("已生成画像，请核对后保存");
    } catch (err) {
      message.error((err as Error).message);
    }
    setGenerating(false);
  };

  const handleSave = async () => {
    const values = form.getFieldsValue(true) as MatchProfile;
    const jobTitle = (values.job_title || "").trim();
    if (!jobTitle) {
      message.error("请填写目标职位");
      return;
    }
    const levels = (values.levels || [])
      .filter((lv) => lv?.name?.trim())
      .map((lv, i) => ({
        ...lv,
        sort_order: i,
        must_skills: lv.must_skills || [],
        nice_skills: lv.nice_skills || [],
      }));
    if (levels.length === 0) {
      message.error("请至少保留一个级别");
      return;
    }
    setSaving(true);
    try {
      // 「画像名称」已与「目标职位」合并：name 字段继续写入（列表/匹配页沿用），值即目标职位
      const payload: Partial<MatchProfile> = {
        name: jobTitle,
        job_title: jobTitle,
        levels,
        jd_raw: jd.slice(0, 4000),
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
      width: 140,
      render: (_: unknown, r: MatchProfile) => cityText(r.levels) || "—",
    },
    {
      title: "级别",
      key: "levels",
      width: 220,
      render: (_: unknown, r: MatchProfile) =>
        r.levels && r.levels.length > 0 ? (
          <Space size={4} wrap>
            {r.levels.map((lv) => (
              <Tooltip
                key={lv.name + lv.sort_order}
                title={
                  [
                    lv.min_years != null || lv.max_years != null ? `${lv.min_years ?? 0}~${lv.max_years ?? "不限"}年` : "",
                    lv.education || "",
                    lv.city || "",
                    salaryText(lv) ? `薪资 ${salaryText(lv)}${lv.salary_note ? `·${lv.salary_note}` : ""}` : "",
                  ].filter(Boolean).join(" · ") || "未设置"
                }
              >
                <Tag color="blue">{lv.name}</Tag>
              </Tooltip>
            ))}
          </Space>
        ) : (
          <Tag>不分级</Tag>
        ),
    },
    {
      title: "必备技能",
      key: "skills",
      width: 240,
      render: (_: unknown, r: MatchProfile) => {
        const all = allSkills(r.levels);
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
      title: "市场薪资",
      key: "salary",
      width: 130,
      render: (_: unknown, r: MatchProfile) =>
        profileSalaryRange(r.levels) ? <span style={{ color: "#c0392b" }}>{profileSalaryRange(r.levels)}</span> : "—",
    },
    { title: "更新时间", dataIndex: "updated_at", key: "updated_at", width: 160, render: (v: string) => v || "—" },
    {
      title: "操作",
      key: "actions",
      width: 190,
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
    { key: "city", label: "城市", node: <Input style={fieldStyle} placeholder="按级别城市匹配" value={draft.city} onChange={(e) => setField("city", e.target.value)} onPressEnter={handleSearch} allowClear /> },
    { key: "level", label: "级别", node: <Input style={fieldStyle} placeholder="如：初级 / 高级" value={draft.level} onChange={(e) => setField("level", e.target.value)} onPressEnter={handleSearch} allowClear /> },
  ];

  return (
    <div>
      {/* 搜索区域：只放搜索字段 */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px 24px" }}>
          {searchDefs.map((d) => (
            <div key={d.key} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 56, flexShrink: 0, textAlign: "right", fontSize: 13, color: "#666" }}>{d.label}</span>
              <div style={{ flex: 1, minWidth: 0 }}>{d.node}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        {/* 布局约定：工具行左侧数据操作、右侧「重置 / 查询」 */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <Space>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建画像</Button>
          </Space>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={handleReset}>重置</Button>
            <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>查询</Button>
          </Space>
        </div>
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={filtered}
          columns={columns}
          scroll={{ x: 1230 }}
          locale={{ emptyText: <Empty description="还没有画像，点左上角「新建画像」或粘贴 JD 生成" /> }}
          pagination={{ pageSize: 10, showTotal: (t) => `共 ${t} 个画像` }}
        />
      </Card>

      {/* 新建 / 编辑画像弹窗 */}
      <Modal
        title={editing ? "编辑画像" : "新建画像"}
        open={open}
        onCancel={() => setOpen(false)}
        width={820}
        getContainer={() => document.body}
        zIndex={1050}
        footer={
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              级别按年限从低到高排序；候选人年限落在哪一档，就按该档的要求匹配
            </Typography.Text>
            <Space>
              <Button onClick={() => setOpen(false)}>取消</Button>
              <Button type="primary" loading={saving} onClick={handleSave}>保存</Button>
            </Space>
          </div>
        }
      >
        <Form form={form} layout="horizontal" className="form-horizontal" labelCol={{ flex: "88px" }}>
          {/* 第一步：先填职位 → AI 起草 JD */}
          <Form.Item label="目标职位" required style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 8 }}>
              <Form.Item name="job_title" noStyle rules={[{ required: true, message: "请填写目标职位" }]}>
                <Input placeholder="如：前端开发工程师" onPressEnter={() => handleGenJd()} />
              </Form.Item>
              <Button
                type="primary"
                ghost
                icon={<ThunderboltOutlined />}
                loading={genJd}
                onClick={handleGenJd}
                style={{ flexShrink: 0 }}
              >
                AI 生成 JD
              </Button>
            </div>
          </Form.Item>

          {/* 第二步：核对 / 修改 JD → 提炼分级画像 */}
          <Form.Item label="招聘需求" extra="AI 生成后可自由修改；已有现成 JD 也可直接粘贴">
            <div style={{ background: "#fafafa", border: "1px solid #e5e7eb", borderRadius: 8, padding: 8 }}>
              <Input.TextArea
                rows={7}
                value={jd}
                onChange={(e) => setJd(e.target.value)}
                placeholder="填写目标职位后，点上方「AI 生成 JD」自动起草招聘需求；也可以直接粘贴现成的 JD"
                style={{ marginBottom: 8 }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {jd.trim() ? `当前 ${jd.trim().length} 字` : "还没有内容"}
                </Typography.Text>
                <Button type="primary" icon={<ThunderboltOutlined />} loading={generating} onClick={handleGenerate}>
                  AI 生成画像
                </Button>
              </div>
            </div>
          </Form.Item>

          <Typography.Title
            level={5}
            style={{ margin: "4px 0 12px", paddingTop: 12, borderTop: "1px solid #f0f0f0" }}
          >
            分级要求（每个级别独立的年限 / 学历 / 技能 / 城市 / 市场薪资）
          </Typography.Title>

          <Form.List name="levels">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name, ...rest }, idx) => (
                  <div
                    key={key}
                    style={{
                      border: "1px solid #e5e7eb", borderRadius: 8, padding: "12px 12px 0",
                      marginBottom: 12, background: "#fafafa",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#5b6472" }}>级别 {idx + 1}</span>
                      <Button type="link" danger size="small" onClick={() => remove(name)}>删除</Button>
                    </div>
                    <div className="form-grid">
                      <Form.Item {...rest} name={[name, "name"]} label="级别名" rules={[{ required: true, message: "填级别名" }]}>
                        <Input placeholder="初级 / 中级 / 高级" />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, "education"]} label="学历门槛">
                        <Select allowClear placeholder="不限" options={EDUCATION_OPTIONS.map((e) => ({ label: e, value: e }))} />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, "min_years"]} label="年限下限">
                        <InputNumber min={0} max={40} style={{ width: "100%" }} addonAfter="年" placeholder="不限" />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, "max_years"]} label="年限上限">
                        <InputNumber min={0} max={40} style={{ width: "100%" }} addonAfter="年" placeholder="不限" />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, "city"]} label="工作城市">
                        <Input placeholder="如：深圳" />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, "must_skills"]} label="必备技能">
                        <Select mode="tags" placeholder="如：React、TypeScript" tokenSeparators={[",", "，"]} open={false} />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, "nice_skills"]} label="加分技能">
                        <Select mode="tags" placeholder="如：Node.js" tokenSeparators={[",", "，"]} open={false} />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, "salary_min"]} label="薪资下限">
                        <InputNumber min={0} style={{ width: "100%" }} addonAfter="元/月" placeholder="市场价" />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, "salary_max"]} label="薪资上限">
                        <InputNumber min={0} style={{ width: "100%" }} addonAfter="元/月" placeholder="市场价" />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, "salary_note"]} label="薪资说明">
                        <Input placeholder="如：一线城市 / 13薪" />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, "requirements"]} label="级别要求" className="span-all">
                        <Input.TextArea rows={1} placeholder="该级别的补充要求（可选）" />
                      </Form.Item>
                    </div>
                  </div>
                ))}
                <Button
                  type="dashed"
                  block
                  icon={<PlusOutlined />}
                  onClick={() => add({ ...EMPTY_MATCH_LEVEL, sort_order: fields.length })}
                  style={{ marginBottom: 12 }}
                >
                  添加级别
                </Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>
    </div>
  );
}
