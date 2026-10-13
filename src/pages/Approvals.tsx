import { useState, useEffect, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import {
  Card, Tabs, Table, Button, Space, Tag, Modal, Form, Input, message,
  Popconfirm, Empty, Typography, Alert, Steps, Select,
} from "antd";
import { PlusOutlined, ReloadOutlined, RobotOutlined } from "@ant-design/icons";
import { api } from "../api";
import AiThinking from "../components/AiThinking";
import { TypeText } from "../utils/useTypewriter";
import type { ApprovalFlow, ApprovalInstance, AiApprovalSummary } from "../types";

// 让列表（表格）撑满 Tab 内容区剩余高度：表头固定、表体内部滚动，避免一屏只露几行留大片空白。
// 取容器高度减去 antd size="middle" 表头（约 47px）作为 scroll.y；低于下限则退回自然高度。
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

// ---- 流程模板配置 ----
function FlowSettings() {
  const [flows, setFlows] = useState<ApprovalFlow[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const [hostRef, scrollY] = useTableFill();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getApprovalFlows();
      setFlows(r.items);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await api.createApprovalFlow(v);
      message.success("审批流程已创建");
      setOpen(false);
      form.resetFields();
      load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="appr-pane">
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="在这里配置你公司的审批环节，例如「HR 主管审批 → 用人部门确认 → 总经理批准」。发起 Offer 审批时会按这里的步骤逐级流转；不配置则默认一步审批。"
      />
      <div className="toolbar">
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setOpen(true); }}>
            新建流程
          </Button>
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
      </div>
      <div ref={hostRef} className="appr-table-host">
      <Table<ApprovalFlow>
        className="profiles-table"
        rowKey="id"
        dataSource={flows}
        loading={loading}
        size="middle"
        pagination={false}
        scroll={flows.length ? { y: scrollY } : undefined}
        locale={{ emptyText: <Empty description="还没有审批流程，点上方「新建流程」按你公司的流程建一个" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        columns={[
          { title: "流程名称", dataIndex: "name", key: "name", width: 180 },
          {
            title: "审批环节",
            key: "steps",
            render: (_: unknown, r: ApprovalFlow) => (
              <Space size={4} wrap>
                {r.steps.length === 0 ? <Typography.Text type="secondary">—</Typography.Text> : r.steps.map((s, i) => (
                  <Tag key={i} color="blue">{i + 1}. {s.name}</Tag>
                ))}
              </Space>
            ),
          },
          {
            title: "操作",
            key: "act",
            width: 90,
            align: "center",
            render: (_: unknown, r: ApprovalFlow) => (
              <Popconfirm title="删除该流程？" description="已发起的审批不受影响。" onConfirm={async () => {
                try { await api.deleteApprovalFlow(r.id); message.success("已删除"); load(); }
                catch (e) { message.error((e as Error).message); }
              }} okText="删除" cancelText="取消">
                <Button type="link" size="small" danger style={{ paddingInline: 0 }}>删除</Button>
              </Popconfirm>
            ),
          },
        ]}
      />
      </div>

      <Modal title="新建审批流程" open={open} onCancel={() => setOpen(false)} onOk={handleSave}
        confirmLoading={saving} okText="创建" cancelText="取消" destroyOnClose>
        <Form form={form} layout="vertical" initialValues={{ steps: [{ name: "HR 主管审批" }] }}>
          <Form.Item name="name" label="流程名称" rules={[{ required: true, message: "请填写流程名称" }]}>
            <Input placeholder="如：Offer 审批流程" />
          </Form.Item>
          <Form.Item name="scene" label="适用场景" rules={[{ required: true }]}>
            <Select options={[{ value: "offer", label: "Offer 审批" }, { value: "onboard", label: "入职审批" }]} />
          </Form.Item>
          <Form.List name="steps">
            {(fields, { add, remove }) => (
              <>
                <Typography.Text strong>审批环节（按顺序逐级审批）</Typography.Text>
                {fields.map((f, i) => (
                  <Space key={f.key} style={{ display: "flex", marginTop: 8 }}>
                    <Form.Item {...f} name={[f.name, "name"]} rules={[{ required: true, message: "请填写环节名" }]}
                      style={{ marginBottom: 0, flex: 1 }}>
                      <Input placeholder={`第 ${i + 1} 级审批，如：HR 主管审批`} />
                    </Form.Item>
                    {fields.length > 1 ? (
                      <Button type="link" danger size="small" onClick={() => remove(f.name)}>删除</Button>
                    ) : null}
                  </Space>
                ))}
                <Button type="dashed" block icon={<PlusOutlined />} style={{ marginTop: 8 }} onClick={() => add({ name: "" })}>
                  添加环节
                </Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>
    </div>
  );
}

// ---- 审批实例（待办）----
function InstanceList() {
  const [items, setItems] = useState<ApprovalInstance[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | undefined>("pending");
  const [hostRef, scrollY] = useTableFill();
  const [decideTarget, setDecideTarget] = useState<ApprovalInstance | null>(null);
  const [decision, setDecision] = useState<"approve" | "reject">("approve");
  const [comment, setComment] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getApprovalInstances({ status });
      setItems(r.items);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  // AI 审批摘要：后端按实例自查上下文（候选人/岗位/快照/前级意见），生成「10 秒读卡」。
  // AI 只摆事实不给倾向性结论，批准/驳回由审批人独立决策；失败降级为基础信息提示。
  const [aiSum, setAiSum] = useState<{ loading: boolean; data: AiApprovalSummary | null; err: string }>({
    loading: false, data: null, err: "",
  });
  const genSummary = async () => {
    if (!decideTarget) return;
    setAiSum({ loading: true, data: null, err: "" });
    try {
      const r = await api.aiApprovalSummary(decideTarget.id);
      setAiSum({ loading: false, data: r, err: "" });
    } catch (e) {
      setAiSum({ loading: false, data: null, err: (e as Error).message || "生成失败，请稍后重试" });
    }
  };

  const handleDecide = async () => {
    if (!decideTarget) return;
    try {
      const r = await api.decideApproval(decideTarget.id, decision, comment);
      if (decision === "approve") {
        // 通过后系统自动往下走：把联动结果回显出来，别让 HR 猜「批完之后发生了什么」
        const notes = r.downstream || [];
        message.success(notes.length > 0 ? `已通过；${notes.join("；")}` : "已通过");
      } else {
        message.success("已驳回");
      }
      setDecideTarget(null);
      setComment("");
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const handleCancel = async (row: ApprovalInstance) => {
    try {
      await api.cancelApproval(row.id);
      message.success("已撤回");
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  return (
    <div className="appr-pane">
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="审批通过后系统会自动往下走：Offer 审批通过 → 候选人自动流转到「已入职」，并自动生成入职材料清单与试用期跟进待办，无需再去手工操作一遍。"
      />
      <div className="toolbar">
        <Space>
          <Select
            style={{ width: 200 }}
            value={status}
            onChange={setStatus}
            options={[
              { value: "pending", label: "审批中" },
              { value: "approved", label: "已通过" },
              { value: "rejected", label: "已驳回" },
              { value: undefined, label: "全部" },
            ]}
          />
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
      </div>

      <div ref={hostRef} className="appr-table-host">
      <Table<ApprovalInstance>
        className="profiles-table"
        rowKey="id"
        dataSource={items}
        loading={loading}
        size="middle"
        scroll={items.length ? { y: scrollY } : undefined}
        locale={{ emptyText: <Empty description="暂无审批记录" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        columns={[
          {
            title: "审批事项",
            key: "title",
            render: (_: unknown, r: ApprovalInstance) => (
              <div>
                <div>{r.title}</div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  候选人：<Link to={`/talents/${r.talent_id}`}>{r.talent_name}</Link>
                  {r.job_title ? ` · ${r.job_title}` : ""} · 发起人 {r.owner_name}
                </Typography.Text>
              </div>
            ),
          },
          {
            title: "进度",
            key: "progress",
            width: 220,
            render: (_: unknown, r: ApprovalInstance) => {
              if (r.status !== "pending") {
                return <Tag color={r.status === "approved" ? "green" : r.status === "rejected" ? "red" : "default"}>{r.status_label}</Tag>;
              }
              const total = r.steps.length;
              return (
                <Steps
                  size="small"
                  current={r.current_step}
                  style={{ maxWidth: 220 }}
                  items={r.steps.map((s) => ({ title: s.step_name }))}
                />
              );
            },
          },
          {
            title: "操作",
            key: "act",
            width: 150,
            align: "center",
            render: (_: unknown, r: ApprovalInstance) =>
              r.status === "pending" ? (
                <Space size={12}>
                  <Button type="link" size="small" style={{ paddingInline: 0 }}
                    onClick={() => { setDecideTarget(r); setDecision("approve"); setAiSum({ loading: false, data: null, err: "" }); }}>
                    处理
                  </Button>
                  <Popconfirm
                    title="撤回这条审批？"
                    description="撤回后该审批直接结束，需要重新发起。"
                    onConfirm={() => handleCancel(r)}
                    okText="撤回"
                    cancelText="取消"
                  >
                    <Button type="link" size="small" danger style={{ paddingInline: 0 }}>撤回</Button>
                  </Popconfirm>
                </Space>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {r.steps.filter((s) => s.decision).slice(-1)[0]?.comment || "—"}
                </Typography.Text>
              ),
          },
        ]}
      />
      </div>

      <Modal
        title={decideTarget?.title}
        open={!!decideTarget}
        onCancel={() => setDecideTarget(null)}
        onOk={handleDecide}
        okText={decision === "approve" ? "确认通过" : "确认驳回"}
        cancelText="取消"
        destroyOnClose
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Alert type={decision === "approve" ? "success" : "warning"} showIcon
            message={decision === "approve" ? "通过后进入下一审批环节" : "驳回后该审批结束"} />
          {/* AI 审批摘要：10 秒读卡（批的是什么 + 风险点）；AI 只摆事实，不给批准/驳回的倾向性结论 */}
          {aiSum.loading ? (
            <AiThinking steps={["正在读取审批上下文…", "正在核对候选人与岗位…", "正在提炼风险点…"]} />
          ) : aiSum.data ? (
            <div style={{ border: "1px solid #f0f0f0", borderRadius: 8, padding: 10 }}>
              <div style={{ marginBottom: 4 }}>
                <Tag color="geekblue" icon={<RobotOutlined />}>AI 摘要</Tag>
              </div>
              <div style={{ lineHeight: 1.7 }}><TypeText text={aiSum.data.summary} /></div>
              {aiSum.data.risks.map((r, i) => (
                <div key={i} style={{ marginTop: 4, fontSize: 12, color: "#ad4e00" }}>⚠ <TypeText text={r} /></div>
              ))}
              <Button size="small" type="text" icon={<RobotOutlined />} onClick={genSummary} style={{ marginTop: 4 }}>
                重新生成
              </Button>
            </div>
          ) : (
            <div>
              <Button size="small" icon={<RobotOutlined />} onClick={genSummary} disabled={!decideTarget}>
                AI 摘要：10 秒看懂批的是什么
              </Button>
              {aiSum.err && decideTarget && (
                <div style={{ marginTop: 6, fontSize: 12, color: "#ad6800" }}>
                  AI 暂不可用（{aiSum.err}）。可看：{decideTarget.title}（发起于 {Math.max(0, Math.floor((Date.now() - new Date(decideTarget.created_at.replace(" ", "T") + "Z").getTime()) / 86400000))} 天前，当前第 {(decideTarget.current_step ?? 0) + 1} 环）。
                </div>
              )}
            </div>
          )}
          <Select
            style={{ width: "100%" }}
            value={decision}
            onChange={setDecision}
            options={[{ value: "approve", label: "通过" }, { value: "reject", label: "驳回" }]}
          />
          <Input.TextArea rows={3} value={comment} onChange={(e) => setComment(e.target.value)}
            placeholder="审批意见（选填）" />
        </Space>
      </Modal>
    </div>
  );
}

export default function Approvals() {
  return (
    <div className="page-fill profiles-page approvals-page">
      <Card>
        <Tabs
          className="app-pill-tabs"
          items={[
            { key: "todo", label: "审批待办", children: <InstanceList /> },
            { key: "flows", label: "流程配置", children: <FlowSettings /> },
          ]}
        />
      </Card>
    </div>
  );
}
