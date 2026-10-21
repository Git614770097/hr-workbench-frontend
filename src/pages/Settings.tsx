import { useEffect, useState } from "react";
import { Card, Tabs, Input, InputNumber, Button, Alert, message, Typography, Select, Modal, Form, Tag, Table, Space, Popconfirm, Collapse, Radio } from "antd";
import { PlusOutlined, SearchOutlined, ReloadOutlined } from "@ant-design/icons";
import { api } from "../api";
import { useDict } from "../dict";
import { useSearchParams } from "react-router-dom";
import { SOURCE_OPTIONS, REJECT_REASONS, EDUCATION_OPTIONS, JOB_TYPE_LABELS, CITY_OPTIONS, SKILL_OPTIONS, FeishuSettings, FeishuWebhook, FeishuNotifyMode } from "../types";

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

// ---- AI 配额设置：管理员不限额；普通用户每日上限可调 ----
function AiQuotaSettings() {
  const [limit, setLimit] = useState<number>(20);
  const [used, setUsed] = useState<number | null>(null);
  const [unlimited, setUnlimited] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getAiQuota()
      .then((q) => {
        // 管理员自己的 limit 恒为 -1（不限），要回显的是「系统设置里配的值」
        setLimit(q.default_limit);
        setUsed(q.used);
        setUnlimited(q.unlimited);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.setAiQuota(limit);
      message.success("AI 配额已保存，即时生效");
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
        message={`管理员账号不限 AI 次数（今日已用 ${used ?? 0} 次，仅供了解）。下方设置的次数只约束普通用户，中国时区凌晨自动重置。`}
      />
      <div style={{ marginBottom: 16 }}>
        <FieldLabel extra="0 = 不限制；建议 10~100，防止 token 成本失控">普通用户每日 AI 次数上限</FieldLabel>
        <InputNumber
          value={limit}
          onChange={(v) => setLimit(typeof v === "number" ? v : 0)}
          min={0}
          max={9999}
          step={5}
          disabled={loading}
          style={{ width: 160 }}
          addonAfter="次/ 天"
        />
        <div style={{ marginTop: 6 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            当前生效：{limit === 0 ? "不限制" : `每人每天 ${limit} 次`}
          </Typography.Text>
        </div>
      </div>
      <Button type="primary" loading={saving} disabled={loading} onClick={handleSave}>
        保存
      </Button>
    </div>
  );
}

// ---- 飞书集成（admin）：BYOK 配置飞书自建应用，给绑定飞书的成员推送提醒 ----
function FeishuSettingsPanel() {
  const [cfg, setCfg] = useState<FeishuSettings | null>(null);
  const [name, setName] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [encryptKey, setEncryptKey] = useState("");
  const [verificationToken, setVerificationToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  // 群自定义机器人（零应用依赖的群推送通道）
  const [webhooks, setWebhooks] = useState<FeishuWebhook[]>([]);
  const [whName, setWhName] = useState("");
  const [whUrl, setWhUrl] = useState("");
  const [whSaving, setWhSaving] = useState(false);
  const [whTesting, setWhTesting] = useState(false);
  // 发送模式：both=群+个人 / group=仅群 / personal=仅个人（默认 personal）
  const [notifyMode, setNotifyMode] = useState<FeishuNotifyMode>("personal");
  const [modeSaving, setModeSaving] = useState(false);

  const reload = () => {
    api.getFeishuSettings()
      .then((c) => {
        setCfg(c);
        if (c.configured) { setName(c.name || ""); setAppId(c.app_id || ""); }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(reload, []);

  const reloadWebhooks = () => {
    api.getFeishuWebhooks().then((r) => setWebhooks(r.webhooks)).catch(() => {});
    api.getFeishuNotifyMode().then((r) => setNotifyMode(r.mode)).catch(() => {});
  };
  useEffect(reloadWebhooks, []);

  const handleSaveWebhook = async () => {
    if (!whUrl.trim()) { message.warning("请粘贴飞书群机器人的 webhook 地址"); return; }
    setWhSaving(true);
    try {
      await api.saveFeishuWebhook({ name: whName.trim() || "飞书群机器人", url: whUrl.trim() });
      message.success("群机器人已保存（地址加密存储）");
      setWhName(""); setWhUrl("");
      reloadWebhooks();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setWhSaving(false);
    }
  };

  const handleTestWebhook = async (target: { id?: string; url?: string }) => {
    setWhTesting(true);
    try {
      const res = await api.testFeishuWebhook(target);
      if (res.ok) message.success("测试消息已发出，请到飞书群查看");
      else message.error(res.message);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setWhTesting(false);
    }
  };

  const handleDeleteWebhook = async (id: string) => {
    await api.deleteFeishuWebhook(id);
    message.success("已删除");
    reloadWebhooks();
  };

  const handleSetMode = async (mode: FeishuNotifyMode) => {
    setModeSaving(true);
    try {
      await api.setFeishuNotifyMode(mode);
      setNotifyMode(mode);
      message.success("发送模式已更新");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setModeSaving(false);
    }
  };

  const handleSave = async () => {
    if (!appId.trim()) { message.warning("App ID 必填"); return; }
    if (!appSecret.trim() && !cfg?.configured) { message.warning("首次配置需填写 App Secret"); return; }
    setSaving(true);
    try {
      await api.saveFeishuSettings({
        name: name.trim(),
        app_id: appId.trim(),
        app_secret: appSecret.trim(),
        encrypt_key: encryptKey.trim(),
        verification_token: verificationToken.trim(),
      });
      message.success("飞书应用配置已保存");
      setAppSecret(""); setEncryptKey(""); setVerificationToken("");
      setLoading(true); reload();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <div style={{ maxWidth: 760 }}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 20 }}
        message="两种推送方式：① 群机器人（下面绿框，2 分钟、零应用依赖）② 企业自建应用（本表单，支持私信到个人）"
        description="日常提醒推荐先用①跑起来；需要私信、精准通知某人时再配②（BYOK：各企业客户用各自的飞书应用，敏感凭证加密存储）。不清楚怎么配？任选一个展开下方「接入指引」按步骤操作。"
      />
      <div style={{ marginBottom: 16 }}>
        <Space>
          <Typography.Text type="secondary">当前状态：</Typography.Text>
          {cfg?.configured ? <Tag color="green">已配置{cfg.app_id ? ` · ${cfg.app_id}` : ""}</Tag> : <Tag color="default">未配置</Tag>}
        </Space>
      </div>
      <div style={{ marginBottom: 16 }}>
        <FieldLabel extra="选填，便于识别">应用名称</FieldLabel>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：XX 公司飞书" />
      </div>
      <div style={{ marginBottom: 16 }}>
        <FieldLabel>App ID</FieldLabel>
        <Input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="cli_ 开头的应用 ID" />
      </div>
      <div style={{ marginBottom: 16 }}>
        <FieldLabel>App Secret</FieldLabel>
        <Input.Password value={appSecret} onChange={(e) => setAppSecret(e.target.value)}
          placeholder={cfg?.configured ? "已配置，留空则不修改；更换请重新输入" : "飞书应用的 App Secret"} autoComplete="off" />
      </div>
      <div style={{ marginBottom: 16 }}>
        <FieldLabel extra="选填；用于解密飞书事件回调">Encrypt Key</FieldLabel>
        <Input.Password value={encryptKey} onChange={(e) => setEncryptKey(e.target.value)}
          placeholder={cfg?.has_encrypt_key ? "已配置，留空则不修改" : "事件订阅的 Encrypt Key"} autoComplete="off" />
      </div>
      <div style={{ marginBottom: 16 }}>
        <FieldLabel extra="选填；用于校验飞书事件回调">Verification Token</FieldLabel>
        <Input.Password value={verificationToken} onChange={(e) => setVerificationToken(e.target.value)}
          placeholder={cfg?.has_verification_token ? "已配置，留空则不修改" : "事件订阅的 Verification Token"} autoComplete="off" />
      </div>
      <Button type="primary" loading={saving} disabled={loading} onClick={handleSave} style={{ marginBottom: 24 }}>保存</Button>

      {/* ---- 群机器人：零应用依赖的推送通道（比上方应用配置简单得多） ---- */}
      <Card
        size="small"
        style={{ marginBottom: 24, borderColor: "#b7eb8f" }}
        title={<Space><span>🚀 更简单的方案：群机器人推送</span><Tag color="green">2 分钟搞定 · 无需飞书应用</Tag></Space>}
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 13 }}>
            在飞书群里「设置 → 群机器人 → 添加自定义机器人」复制 webhook 地址，贴到下面保存即可——
            <b>不用建应用、不用填凭证、不用配权限、不用发版、不用扫码</b>，提醒直接发到群里。
            代价：消息<b>群里全员可见</b>，不能私信个人、不能精准 @ 某人。适合日常提醒先跑起来；私密提醒用上面的应用推送。
          </Typography.Paragraph>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
            <Input
              style={{ width: 200 }}
              value={whName}
              onChange={(e) => setWhName(e.target.value)}
              placeholder="备注名（如：HR 通知群）"
            />
            <Input
              style={{ width: 380 }}
              value={whUrl}
              onChange={(e) => setWhUrl(e.target.value)}
              placeholder="webhook 地址：https://open.feishu.cn/open-apis/bot/v2/hook/..."
            />
            <Button type="primary" loading={whSaving} onClick={handleSaveWebhook}>保存</Button>
            <Button loading={whTesting} onClick={() => handleTestWebhook({ url: whUrl.trim() })}>先测试再保存</Button>
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            地址含密钥，保存时加密存储；「先测试再保存」不会写入系统，仅验证地址能否用。
          </Typography.Text>
          {webhooks.length > 0 && (
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={webhooks}
              columns={[
                { title: "名称", dataIndex: "name" },
                {
                  title: "状态", dataIndex: "enabled",
                  render: (v: number) => (v ? <Tag color="green">启用中</Tag> : <Tag>已停用</Tag>),
                },
                { title: "添加时间", dataIndex: "created_at", render: (v: string) => v?.slice(0, 16) },
                {
                  title: "操作",
                  render: (_: unknown, row: FeishuWebhook) => (
                    <Space>
                      <Button size="small" loading={whTesting} onClick={() => handleTestWebhook({ id: row.id })}>测试</Button>
                      <Popconfirm title="删除该群机器人？之后提醒不再发到这个群" onConfirm={() => handleDeleteWebhook(row.id)}>
                        <Button size="small" danger>删除</Button>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
          )}
          <div>
            <Typography.Text strong style={{ display: "block", marginBottom: 8 }}>提醒发送到哪：</Typography.Text>
            <Radio.Group
              value={notifyMode}
              onChange={(e) => handleSetMode(e.target.value as FeishuNotifyMode)}
              disabled={modeSaving}
            >
              <Radio value="personal">仅个人（各自按绑定渠道收，默认）</Radio>
              <Radio value="group">仅群（配了群机器人时全员群里收，不发个人）</Radio>
              <Radio value="both">群 + 个人（两个通道都发）</Radio>
            </Radio.Group>
          </div>
        </Space>
      </Card>

      <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="需在飞书后台配置以下回调地址" />
      <div style={{ marginBottom: 8 }}>
        <Typography.Text type="secondary">OAuth 重定向 URL：</Typography.Text>
        <Typography.Text copyable code>{origin}/api/feishu/oauth/callback</Typography.Text>
      </div>
      <div style={{ marginBottom: 16 }}>
        <Typography.Text type="secondary">事件订阅请求 URL：</Typography.Text>
        <Typography.Text copyable code>{origin}/api/feishu/event</Typography.Text>
      </div>

      <Collapse
        style={{ marginBottom: 24 }}
        items={[
          {
            key: "guide",
            label: "接入指引：两种方式按需选（群机器人约 2 分钟 / 应用私信约 10 分钟）",
            children: (
              <Space direction="vertical" size={20} style={{ width: "100%" }}>
                {/* 方式 A：群机器人 */}
                <div style={{ background: "#f6ffed", border: "1px solid #b7eb8f", borderRadius: 8, padding: "12px 16px" }}>
                  <Typography.Title level={5} style={{ marginBottom: 8 }}>方式 A · 群机器人推送（推荐先配，日常提醒够用）</Typography.Title>
                  <ol style={{ paddingLeft: 20, margin: 0, lineHeight: 2 }}>
                    <li>打开要收提醒的飞书群 → 右上角<b>设置 → 群机器人 → 添加机器人 → 自定义机器人</b>（起个名字，如「HR 通知」）。</li>
                    <li>添加完成后复制 <b>webhook 地址</b>（形如 https://open.feishu.cn/open-apis/bot/v2/hook/…），点「完成」。</li>
                    <li>回到本页上方<b>绿色卡片</b>：粘贴地址 → 先点「先测试再保存」→ 群里能看到测试消息 → 点「保存」。</li>
                    <li>在同一卡片选发送方式：「仅群」或「群 + 个人」。</li>
                  </ol>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>零应用、零绑定、新成员无操作；代价是消息群里全员可见、不能私信个人。</Typography.Text>
                </div>

                {/* 方式 B：应用私信 */}
                <div>
                  <Typography.Title level={5} style={{ marginBottom: 8 }}>方式 B · 应用私信推送（需要精准通知到个人时）</Typography.Title>
                  <Space direction="vertical" size={20} style={{ width: "100%" }}>
                    <div>
                      <Typography.Text strong>第一步 · 创建飞书应用并开启「机器人」能力</Typography.Text>
                      <ol style={{ paddingLeft: 20, margin: 0, lineHeight: 2 }}>
                        <li>打开 <Typography.Link href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">飞书开发者后台</Typography.Link>，点「创建企业自建应用」（个人飞书账号即可创建，免费，无需企业主体认证）。</li>
                        <li>进入应用 → 「凭证与基础信息」→ 复制 <b>App ID</b>（cli_ 开头）和 <b>App Secret</b>；<b>Encrypt Key 与 Verification Token 留空</b>（事件订阅二期才用）。</li>
                        <li>回到本页上方表单：名称随意（如「XX 公司飞书」），粘贴 App ID / App Secret 后保存。</li>
                        <li>
                          <b>回飞书后台给应用添加「机器人」能力</b>（<Typography.Text type="danger">最容易漏、漏了发消息就报 230006</Typography.Text>）：应用页 → 「添加应用能力」→ 添加<b>机器人</b> → 保存。
                        </li>
                      </ol>
                      {cfg?.app_id && (
                        <div style={{ marginTop: 8 }}>
                          <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
                            已识别到 App ID，下面按钮直达该应用在飞书后台的对应页面，省得自己找菜单：
                          </Typography.Text>
                          <Space wrap size={4}>
                            <Button size="small" href={`https://open.feishu.cn/app/${cfg.app_id}/baseinfo`} target="_blank" rel="noreferrer">① 凭证与基础信息</Button>
                            <Button size="small" href={`https://open.feishu.cn/app/${cfg.app_id}/safe`} target="_blank" rel="noreferrer">② 安全设置（重定向 URL）</Button>
                            <Button size="small" href={`https://open.feishu.cn/app/${cfg.app_id}/auth`} target="_blank" rel="noreferrer">③ 权限管理</Button>
                            <Button size="small" href={`https://open.feishu.cn/app/${cfg.app_id}/version`} target="_blank" rel="noreferrer">④ 版本发布</Button>
                          </Space>
                        </div>
                      )}
                    </div>
                    <div>
                      <Typography.Text strong>第二步 · 回飞书后台配两个地址（缺一不可）</Typography.Text>
                      <ol style={{ paddingLeft: 20, margin: 0, lineHeight: 2 }}>
                        <li>
                          「安全设置 → 重定向 URL」→ 添加下面这个地址（必须是完整路径，<b>不要带 # 或 ? 后缀</b>）：
                          <br /><Typography.Text copyable code>{origin}/api/feishu/oauth/callback</Typography.Text>
                          <br /><Typography.Text type="secondary" style={{ fontSize: 12 }}>漏配的后果：授权后跳不回来，报错 redirect_uri unmatch。</Typography.Text>
                        </li>
                        <li>
                          「应用功能 → 网页」→ 启用网页能力 → 网页地址填：
                          <br /><Typography.Text copyable code>{origin}</Typography.Text>
                          <br /><Typography.Text type="secondary" style={{ fontSize: 12 }}>漏配的后果：成员弹窗里的二维码显示不出来。</Typography.Text>
                        </li>
                      </ol>
                    </div>
                    <div>
                      <Typography.Text strong>第三步 · 开 im:message 权限并发布版本</Typography.Text>
                      <ol style={{ paddingLeft: 20, margin: 0, lineHeight: 2 }}>
                        <li>「权限管理 → API 权限」→ 搜索 <Typography.Text code>im:message</Typography.Text> → 开通「给用户发送消息」→ 可用范围选「全员」（不含某成员时，该成员绑定了也收不到）。</li>
                        <li>「版本管理与发布」→ 创建版本 → 申请发布。<b>任何改动（含添加机器人能力）都要发版后才生效</b>；企业若开启了应用审核，需管理员在飞书管理后台「工作台 → 应用审核」通过。</li>
                      </ol>
                    </div>
                    <div>
                      <Typography.Text strong>第四步 · 成员绑定并验证</Typography.Text>
                      <ol style={{ paddingLeft: 20, margin: 0, lineHeight: 2 }}>
                        <li>成员（含管理员自己）有两种入口：点<b>右上角飞书图标</b>，或点右上角头像 →「飞书推送设置」。</li>
                        <li>弹窗左侧是飞书官方授权页：<b>没登录飞书的浏览器显示二维码</b>——用飞书 App 扫一扫、在手机上确认；<b>已登录飞书的浏览器直接显示「授权信息」确认页</b>——点「同意授权」即可。两条路都会自动返回本系统，并在绑定前再确认一次账号。</li>
                        <li>想强制走扫码（比如电脑登录的是别人的飞书）：点弹窗里「复制绑定链接」，用浏览器隐私窗口（Ctrl+Shift+N）打开，必出二维码。</li>
                        <li>出现「已绑定」绿标后点「发送测试」，飞书能收到消息即全链路打通。</li>
                      </ol>
                    </div>
                  </Space>
                </div>
              </Space>
            ),
          },
          {
            key: "faq",
            label: "排障：出问题先看这里",
            children: (
              <ul style={{ paddingLeft: 20, margin: 0, lineHeight: 2 }}>
                <li><b>只想最快收到提醒、不想配应用</b>：用上面绿框的群机器人方案，飞书群里加个自定义机器人、粘贴 webhook 即可，上面的应用表单可以完全跳过。</li>
                <li><b>群机器人测试报 230006</b>：机器人在群里被关闭，或企业禁用了自定义机器人能力——群设置 → 群机器人 → 确认该机器人已开启；不行就删了重加一个。</li>
                <li><b>群机器人其他报错</b>：19021=需要包含约定关键词（给机器人配关键词或在安全设置里关掉）；19022=开了签名校验（暂不支持，请关闭签名）；19024=机器人已被移出群。</li>
                <li><b>应用私信测试报 230006 Bot ability is not activated</b>：应用没开「机器人」能力——开发者后台 → 应用 →「添加应用能力」→ 添加「机器人」→ 保存 → 去「版本管理与发布」发版（对照方式 B 第一步）。</li>
                <li><b>二维码区域提示「尚未配置飞书应用」</b>：本页 App ID / App Secret 还没保存成功，先完成方式 B 第一步。</li>
                <li><b>二维码不显示或空白</b>：网页能力没启用、应用没发布、或重定向 URL 漏配——对照方式 B 第二步。</li>
                <li><b>点「重新加载」出来的不是二维码、而是「授权信息」确认页</b>：这是正常的——此浏览器已经登录过飞书，飞书会跳过扫码直接让你确认（和之前「授权出别人账号」是同一根因：浏览器旧登录态被默认带出）。直接点「同意授权」即可；想强制扫码就「复制绑定链接」→ 隐私窗口打开。</li>
                <li><b>授权时报 redirect_uri unmatch</b>：重定向 URL 没添加，或填了带 # / ? 后缀的地址。</li>
                <li><b>授权页报 20027</b>：请求了未开通的权限（本系统只用 im:message 一项）。</li>
                <li><b>绑定成功但收不到提醒</b>：im:message 权限未发版生效，或应用可用范围不含该成员；也可能是发送模式选了「仅群」而群机器人未配置。</li>
                <li><b>想停止给某人推送</b>：目前需管理员到数据库把该用户的 notify_channel 置空（解绑/切回 PushPlus 的界面排期中）。</li>
              </ul>
            ),
          },
        ]}
      />
    </div>
  );
}

export default function Settings() {
  // 后续再有全局配置（例如老带新奖励天数）直接加新 Tab，不必再动菜单
  const items = [
    { key: "pay", label: "收款码设置", children: <PaySettings /> },
    { key: "dict", label: "数据字典", children: <DictSettings /> },
    { key: "ai", label: "AI 配额", children: <AiQuotaSettings /> },
    { key: "feishu", label: "飞书集成", children: <FeishuSettingsPanel /> },
    { key: "changelog", label: "更新公告", children: <ChangelogSettings /> },
  ];

  // 支持 ?tab=feishu 直达（顶栏飞书入口「去配置」跳这里）；参数无效时回落收款码
  const [params] = useSearchParams();
  const tabFromUrl = params.get("tab");
  const [tab, setTab] = useState(() => (tabFromUrl && items.some((i) => i.key === tabFromUrl) ? tabFromUrl : "pay"));
  useEffect(() => {
    const t = params.get("tab");
    if (t && items.some((i) => i.key === t)) setTab(t);
  }, [params]);

  return (
    <div className="page-fill">
      <Card>
        <Tabs className="app-pill-tabs" activeKey={tab} onChange={setTab} items={items} />
      </Card>
    </div>
  );
}
