import { useState, useEffect } from "react";
import {
  Card, Table, Button, Space, Tag, Modal, Form, Input, InputNumber, Select,
  Popconfirm, message, Typography, Empty, Tooltip,
} from "antd";
import {
  PlusOutlined, EditOutlined, DeleteOutlined, ThunderboltOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { EDUCATION_OPTIONS } from "../types";
import type { MatchProfile, MatchProfileLevel } from "../types";
import { EMPTY_MATCH_LEVEL } from "../types";

/** 薪资区间展示：min-max 元/月，缩成「xxK-xxK」 */
function salaryText(lv: MatchProfileLevel): string {
  if (lv.salary_min == null && lv.salary_max == null) return "";
  const fmt = (n: number | null) => (n == null ? "?" : Math.round(n / 1000) + "K");
  return `${fmt(lv.salary_min)}-${fmt(lv.salary_max)}`;
}

/** 级别列表页：管理「职位 → 多级别」的分级画像 */
export default function Profiles() {
  const navigate = useNavigate();
  const [list, setList] = useState<MatchProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<MatchProfile | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [jd, setJd] = useState("");
  const [generating, setGenerating] = useState(false);
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

  const openCreate = () => {
    setEditing(null);
    setJd("");
    form.resetFields();
    form.setFieldsValue({ levels: [{ ...EMPTY_MATCH_LEVEL, name: "初级", sort_order: 0 }] });
    setOpen(true);
  };

  const openEdit = (p: MatchProfile) => {
    setEditing(p);
    setJd(p.jd_raw || "");
    form.resetFields();
    form.setFieldsValue({
      ...p,
      levels: p.levels.length > 0
        ? p.levels
        : [{ ...EMPTY_MATCH_LEVEL, name: "初级", sort_order: 0 }],
    });
    setOpen(true);
  };

  // JD → 画像（含分级，AI 抽取）
  const handleGenerate = async () => {
    if (jd.trim().length < 10) {
      message.warning("请先粘贴招聘需求 / JD");
      return;
    }
    setGenerating(true);
    try {
      const p = await api.generateMatchProfile(jd);
      form.setFieldsValue({
        ...p,
        levels: p.levels.length > 0
          ? p.levels
          : [{ ...EMPTY_MATCH_LEVEL, name: "初级", sort_order: 0 }],
      });
      message.success("已生成画像，请核对后保存");
    } catch (err) {
      message.error((err as Error).message);
    }
    setGenerating(false);
  };

  const handleSave = async () => {
    const values = form.getFieldsValue(true) as MatchProfile;
    if (!values.name?.trim()) {
      message.error("请填写画像名称");
      return;
    }
    const levels = (values.levels || [])
      .filter((lv) => lv.name?.trim())
      .map((lv, i) => ({
        ...lv,
        sort_order: i,
        must_skills: lv.must_skills || [],
        nice_skills: lv.nice_skills || [],
      }));
    if (levels.length === 0) {
      message.error("请至少保留一个级别（或去掉分级、只填整体要求）");
      return;
    }
    setSaving(true);
    try {
      const payload: Partial<MatchProfile> = {
        ...values,
        levels,
        must_skills: values.must_skills || [],
        nice_skills: values.nice_skills || [],
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
    { title: "画像名称", dataIndex: "name", render: (v: string) => <strong>{v}</strong> },
    { title: "目标职位", dataIndex: "job_title", render: (v: string) => v || "-" },
    {
      title: "级别",
      dataIndex: "levels",
      render: (levels: MatchProfileLevel[]) =>
        levels && levels.length > 0 ? (
          <Space size={4} wrap>
            {levels.map((lv) => (
              <Tooltip
                key={lv.name + lv.sort_order}
                title={
                  [lv.min_years != null || lv.max_years != null ? `${lv.min_years ?? 0}~${lv.max_years ?? "不限"}年` : "",
                    lv.education || "", lv.city || "", salaryText(lv) ? `薪资 ${salaryText(lv)}${lv.salary_note ? `·${lv.salary_note}` : ""}` : ""]
                    .filter(Boolean).join(" · ") || "未设置"
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
      title: "操作",
      key: "actions",
      width: 180,
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

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>人物画像</Typography.Title>
        <Typography.Text type="secondary">
          为职位建立分级画像（初级/中级/高级…），每个级别可设年限、学历、技能、城市与市场薪资
        </Typography.Text>
      </div>

      <Card
        title="画像列表"
        size="small"
        extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建画像</Button>}
      >
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={list}
          columns={columns}
          pagination={false}
          locale={{ emptyText: <Empty description="还没有画像，点右上角「新建画像」或粘贴 JD 生成" /> }}
        />
      </Card>

      {/* 新建 / 编辑画像弹窗 */}
      <Modal
        title={editing ? "编辑画像" : "新建画像"}
        open={open}
        onCancel={() => setOpen(false)}
        width={860}
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
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            可粘贴 JD 自动生成画像（含分级），也可手动填
          </Typography.Text>
          <div style={{ display: "flex", gap: 8, marginTop: 8, marginBottom: 12 }}>
            <Input.TextArea
              rows={2}
              value={jd}
              onChange={(e) => setJd(e.target.value)}
              placeholder="粘贴招聘需求 / JD…"
              style={{ flex: 1 }}
            />
            <Button type="primary" icon={<ThunderboltOutlined />} loading={generating} onClick={handleGenerate}>
              AI 生成
            </Button>
          </div>

          <div className="form-grid">
            <Form.Item name="name" label="画像名称" rules={[{ required: true, message: "请输入名称" }]}>
              <Input placeholder="如：前端开发工程师" />
            </Form.Item>
            <Form.Item name="job_title" label="目标职位"><Input placeholder="如：前端开发工程师" /></Form.Item>
            <Form.Item name="city" label="工作城市"><Input placeholder="如：深圳" /></Form.Item>
            <Form.Item name="industry" label="行业背景"><Input placeholder="如：互联网" /></Form.Item>
          </div>

          <Typography.Title level={5} style={{ margin: "12px 0 8px" }}>
            级别（每个级别独立的年限 / 学历 / 技能 / 城市 / 市场薪资）
          </Typography.Title>

          <Form.List name="levels">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name, ...rest }) => (
                  <div
                    key={key}
                    style={{
                      border: "1px solid #e5e7eb", borderRadius: 8, padding: "12px 12px 4px",
                      marginBottom: 12, background: "#fafafa", position: "relative",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <Form.Item
                        {...rest}
                        name={[name, "name"]}
                        label="级别名"
                        rules={[{ required: true, message: "填级别名" }]}
                        style={{ marginBottom: 8, width: 200 }}
                      >
                        <Input placeholder="初级 / 中级 / 高级" />
                      </Form.Item>
                      <Button type="link" danger size="small" onClick={() => remove(name)} style={{ marginTop: -8 }}>
                        删除
                      </Button>
                    </div>
                    <div className="form-grid">
                      <Form.Item {...rest} name={[name, "min_years"]} label="年限下限">
                        <InputNumber min={0} max={40} style={{ width: "100%" }} addonAfter="年" placeholder="不限" />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, "max_years"]} label="年限上限">
                        <InputNumber min={0} max={40} style={{ width: "100%" }} addonAfter="年" placeholder="不限" />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, "education"]} label="学历">
                        <Select allowClear placeholder="不限" options={EDUCATION_OPTIONS.map((e) => ({ label: e, value: e }))} />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, "city"]} label="城市">
                        <Input placeholder="如：深圳" />
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
                      <Form.Item {...rest} name={[name, "must_skills"]} label="必备技能" extra="回车分隔">
                        <Select mode="tags" placeholder="如：React、TypeScript" tokenSeparators={[",", "，"]} open={false} />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, "nice_skills"]} label="加分技能">
                        <Select mode="tags" placeholder="如：Node.js" tokenSeparators={[",", "，"]} open={false} />
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
