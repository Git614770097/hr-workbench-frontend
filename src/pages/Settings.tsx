import { useEffect, useState } from "react";
import { Card, Tabs, Input, Button, Alert, message, Typography, Select, Modal, Form, Tag, Table, Space, Popconfirm } from "antd";
import { PlusOutlined, SearchOutlined, ReloadOutlined } from "@ant-design/icons";
import { api } from "../api";
import { useDict } from "../dict";
import { SOURCE_OPTIONS, REJECT_REASONS, EDUCATION_OPTIONS, JOB_TYPE_LABELS, CITY_OPTIONS, SKILL_OPTIONS } from "../types";

/** 字典类型元信息（顺序即列表展示顺序） */
const DICT_TYPE_META: { key: string; label: string; color: string; hint: string; fixed?: boolean }[] = [
  { key: "sources", label: "来源渠道", color: "blue", hint: "录入/导入时的来源下拉" },
  { key: "reject_reasons", label: "淘汰原因", color: "orange", hint: "看板淘汰原因、漏斗淘汰分布统计" },
  { key: "education", label: "学历", color: "green", hint: "人才录入/导入、岗位学历要求" },
  { key: "job_types", label: "用工类型", color: "purple", hint: "岗位用工类型，固定项仅可改名称", fixed: true },
  { key: "cities", label: "城市", color: "cyan", hint: "人才档案/岗位所在城市下拉选项" },
  { key: "skills", label: "技能标签", color: "magenta", hint: "人才录入技能输入补全、技能筛选" },
];

/** 上传图片转成 data URL 存库（收款码是管理员自己的图，量小，不走 KV） */
function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function FieldLabel({ children, extra }: { children: string; extra?: string }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <Typography.Text strong>{children}</Typography.Text>
      {extra ? (
        <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
          {extra}
        </Typography.Text>
      ) : null}
    </div>
  );
}

function PaySettings() {
  const [wechat, setWechat] = useState("");
  const [alipay, setAlipay] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getPayConfig()
      .then((c) => {
        setWechat(c.wechat_qr || "");
        setAlipay(c.alipay_qr || "");
        setNote(c.note || "");
      })
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.setPayConfig({ wechat_qr: wechat, alipay_qr: alipay, note });
      message.success("收款设置已保存");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const pick = async (e: React.ChangeEvent<HTMLInputElement>, setter: (v: string) => void) => {
    const f = e.target.files?.[0];
    if (f) setter(await readImage(f));
    e.target.value = "";
  };

  return (
    <div style={{ maxWidth: 760 }}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 20 }}
        message="上传微信 / 支付宝收款码截图，用户在点「会员续费」时即可看到并扫码付款。"
      />
      <div style={{ marginBottom: 20 }}>
        <FieldLabel>微信收款码</FieldLabel>
        <label>
          <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => pick(e, setWechat)} />
          <Button>选择图片</Button>
        </label>
        {wechat ? (
          <div style={{ marginTop: 8 }}>
            <img
              src={wechat}
              alt="微信收款码"
              style={{
                width: 140,
                height: 140,
                objectFit: "contain",
                border: "1px solid var(--color-border-tertiary)",
                borderRadius: 8,
                background: "#fff",
                display: "block",
              }}
            />
            <Button type="link" size="small" danger onClick={() => setWechat("")} style={{ paddingInline: 0, marginTop: 4 }}>
              清除
            </Button>
          </div>
        ) : null}
      </div>

      <div style={{ marginBottom: 20 }}>
        <FieldLabel>支付宝收款码</FieldLabel>
        <label>
          <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => pick(e, setAlipay)} />
          <Button>选择图片</Button>
        </label>
        {alipay ? (
          <div style={{ marginTop: 8 }}>
            <img
              src={alipay}
              alt="支付宝收款码"
              style={{
                width: 140,
                height: 140,
                objectFit: "contain",
                border: "1px solid var(--color-border-tertiary)",
                borderRadius: 8,
                background: "#fff",
                display: "block",
              }}
            />
            <Button type="link" size="small" danger onClick={() => setAlipay("")} style={{ paddingInline: 0, marginTop: 4 }}>
              清除
            </Button>
          </div>
        ) : null}
      </div>

      <div style={{ marginBottom: 20 }}>
        <FieldLabel extra="展示在收款码上方">说明文字（选填）</FieldLabel>
        <Input.TextArea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="例如：年费 ¥49.9，扫码付款后联系管理员开通"
        />
      </div>

      <Button type="primary" loading={saving} onClick={handleSave}>
        保存
      </Button>
    </div>
  );
}

