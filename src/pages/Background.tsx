import { useState, useEffect, useCallback, useRef } from "react";
import {
  Card, Table, Button, Space, Tag, Modal, Drawer, Form, Input, Select, Switch, Radio,
  message, Popconfirm, Empty, Alert, Divider, Typography, Spin, List, Tooltip,
} from "antd";
import {
  PlusOutlined, ReloadOutlined, SafetyOutlined, UploadOutlined,
  CheckCircleOutlined, StopOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import type { BackgroundCheck } from "../types";
import { BG_STATUS_LABELS, BG_CONSENT_LABELS } from "../types";

// 让列表撑满剩余高度：表头固定、表体内部滚动（与审批/合同页一致）
function useTableFill() {
  const ref = useRef<HTMLDivElement>(null);
  const [y, setY] = useState<number | undefined>(undefined);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const calc = () => {
      const h = el.clientHeight - 47;
      setY(h > 200 ? h : undefined);
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, y] as const;
}

function statusColor(s: string): string {
  return (
    { pending: "default", processing: "blue", completed: "geekblue", passed: "green", failed: "red", cancelled: "default" } as Record<string, string>
  )[s] || "default";
}
function consentColor(c: string): string {
  return (
    { none: "default", requested: "gold", granted: "green", declined: "red" } as Record<string, string>
  )[c] || "default";
}

export default function Background() {
  const [items, setItems] = useState<BackgroundCheck[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [consentFilter, setConsentFilter] = useState<string | undefined>(undefined);
  const [q, setQ] = useState("");
  const [hostRef, scrollY] = useTableFill();

  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<BackgroundCheck | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getBackgroundChecks({
        status: statusFilter, consent: consentFilter, q: q.trim() || undefined,
      });
      setItems(r.items);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, consentFilter, q]);

  useEffect(() => { load(); }, [load]);

  // 打开详情：拉单行最新数据
  const openDetail = async (id: string) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const r = await api.getBackgroundCheck(id);
      setDetail(r.bg);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setDetailLoading(false);
    }
  };

  // 详情变更后同步列表该行
  const syncListRow = (bg: BackgroundCheck) => {
    setItems((prev) => prev.map((x) => (x.id === bg.id ? { ...x, ...bg, status_label: BG_STATUS_LABELS[bg.status], consent_label: BG_CONSENT_LABELS[bg.consent_status] } : x)));
  };

  return (
    <div className="page-fill profiles-page background-page">
      <Card>
        <div className="toolbar">
          <Space wrap>
            <Select
              allowClear placeholder="状态" style={{ width: 140 }}
              value={statusFilter} onChange={setStatusFilter}
              options={Object.entries(BG_STATUS_LABELS).map(([v, l]) => ({ value: v, label: l }))}
            />
            <Select
              allowClear placeholder="授权" style={{ width: 150 }}
              value={consentFilter} onChange={setConsentFilter}
              options={Object.entries(BG_CONSENT_LABELS).map(([v, l]) => ({ value: v, label: l }))}
            />
            <Input.Search
              allowClear placeholder="搜索候选人 / 岗位"
              value={q} onChange={(e) => setQ(e.target.value)}
              onSearch={load} style={{ width: 220 }}
            />
          </Space>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建背调
            </Button>
          </Space>
        </div>

        <div ref={hostRef} className="bg-table-host">
          <Table<BackgroundCheck>
            className="profiles-table"
            rowKey="id"
            dataSource={items}
            loading={loading}
            size="middle"
            pagination={false}
            scroll={items.length ? { y: scrollY } : undefined}
            locale={{ emptyText: <Empty description="还没有背调记录，点右上角「新建背调」开始" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            columns={[
              {
                title: "候选人 / 岗位",
                key: "who",
                render: (_: unknown, r: BackgroundCheck) => (
                  <div>
                    <div>{r.talent_name}{r.high_risk ? <Tag color="red" style={{ marginLeft: 6 }}>高敏</Tag> : null}</div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {r.job_title ? `应聘：${r.job_title}` : "未关联岗位"} · 发起人 {r.owner_name}
                    </Typography.Text>
                  </div>
                ),
              },
              {
                title: "状态", dataIndex: "status", key: "status", width: 100,
                render: (s: string) => <Tag color={statusColor(s)}>{BG_STATUS_LABELS[s] || s}</Tag>,
              },
              {
                title: "授权", dataIndex: "consent_status", key: "consent", width: 120,
                render: (c: string) => <Tag color={consentColor(c)}>{BG_CONSENT_LABELS[c] || c}</Tag>,
              },
              {
                title: "报告", key: "report", width: 90, align: "center",
                render: (_: unknown, r: BackgroundCheck) =>
                  r.has_report ? <Typography.Text type="success">已上传</Typography.Text> : <Typography.Text type="secondary">—</Typography.Text>,
              },
              {
                title: "结论", key: "result", width: 90, align: "center",
                render: (_: unknown, r: BackgroundCheck) =>
                  r.result === "pass" ? <Tag color="green">建议通过</Tag>
                    : r.result === "fail" ? <Tag color="red">建议不通过</Tag>
                      : <Typography.Text type="secondary">—</Typography.Text>,
              },
              {
                title: "操作", key: "act", width: 140, align: "center",
                render: (_: unknown, r: BackgroundCheck) => (
                  <Space size={12}>
                    <Button type="link" size="small" style={{ paddingInline: 0 }} onClick={() => openDetail(r.id)}>
                      查看
                    </Button>
                    {r.status !== "passed" && (
                      <Popconfirm
                        title="取消该背调？" description="已上传的报告原件会被一并删除，操作不可恢复。"
                        onConfirm={async () => {
                          try { await api.bgCancel(r.id); message.success("已取消"); await load(); }
                          catch (e) { message.error((e as Error).message); }
                        }} okText="取消背调" cancelText="返回"
                      >
                        <Button type="link" size="small" danger style={{ paddingInline: 0 }}>取消</Button>
                      </Popconfirm>
                    )}
                    {r.status === "passed" ? (
                      <Tooltip title="已通过并入职的背调不可删除（合规留痕）">
                        <span>
                          <Button type="link" size="small" danger disabled style={{ paddingInline: 0 }}>删除</Button>
                        </span>
                      </Tooltip>
                    ) : (
                      <Popconfirm
                        title="删除该背调？" description="背调记录、核验项与报告原件将被永久删除，操作不可恢复。"
                        onConfirm={async () => {
                          try { await api.deleteBackgroundCheck(r.id); message.success("已删除"); await load(); }
                          catch (e) { message.error((e as Error).message); }
                        }} okText="删除" cancelText="返回"
                      >
                        <Button type="link" size="small" danger style={{ paddingInline: 0 }}>删除</Button>
                      </Popconfirm>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        </div>
      </Card>

      <CreateModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={async (bg) => { setCreateOpen(false); await load(); openDetail(bg.id); }} />

      <Drawer
        title={detail ? `背调详情 · ${detail.talent_name}` : "背调详情"}
        width={760}
        open={!!detail}
        onClose={() => setDetail(null)}
      >
        {detailLoading ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
            <Spin size="large" />
          </div>
        ) : detail && (
          <DetailPane
            bg={detail}
            onChange={(next) => { setDetail(next); syncListRow(next); }}
            onReload={() => openDetail(detail.id)}
            onDeleted={() => { setDetail(null); load(); }}
          />
        )}
      </Drawer>
    </div>
  );
}

// ============ 新建背调 ============
function CreateModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (bg: BackgroundCheck) => void }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [talentOpts, setTalentOpts] = useState<{ value: string; label: string; phone?: string }[]>([]);
  const [jobOpts, setJobOpts] = useState<{ value: string; label: string }[]>([]);
  const [talentId, setTalentId] = useState<string | undefined>();

  // 远程搜索候选人
  const searchTalent = async (kw: string) => {
    try {
      const r = await api.getTalents({ q: kw, page: 1, limit: 20 });
      setTalentOpts(r.items.map((t) => ({ value: t.id, label: t.name, phone: t.phone || undefined })));
    } catch { /* 静默 */ }
  };
  useEffect(() => { if (open) { searchTalent(""); form.resetFields(); setTalentId(undefined); setJobOpts([]); } }, [open]);

  const onPickTalent = async (id: string) => {
    setTalentId(id);
    setJobOpts([]);
    form.setFieldValue("talent_job_id", undefined);
    try {
      const t = await api.getTalent(id);
      setJobOpts(t.pipeline.map((p) => ({ value: p.id, label: `${p.job_title}（${p.stage}）` })));
    } catch { /* 静默 */ }
  };

  const handleCreate = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      const r = await api.createBackgroundCheck({
        talent_id: v.talent_id,
        talent_job_id: v.talent_job_id || undefined,
        provider: v.provider || undefined,
        high_risk: !!v.high_risk,
      });
      message.success("已发起背调（草稿），记得先取得候选人授权");
      onCreated(r.bg);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="新建背调" open={open} onCancel={onClose} onOk={handleCreate} confirmLoading={saving} okText="发起" cancelText="取消" destroyOnClose>
      <Alert
        type="warning" showIcon style={{ marginBottom: 16 }}
        message="合规提示：发起背调前必须取得候选人的单独明示授权。本步骤先建草稿，随后请在详情页完成「授权」闸门，未授权前无法上传报告与填写结论。"
      />
      <Form form={form} layout="vertical" initialValues={{ provider: "内部人工" }}>
        <Form.Item name="talent_id" label="候选人" rules={[{ required: true, message: "请选择候选人" }]}>
          <Select
            showSearch placeholder="搜索候选人姓名" filterOption={false}
            onSearch={searchTalent} onSelect={onPickTalent}
            options={talentOpts} optionFilterProp="label"
          />
        </Form.Item>
        <Form.Item name="talent_job_id" label="关联投递（可选）">
          <Select allowClear placeholder={talentId ? "选择该候选人的投递记录" : "请先选择候选人"} disabled={!talentId}
            options={jobOpts} />
        </Form.Item>
        <Form.Item name="provider" label="背调执行方">
          <Input placeholder="如：内部人工 / 某第三方机构" />
        </Form.Item>
        <Form.Item name="high_risk" label="含高敏项" valuePropName="checked"
          tooltip="勾选后将加入犯罪记录 / 征信核查。这类信息敏感度极高，授权时需候选人二次明示确认。">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ============ 详情面板（核心交互）============
function DetailPane({ bg, onChange, onReload, onDeleted }: { bg: BackgroundCheck; onChange: (b: BackgroundCheck) => void; onReload: () => void; onDeleted: () => void }) {
  const granted = bg.consent_status === "granted";
  const [summary, setSummary] = useState(bg.summary || "");
  const [result, setResult] = useState<"pass" | "fail" | undefined>(bg.result || undefined);
  const [busy, setBusy] = useState(false);

  // 授权表单
  const [grantOpen, setGrantOpen] = useState(false);
  const [grantMethod, setGrantMethod] = useState("书面授权书");
  const [grantHighRisk, setGrantHighRisk] = useState(false);

  useEffect(() => { setSummary(bg.summary || ""); setResult(bg.result || undefined); }, [bg.id]);

  const patch = async (data: Partial<{ provider: string; high_risk: boolean; summary: string; result: string; status: string }>, reload = true) => {
    try {
      const r = await api.updateBackgroundCheck(bg.id, data);
      if (r.bg) onChange(r.bg);
      else if (reload) onReload();
      return r.bg;
    } catch (e) { message.error((e as Error).message); return null; }
  };

  const doConsent = async (action: "request" | "grant" | "decline", extra: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      await api.bgConsent(bg.id, { action, ...extra });
      message.success(action === "grant" ? "已记录候选人授权" : action === "request" ? "已标记发送授权请求" : "已记录候选人拒绝");
      setGrantOpen(false);
      onReload();
    } catch (e) { message.error((e as Error).message); }
    finally { setBusy(false); }
  };

  const onUpload = async (file: File) => {
    setBusy(true);
    try {
      const r = await api.bgUploadReport(bg.id, file);
      message.success("报告已上传");
      if (r.bg) onChange(r.bg); else onReload();
    } catch (e) { message.error((e as Error).message); }
    finally { setBusy(false); }
  };

  // 报告原件预览 / 下载：先 fetch 拿 blob（带 Authorization），再转本地 URL。
  // 不能直接拼 URL 给 <a href>——浏览器直开不带凭证，会被菜单守卫拦成 401。
  const viewReport = async (download: boolean) => {
    setBusy(true);
    try {
      const { blob, name } = await api.bgFetchReport(bg.id);
      const url = URL.createObjectURL(blob);
      if (download) {
        const a = document.createElement("a");
        a.href = url;
        a.download = name || bg.report_name || "背调报告";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        message.success("已开始下载");
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
        // 预览需要时间加载，延后释放，避免打开瞬间失效
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } catch (e) { message.error((e as Error).message); }
    finally { setBusy(false); }
  };

  const onResult = async (val: "pass" | "fail") => {
    setResult(val);
    await patch({ result: val });
  };

  const onPass = async () => {
    setBusy(true);
    try {
      const r = await api.bgPass(bg.id);
      message.success(r.downstream.length ? `已通过并入职；${r.downstream.join("；")}` : "已通过并入职");
      onReload();
    } catch (e) { message.error((e as Error).message); }
    finally { setBusy(false); }
  };

  // 硬删除：整条记录 + KV 报告原件一起没；后端对「已通过」直接 400
  const onDelete = async () => {
    setBusy(true);
    try {
      await api.deleteBackgroundCheck(bg.id);
      message.success("已删除");
      onDeleted();
    } catch (e) { message.error((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <Tag color={statusColor(bg.status)}>{BG_STATUS_LABELS[bg.status]}</Tag>
        <Tag color={consentColor(bg.consent_status)}>{BG_CONSENT_LABELS[bg.consent_status]}</Tag>
        {bg.high_risk && <Tag color="red">含高敏项</Tag>}
        {bg.result === "pass" && <Tag color="green">建议通过</Tag>}
        {bg.result === "fail" && <Tag color="red">建议不通过</Tag>}
      </Space>
      {bg.job_title && <Typography.Paragraph type="secondary">应聘岗位：{bg.job_title}</Typography.Paragraph>}

      {/* 合规闸门提示 */}
      {!granted && (
        <Alert
          type="warning" showIcon style={{ marginBottom: 16 }}
          message="尚未取得候选人授权"
          description="依据个人信息保护法，背调须在候选人单独明示授权后方可开展。当前为草稿态，授权前无法上传报告与填写结论。"
        />
      )}

      {/* 授权板块 */}
      <Card size="small" title={<Space><SafetyOutlined />候选人授权</Space>} style={{ marginBottom: 16 }}>
        {granted ? (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Typography.Text>已获授权（方式：{bg.consent_method || "未记录"}，时间：{bg.consent_at || "未知"}）</Typography.Text>
            <Popconfirm title="标记为候选人拒绝？" description="将把该背调置为「已取消」。" onConfirm={() => doConsent("decline")} okText="确认拒绝" cancelText="返回">
              <Button danger size="small" icon={<StopOutlined />}>候选人拒绝</Button>
            </Popconfirm>
          </Space>
        ) : (
          <Space wrap>
            <Button size="small" loading={busy} onClick={() => doConsent("request")}>发送授权请求</Button>
            <Button size="small" type="primary" loading={busy} onClick={() => setGrantOpen(true)}>标记已获授权</Button>
          </Space>
        )}
      </Card>

      <Modal title="标记已获授权" open={grantOpen} onCancel={() => setGrantOpen(false)}
        onOk={() => doConsent("grant", { method: grantMethod, confirm_high_risk: grantHighRisk })}
        confirmLoading={busy} okText="确认授权" cancelText="取消">
        <Form layout="vertical">
          <Form.Item label="授权方式">
            <Select value={grantMethod} onChange={setGrantMethod}
              options={["书面授权书", "电子签署", "邮件确认", "其他"].map((x) => ({ value: x, label: x }))} />
          </Form.Item>
          {bg.high_risk && (
            <Form.Item label="高敏二次确认" tooltip="该背调含犯罪记录 / 征信核查，须确认已取得候选人针对此类信息的二次明示授权">
              <Space>
                <Switch checked={grantHighRisk} onChange={setGrantHighRisk} />
                <Typography.Text type={grantHighRisk ? "success" : "warning"}>
                  {grantHighRisk ? "已确认取得二次明示授权" : "请确认已取得二次明示授权后再勾选"}
                </Typography.Text>
              </Space>
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* 报告原件 */}
      <Card size="small" title="报告原件" style={{ marginBottom: 16 }}>
        {bg.has_report ? (
          <Space wrap>
            <Button type="link" size="small" style={{ paddingInline: 0 }} disabled={busy} onClick={() => viewReport(false)}>
              预览 / 查看
            </Button>
            <Button type="link" size="small" style={{ paddingInline: 0 }} disabled={busy} onClick={() => viewReport(true)}>
              下载
            </Button>
            <Popconfirm title="删除报告原件？" onConfirm={async () => { try { await api.deleteBackgroundReport(bg.id); message.success("已删除"); onReload(); } catch (e) { message.error((e as Error).message); } }} okText="删除" cancelText="返回">
              <Button type="link" size="small" danger>删除</Button>
            </Popconfirm>
            <Typography.Text type="secondary">（{bg.report_name}）</Typography.Text>
          </Space>
        ) : (
          <UploadButton disabled={!granted || busy} onUpload={onUpload} />
        )}
      </Card>

      {/* 结论 */}
      <Card size="small" title="背调结论" style={{ marginBottom: 16 }}>
        <Input.TextArea
          rows={4} value={summary} disabled={!granted}
          onChange={(e) => setSummary(e.target.value)}
          placeholder={granted ? "填写背调小结（可选）" : "需先取得授权"}
          onBlur={() => { if (granted && summary !== (bg.summary || "")) patch({ summary }); }}
        />
        <Divider style={{ margin: "12px 0" }} />
        <Space wrap align="center">
          <Typography.Text strong>背调结论：</Typography.Text>
          <Radio.Group value={result} disabled={!granted}
            onChange={(e) => onResult(e.target.value)} optionType="button"
            options={[{ value: "pass", label: "建议通过" }, { value: "fail", label: "建议不通过" }]} />
        </Space>
      </Card>

      {/* 终态动作 */}
      <Space wrap>
        <Button type="primary" icon={<CheckCircleOutlined />}
          disabled={!granted || result !== "pass" || bg.status === "passed" || busy}
          onClick={onPass}>
          {bg.status === "passed" ? "已通过并入职" : "通过并推进入职"}
        </Button>
        <Popconfirm title="取消该背调？" description="报告原件会被一并删除。" onConfirm={async () => { try { await api.bgCancel(bg.id); message.success("已取消"); onReload(); } catch (e) { message.error((e as Error).message); } }} okText="取消背调" cancelText="返回">
          <Button danger disabled={bg.status === "passed"}>取消背调</Button>
        </Popconfirm>
        {bg.status === "passed" ? (
          <Tooltip title="已通过并入职的背调不可删除（合规留痕）">
            <span><Button danger disabled>删除背调</Button></span>
          </Tooltip>
        ) : (
          <Popconfirm
            title="删除该背调？"
            description="背调记录、核验项与报告原件将被永久删除，操作不可恢复。"
            onConfirm={onDelete} okText="删除" cancelText="返回"
          >
            <Button danger loading={busy}>删除背调</Button>
          </Popconfirm>
        )}
      </Space>
    </div>
  );
}

// 极简上传按钮（避免引入额外 Upload 组件复杂度，直接用隐藏 input）
function UploadButton({ disabled, onUpload }: { disabled: boolean; onUpload: (f: File) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button icon={<UploadOutlined />} disabled={disabled} onClick={() => ref.current?.click()}>上传报告原件</Button>
      <input
        ref={ref} type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ""; }}
      />
    </>
  );
}