function DictSettings() {
  const { reload } = useDict();
  const [sources, setSources] = useState<string[]>(SOURCE_OPTIONS);
  const [reasons, setReasons] = useState<string[]>(REJECT_REASONS);
  const [education, setEducation] = useState<string[]>(EDUCATION_OPTIONS);
  const [jobTypes, setJobTypes] = useState<Record<string, string>>(JOB_TYPE_LABELS);
  const [cities, setCities] = useState<string[]>(CITY_OPTIONS);
  const [skills, setSkills] = useState<string[]>(SKILL_OPTIONS);

  const [saving, setSaving] = useState(false);
  const [draftKeyword, setDraftKeyword] = useState("");
  const [keyword, setKeyword] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addForm] = Form.useForm();
  const [editOpen, setEditOpen] = useState(false);
  const [editRowKey, setEditRowKey] = useState(""); // 正在编辑的行（原类型 key）
  const [editTypeKey, setEditTypeKey] = useState(""); // 弹窗里选中的目标类型
  const [editItems, setEditItems] = useState<string[]>([]); // 数组型选项
  const [editJobTypes, setEditJobTypes] = useState<Record<string, string>>({}); // job_types 中文名

  useEffect(() => {
    api
      .getDictConfig()
      .then((d) => {
        setSources(d.sources?.length ? d.sources : SOURCE_OPTIONS);
        setReasons(d.reject_reasons?.length ? d.reject_reasons : REJECT_REASONS);
        setEducation(d.education?.length ? d.education : EDUCATION_OPTIONS);
        if (d.job_types && typeof d.job_types === "object") setJobTypes(d.job_types);
        if (Array.isArray(d?.cities) && d.cities.length > 0) setCities(d.cities);
        if (Array.isArray(d?.skills) && d.skills.length > 0) setSkills(d.skills);
      })
      .catch(() => {
        setSources(SOURCE_OPTIONS);
        setReasons(REJECT_REASONS);
        setEducation(EDUCATION_OPTIONS);
        setJobTypes(JOB_TYPE_LABELS);
        setCities(CITY_OPTIONS);
        setSkills(SKILL_OPTIONS);
      });
  }, []);

  const clean = (list: string[]): string[] => [...new Set(list.map((s) => s.trim()).filter(Boolean))];

  const listOf = (typeKey: string): string[] => {
    if (typeKey === "sources") return sources;
    if (typeKey === "reject_reasons") return reasons;
    if (typeKey === "education") return education;
    if (typeKey === "cities") return cities;
    if (typeKey === "skills") return skills;
    return [];
  };

  /** typeKey → 本地 state 的键名（reject_reasons 在 state 里叫 reasons） */
  const stateKeyOf = (typeKey: string): "sources" | "reasons" | "education" | "cities" | "skills" =>
    typeKey === "sources" ? "sources" : typeKey === "reject_reasons" ? "reasons" : typeKey === "cities" ? "cities" : typeKey === "skills" ? "skills" : "education";

  interface DictState {
    sources: string[];
    reasons: string[];
    education: string[];
    jobTypes: Record<string, string>;
    cities: string[];
    skills: string[];
  }

  /**
   * 统一提交：校验 → 落库 → 刷新全站字典 → 成功后同步本地 state。
   * 没有底部「保存」按钮，任何改动都即时生效，所以这里是唯一的写入口。
   */
  const commit = async (next: DictState): Promise<boolean> => {
    const s = clean(next.sources);
    const r = clean(next.reasons);
    const e = clean(next.education);
    if (s.length === 0 || r.length === 0 || e.length === 0) {
      message.warning("来源渠道、淘汰原因、学历都至少要保留一个选项");
      return false;
    }
    setSaving(true);
    try {
      await api.setDictConfig({
        sources: s, reject_reasons: r, education: e, job_types: next.jobTypes,
        cities: clean(next.cities), skills: clean(next.skills),
      });
      setSources(s);
      setReasons(r);
      setEducation(e);
      setJobTypes(next.jobTypes);
      setCities(clean(next.cities));
      setSkills(clean(next.skills));
      // 关键：字典改完必须让全站下拉立即生效，否则要刷新页面才看到
      await reload();
      message.success("已保存，全站选项已更新");
      return true;
    } catch (err) {
      message.error((err as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const current = (): DictState => ({ sources, reasons, education, jobTypes, cities, skills });

  const handleAdd = () => {
    addForm.validateFields().then(async (v: { typeKey: string; value: string }) => {
      const val = (v.value || "").trim();
      if (!val) return;
      const exist = listOf(v.typeKey);
      if (exist.includes(val)) {
        message.warning("该选项已存在");
        return;
      }
      const next = current();
      next[stateKeyOf(v.typeKey)] = [...exist, val];
      if (await commit(next)) {
        addForm.resetFields();
        setAddOpen(false);
      }
    });
  };

  // 打开「行」编辑：编辑整类（类型可改归属 + 名称可增删改）
  const openRowEdit = (row: { typeKey: string }) => {
    setEditRowKey(row.typeKey);
    setEditTypeKey(row.typeKey);
    if (row.typeKey === "job_types") {
      setEditJobTypes({ ...jobTypes });
    } else {
      setEditItems([...listOf(row.typeKey)]);
    }
    setEditOpen(true);
  };

  const handleEditSave = async () => {
    const target = editTypeKey;
    if (!target) return;
    const next = current();
    if (editRowKey === "job_types") {
      // 固定项：类型不可改，只改中文名（留空则回落默认标签，避免存成空串）
      const cleaned = { ...editJobTypes };
      Object.keys(JOB_TYPE_LABELS).forEach((k) => {
        if (!(cleaned[k] || "").trim()) cleaned[k] = JOB_TYPE_LABELS[k];
      });
      next.jobTypes = cleaned;
    } else {
      const cleaned = clean(editItems);
      if (cleaned.length === 0) {
        message.warning("名称至少要保留一项");
        return;
      }
      if (target === "job_types") return; // 数组型不能迁移到固定项
      if (editRowKey !== target) next[stateKeyOf(editRowKey)] = []; // 类型迁移：旧类型清空
      next[stateKeyOf(target)] = cleaned;
    }
    if (await commit(next)) setEditOpen(false);
  };

  const handleDeleteRow = async (row: { typeKey: string }) => {
    const next = current();
    next[stateKeyOf(row.typeKey)] = [];
    await commit(next); // 三类必填，清空会被 commit 拦下并提示
  };

  const handleSearch = () => setKeyword(draftKeyword.trim());
  const handleReset = () => { setDraftKeyword(""); setKeyword(""); };

  const kw = keyword.toLowerCase();

  // 列表行：每「类型」合并为一行
  interface DictRow {
    typeKey: string;
    label: string;
    color: string;
    hint: string;
    fixed: boolean;
    items: { key: string; value: string; index?: number; jobKey?: string }[];
  }

  const rows: DictRow[] = DICT_TYPE_META.map((meta) => {
    if (meta.key === "job_types") {
      const items = Object.entries(jobTypes).map(([k, v]) => ({ key: `jt-${k}`, value: v, jobKey: k }));
      return { typeKey: meta.key, label: meta.label, color: meta.color, hint: meta.hint, fixed: !!meta.fixed, items };
    }
    const arr = listOf(meta.key);
    const items = arr.map((value, index) => ({ key: `${meta.key}-${index}`, value, index }));
    return { typeKey: meta.key, label: meta.label, color: meta.color, hint: meta.hint, fixed: !!meta.fixed, items };
  });

  // 搜索：命中某类任一选项名，该类整行保留
  const filteredRows = rows.filter((r) => {
    if (!kw) return true;
    return r.items.some((it) => it.value.toLowerCase().includes(kw));
  });

  const columns = [
    {
      title: "类型",
      dataIndex: "label",
      key: "label",
      width: 140,
      render: (_: string, row: DictRow) => <Tag color={row.color}>{row.label}</Tag>,
    },
    {
      title: "名称",
      key: "items",
      render: (_: unknown, row: DictRow) => (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {row.items.map((it) => (
            <Tag
              key={it.key}
              color={row.fixed ? "purple" : undefined}
              style={{ fontSize: 13, padding: "3px 10px", marginInlineEnd: 0 }}
            >
              {it.value}
            </Tag>
          ))}
        </div>
      ),
    },
    {
      title: "数量",
      key: "count",
      width: 80,
      align: "center" as const,
      render: (_: unknown, row: DictRow) => row.items.length,
    },
    {
      title: "操作",
      key: "action",
      width: 140,
      align: "center" as const,
      render: (_: unknown, row: DictRow) => (
        <Space size={12}>
          <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={() => openRowEdit(row)}>
            编辑
          </Button>
          {!row.fixed && (
            <Popconfirm
              title={`删除「${row.label}」的全部选项？`}
              description="删除后全站相关下拉将不再显示这些值。"
              onConfirm={() => handleDeleteRow(row)}
              okText="删除"
              cancelText="取消"
            >
              <Button type="link" size="small" danger style={{ paddingInline: 0 }}>
                删除
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div style={{ width: "100%" }}>
      {/* 搜索区（复用列表页 search-grid 约定） */}
      <div className="search-grid" style={{ marginBottom: 16, gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
        <div className="search-field">
          <span className="search-label">选项名称</span>
          <div className="search-control">
            <Input
              allowClear
              placeholder="搜索某类里的选项名称"
              value={draftKeyword}
              onChange={(e) => setDraftKeyword(e.target.value)}
              onPressEnter={handleSearch}
            />
          </div>
        </div>
      </div>

      {/* 工具行 */}
      <div className="toolbar">
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { addForm.resetFields(); setAddOpen(true); }}>
            新增
          </Button>
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={handleReset}>重置</Button>
          <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>查询</Button>
        </Space>
      </div>

      <Table<DictRow>
        rowKey="typeKey"
        dataSource={filteredRows}
        pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: false, showTotal: (t) => `共 ${t} 类` }}
        size="middle"
        locale={{ emptyText: "暂无匹配的数据" }}
        columns={columns}
      />

      {/* 新增弹窗 */}
      <Modal
        title="新增字典项"
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        onOk={handleAdd}
        confirmLoading={saving}
        okText="添加"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={addForm} layout="vertical" initialValues={{ typeKey: "sources" }}>
          <Form.Item name="typeKey" label="类型" rules={[{ required: true }]}>
            <Select
              options={DICT_TYPE_META.filter((m) => m.key !== "job_types").map((m) => ({ value: m.key, label: m.label }))}
            />
          </Form.Item>
          <Form.Item name="value" label="名称" rules={[{ required: true, message: "请输入名称" }]}>
            <Input placeholder="例如：BOSS直聘 / 本科 / 薪资不匹配" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑弹窗：编辑整类（类型可改归属 + 名称可增删改） */}
      <Modal
        title="编辑字典"
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={handleEditSave}
        confirmLoading={saving}
        okText="确定"
        cancelText="取消"
        destroyOnClose
        width={460}
      >
        <Form layout="vertical">
          <Form.Item label="类型" required>
            <Select
              value={editTypeKey}
              onChange={setEditTypeKey}
              disabled={editRowKey === "job_types"}
              options={
                editRowKey === "job_types"
                  ? DICT_TYPE_META.filter((m) => m.key === "job_types").map((m) => ({ value: m.key, label: m.label }))
                  : DICT_TYPE_META.filter((m) => m.key !== "job_types").map((m) => ({ value: m.key, label: m.label }))
              }
            />
          </Form.Item>
          <Form.Item label="名称" required>
            {editRowKey === "job_types" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {Object.keys(JOB_TYPE_LABELS).map((k) => (
                  <div key={k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <Tag style={{ width: 56, textAlign: "center", marginInlineEnd: 0 }}>{k}</Tag>
                    <Input
                      value={editJobTypes[k] ?? ""}
                      onChange={(e) => setEditJobTypes((prev) => ({ ...prev, [k]: e.target.value }))}
                      placeholder={JOB_TYPE_LABELS[k]}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <Select
                mode="tags"
                value={editItems}
                onChange={(v) => setEditItems(v as string[])}
                placeholder="输入后回车新增；点击标签 × 删除该项"
                tokenSeparators={[",", "，"]}
                open={false}
                suffixIcon={null}
                style={{ width: "100%" }}
              />
            )}
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

function ChangelogSettings() {
  const [version, setVersion] = useState("");
  const [title, setTitle] = useState("");
  const [updatedAt, setUpdatedAt] = useState("");
  const [itemsText, setItemsText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getChangelog()
      .then((c) => {
        setVersion(c.version || "");
        setTitle(c.title || "");
        setUpdatedAt(c.updated_at || "");
        setItemsText((c.items || []).join("\n"));
      })
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    if (!version.trim()) {
      message.warning("请填写版本号");
      return;
    }
    setSaving(true);
    try {
      await api.setChangelog({
        version: version.trim(),
        title: title.trim(),
        updated_at: updatedAt.trim(),
        items: itemsText.split("\n").map((s) => s.trim()).filter(Boolean),
      });
      message.success("更新公告已保存，用户下次打开即会弹窗");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 760 }}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 20 }}
        message="修改版本号并保存后，所有用户下次打开系统会弹出此公告（仅弹一次，直到版本号再次变化）。"
      />
      <div style={{ marginBottom: 16 }}>
        <FieldLabel>版本号</FieldLabel>
        <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="例如：v1.1" />
      </div>
      <div style={{ marginBottom: 16 }}>
        <FieldLabel>标题</FieldLabel>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：v1.1 更新公告" />
      </div>
      <div style={{ marginBottom: 16 }}>
        <FieldLabel extra="展示在公告下方，如 2026-10-09">更新日期</FieldLabel>
        <Input value={updatedAt} onChange={(e) => setUpdatedAt(e.target.value)} placeholder="例如：2026-10-09" />
      </div>
      <div style={{ marginBottom: 16 }}>
        <FieldLabel extra="每行一条">更新内容</FieldLabel>
        <Input.TextArea
          value={itemsText}
          onChange={(e) => setItemsText(e.target.value)}
          rows={6}
          placeholder={"每行一条，例如：\n新增 XX 功能\n优化 XX 体验"}
        />
      </div>
      <Button type="primary" loading={saving} onClick={handleSave}>
        保存
      </Button>
    </div>
  );
}

export default function Settings() {
  // 后续再有全局配置（例如老带新奖励天数）直接加新 Tab，不必再动菜单
  const items = [
    { key: "pay", label: "收款码设置", children: <PaySettings /> },
    { key: "dict", label: "数据字典", children: <DictSettings /> },
    { key: "changelog", label: "更新公告", children: <ChangelogSettings /> },
  ];

  return (
    <div className="page-fill">
      <Card>
        <Tabs className="app-pill-tabs" items={items} />
      </Card>
    </div>
  );
}
