import { useState, useEffect, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import {
  Card, Table, Input, Select, Button, Space, Tag, Modal,
  Form, message, InputNumber, AutoComplete, Alert, Typography,
} from "antd";
import {
  SearchOutlined, ReloadOutlined, BellOutlined, CalculatorOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import type { SocialItem } from "../types";
import { SI_STATUS_LABELS, SI_STATUS_COLORS, STATUS_LABELS } from "../types";

/** 待办动作推导（与后端 socialTaskStmts 同口径）：onboarded=已入职、si=参保状态 */
function deriveAction(r: SocialItem): "add" | "stop" | null {
  const si = r.si_status || "none";
  const onboarded = r.status === "placed" || !!r.hire_date;
  if (onboarded && si === "none") return "add";
  if (!!r.resignation_date && si === "active") return "stop";
  return null;
}

const ACTION_TAG: Record<"add" | "stop", { text: string; color: string }> = {
  add: { text: "待增员", color: "orange" },
  stop: { text: "待减员", color: "red" },
};

// ---- 个税计算器（累计预扣法，7 级超额累进）----
const TAX_BRACKETS: { limit: number; rate: number; deduct: number }[] = [
  { limit: 36000, rate: 0.03, deduct: 0 },
  { limit: 144000, rate: 0.10, deduct: 2520 },
  { limit: 300000, rate: 0.20, deduct: 16920 },
  { limit: 420000, rate: 0.25, deduct: 31920 },
  { limit: 660000, rate: 0.30, deduct: 52920 },
  { limit: 960000, rate: 0.35, deduct: 85920 },
  { limit: Infinity, rate: 0.45, deduct: 181920 },
];

function annualTax(cumulative: number): number {
  if (cumulative <= 0) return 0;
  const b = TAX_BRACKETS.find((x) => cumulative <= x.limit) || TAX_BRACKETS[TAX_BRACKETS.length - 1];
  return Math.max(0, cumulative * b.rate - b.deduct);
}

/** 每月个税测算（税前月薪全年不变、逐月累计预扣） */
function calcTax(salary: number, insurance: number, special: number) {
  const monthlyTaxable = Math.max(0, salary - 5000 - insurance - special);
  const months: { m: number; cumulative: number; tax: number; net: number }[] = [];
  let prevTax = 0;
  let totalTax = 0;
  let totalNet = 0;
  for (let m = 1; m <= 12; m++) {
    const cumulative = monthlyTaxable * m;
    const taxCum = annualTax(cumulative);
    const tax = Math.max(0, taxCum - prevTax);
    prevTax = taxCum;
    totalTax += tax;
    const net = salary - insurance - tax;
    totalNet += net;
    months.push({ m, cumulative, tax, net });
  }
  return { months, totalTax, totalNet, monthlyTaxable };
}

/** 数字滚动计数：结果出现后从 0 平滑滚到目标值（easeOutCubic，避免生硬跳变） */
function AnimatedNumber({
  value, duration = 700, format,
}: {
  value: number;
  duration?: number;
  format: (n: number) => string;
}) {
  const [display, setDisplay] = useState(0);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    const start = performance.now();
    const to = value;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      setDisplay(to * eased);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [value, duration]);
  return <>{format(display)}</>;
}

function TaxCalculatorModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm();
  const [result, setResult] = useState<ReturnType<typeof calcTax> | null>(null);
  const [salary, setSalary] = useState<number | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [resultKey, setResultKey] = useState(0);  // 每次新结果 +1，驱动结果区重新播放入场动画

  const handleCalc = async () => {
    const v = await form.validateFields();
    const s = Number(v.salary) || 0;
    setCalculating(true);
    setResult(null);
    // 短暂延迟给按钮一个加载反馈，结果随后淡入，避免「一点就蹦出来」的生硬感
    setTimeout(() => {
      setSalary(s);
      setResult(calcTax(s, Number(v.insurance) || 0, Number(v.special) || 0));
      setResultKey((k) => k + 1);
      setCalculating(false);
    }, 320);
  };

  const cols = [
    { title: "月份", dataIndex: "m", key: "m", width: 80, render: (m: number) => `${m} 月` },
    { title: "累计应纳税所得额", dataIndex: "cumulative", key: "cumulative", render: (v: number) => `¥${v.toLocaleString("zh-CN")}` },
    { title: "当月预扣个税", dataIndex: "tax", key: "tax", render: (v: number) => <span style={{ color: v > 0 ? "#f59e0b" : undefined }}>¥{v.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}</span> },
    { title: "当月到手", dataIndex: "net", key: "net", render: (v: number) => `¥${v.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}` },
  ];

  return (
    <Modal title="个税计算器（累计预扣法）" open={open} onCancel={onClose} footer={null} width={680} destroyOnClose>
      <Alert
        type="info" showIcon style={{ marginBottom: 16 }}
        message="按税前月薪全年不变估算，起征点 5000 元/月，逐月累计预扣预缴；年度汇算清缴后多退少补。"
      />
      <Form form={form} layout="horizontal" labelCol={{ span: 10 }} wrapperCol={{ span: 14 }}>
        <Form.Item name="salary" label="税前月薪（元）" rules={[{ required: true, message: "请输入税前月薪" }]}>
          <InputNumber style={{ width: "100%" }} min={0} step={1000} placeholder="如 20000" />
        </Form.Item>
        <Form.Item name="insurance" label="五险一金个人缴纳（元/月）" initialValue={0}>
          <InputNumber style={{ width: "100%" }} min={0} step={100} placeholder="个人缴费部分，如 3500" />
        </Form.Item>
        <Form.Item name="special" label="专项附加扣除（元/月）" initialValue={0} extra="子女教育/继续教育/房贷/房租/赡养老人/婴幼儿照护等合计">
          <InputNumber style={{ width: "100%" }} min={0} step={500} placeholder="如 2000" />
        </Form.Item>
        <Form.Item wrapperCol={{ offset: 10, span: 14 }} style={{ marginBottom: 4 }}>
          <Button type="primary" icon={<CalculatorOutlined />} loading={calculating} onClick={handleCalc}>{calculating ? "计算中…" : "计算"}</Button>
        </Form.Item>
      </Form>

      {result && salary != null && (
        <div key={resultKey} className="tax-result" style={{ marginTop: 8 }}>
          <div className="page-stats" style={{ marginBottom: 12 }}>
            <div className="stat tax-stat">
              <div className="stat-num is-neutral">
                <AnimatedNumber value={result.monthlyTaxable} format={(n) => (n > 0 ? `¥${Math.round(n).toLocaleString("zh-CN")}` : "¥0")} />
              </div>
              <div className="stat-label">月应纳税所得额</div>
            </div>
            <div className="stat-sep" />
            <div className="stat tax-stat">
              <div className="stat-num is-bad">
                <AnimatedNumber value={result.totalTax} format={(n) => `¥${n.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}`} />
              </div>
              <div className="stat-label">全年个税合计</div>
            </div>
            <div className="stat-sep" />
            <div className="stat tax-stat">
              <div className="stat-num is-good">
                <AnimatedNumber value={result.totalNet / 12} format={(n) => `¥${n.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}`} />
              </div>
              <div className="stat-label">月均到手</div>
            </div>
          </div>
          <Table size="small" columns={cols} dataSource={result.months} rowKey="m" pagination={false} />
          <Typography.Text type="secondary" style={{ display: "block", marginTop: 8 }}>
            说明：各月到手因累计税率档位不同略有差异，年底数月可能略低于年初数月；全年到手工 {result.totalNet.toLocaleString("zh-CN", { minimumFractionDigits: 2 })} 元。
          </Typography.Text>
        </div>
      )}
    </Modal>
  );
}

/** 编辑参保信息弹窗 */
function SocialEditModal({
  item, cities, onClose, onSaved,
}: {
  item: SocialItem | null;
  cities: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!item) return;
    form.setFieldsValue({
      si_status: item.si_status || "none",
      si_city: item.si_city || undefined,
      si_base: item.si_base ?? undefined,
      hf_base: item.hf_base ?? undefined,
      si_rate_personal: item.si_rate_personal ?? undefined,
      si_rate_company: item.si_rate_company ?? undefined,
      hf_rate_personal: item.hf_rate_personal ?? undefined,
      hf_rate_company: item.hf_rate_company ?? undefined,
    });
  }, [item, form]);

  const handleSave = async () => {
    if (!item) return;
    const v = await form.validateFields();
    setSaving(true);
    try {
      await api.updateSocial(item.id, {
        si_status: v.si_status,
        si_city: v.si_city || null,
        si_base: v.si_base ?? null,
        hf_base: v.hf_base ?? null,
        si_rate_personal: v.si_rate_personal ?? null,
        si_rate_company: v.si_rate_company ?? null,
        hf_rate_personal: v.hf_rate_personal ?? null,
        hf_rate_company: v.hf_rate_company ?? null,
      });
      message.success("参保信息已保存，增减员待办已同步");
      onSaved();
      onClose();
    } catch (e: any) {
      message.error(e?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`编辑参保信息 — ${item?.name || ""}`}
      open={!!item}
      onCancel={onClose}
      onOk={handleSave}
      confirmLoading={saving}
      okText="保存"
      cancelText="取消"
      width={560}
      destroyOnClose
    >
      {item && (
        <Alert
          type={item.hire_date ? "info" : "warning"}
          showIcon
          style={{ marginBottom: 16 }}
          message={
            item.hire_date
              ? `${item.name} 入职日期：${item.hire_date}（在「编辑人才」中可改）`
              : `${item.name} 尚未填入职日期，标记「已入职」或补填入职日期后才会生成社保增员待办`
          }
        />
      )}
      <Form form={form} layout="horizontal" labelCol={{ span: 6 }} wrapperCol={{ span: 16 }} style={{ marginTop: 16 }}>
        <Form.Item name="si_status" label="参保状态">
          <Select options={Object.entries(SI_STATUS_LABELS).map(([k, v]) => ({ label: v, value: k }))} />
        </Form.Item>
        <Form.Item name="si_city" label="参保地">
          <AutoComplete
            options={cities.map((c) => ({ value: c }))}
            placeholder="输入或选择参保城市"
            filterOption={(input, option) => (option?.value ?? "").includes(input)}
          />
        </Form.Item>
        <Form.Item name="si_base" label="社保基数" extra="月缴费基数，按当地政策填写">
          <InputNumber style={{ width: "100%" }} min={0} step={100} placeholder="如 8000" />
        </Form.Item>
        <Form.Item name="hf_base" label="公积金基数">
          <InputNumber style={{ width: "100%" }} min={0} step={100} placeholder="如 8000" />
        </Form.Item>
        <Form.Item name="si_rate_personal" label="社保个人%">
          <InputNumber style={{ width: "100%" }} min={0} max={100} step={0.5} placeholder="如 10.5" />
        </Form.Item>
        <Form.Item name="si_rate_company" label="社保单位%">
          <InputNumber style={{ width: "100%" }} min={0} max={100} step={0.5} placeholder="如 26" />
        </Form.Item>
        <Form.Item name="hf_rate_personal" label="公积金个人%">
          <InputNumber style={{ width: "100%" }} min={0} max={100} step={0.5} placeholder="如 7" />
        </Form.Item>
        <Form.Item name="hf_rate_company" label="公积金单位%">
          <InputNumber style={{ width: "100%" }} min={0} max={100} step={0.5} placeholder="如 7" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export default function Social() {
  const [items, setItems] = useState<SocialItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [appliedQ, setAppliedQ] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [editing, setEditing] = useState<SocialItem | null>(null);
  const [taxOpen, setTaxOpen] = useState(false);

  const fetchList = useCallback(async (keyword: string) => {
    setLoading(true);
    try {
      setItems(await api.getSocialList(keyword || undefined));
    } catch (e: any) {
      message.error(e?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  // 页面打开：先自动同步一次增减员待办（幂等），再拉清单
  useEffect(() => {
    (async () => {
      try {
        const r = await api.syncSocialTasks();
        if (r.created + r.updated > 0) {
          message.info(`已同步社保增减员提醒：新建 ${r.created} 条、更新 ${r.updated} 条，请在「跟进待办」查看`);
        }
      } catch { /* 同步失败不阻塞页面 */ }
      fetchList("");
    })();
  }, [fetchList]);

  const filtered = items.filter((r) => {
    const action = deriveAction(r);
    const si = r.si_status || "none";
    if (actionFilter === "all") return true;
    if (actionFilter === "add") return action === "add";
    if (actionFilter === "stop") return action === "stop";
    return si === actionFilter;  // active / stopped / none
  });

  const pendingAdd = items.filter((r) => deriveAction(r) === "add").length;
  const pendingStop = items.filter((r) => deriveAction(r) === "stop").length;
  const activeCount = items.filter((r) => (r.si_status || "none") === "active").length;

  const cities = Array.from(new Set(items.map((r) => r.si_city).filter((c): c is string => !!c)));

  const manualSync = async () => {
    try {
      const r = await api.syncSocialTasks();
      if (r.created + r.updated + r.cancelled > 0) {
        message.success(`已同步：新建 ${r.created} 条、更新 ${r.updated} 条、取消 ${r.cancelled} 条`);
      } else {
        message.info("所有增减员提醒均为最新，无需更新");
      }
      fetchList(appliedQ);
    } catch (e: any) {
      message.error(e?.message || "同步失败");
    }
  };

  const fmtMoney = (v: number | null) => (v != null ? `¥${v.toLocaleString("zh-CN")}` : "—");
  const fmtRate = (v: number | null) => (v != null ? `${v}%` : "—");

  const columns = [
    {
      title: "姓名", dataIndex: "name", key: "name", width: 120,
      render: (v: string, r: SocialItem) => <Link to={`/talents/${r.id}`}>{v}</Link>,
    },
    { title: "入职日期", dataIndex: "hire_date", key: "hire_date", width: 110, render: (v: string | null) => v || "—" },
    {
      title: "参保状态", dataIndex: "si_status", key: "si_status", width: 96,
      render: (v: string | null) => {
        const s = v || "none";
        return <Tag color={SI_STATUS_COLORS[s]}>{SI_STATUS_LABELS[s]}</Tag>;
      },
    },
    { title: "参保地", dataIndex: "si_city", key: "si_city", width: 110, render: (v: string | null) => v || "—" },
    { title: "社保基数", dataIndex: "si_base", key: "si_base", width: 110, render: fmtMoney },
    { title: "公积金基数", dataIndex: "hf_base", key: "hf_base", width: 110, render: fmtMoney },
    { title: "个人比例", key: "rate_p", width: 120, render: (_: unknown, r: SocialItem) => `${fmtRate(r.si_rate_personal)} / ${fmtRate(r.hf_rate_personal)}` },
    {
      title: "待办动作", key: "action", width: 96,
      render: (_: unknown, r: SocialItem) => {
        const a = deriveAction(r);
        return a ? <Tag color={ACTION_TAG[a].color}>{ACTION_TAG[a].text}</Tag> : "—";
      },
    },
    {
      title: "操作", key: "op", width: 80,
      render: (_: unknown, r: SocialItem) => (
        <Button type="link" size="small" onClick={() => setEditing(r)}>编辑</Button>
      ),
    },
  ];

  return (
    <div>
      {/* 统计区：增减员 / 参保概况 */}
      <div className="page-stats" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="stat-num is-bad">{pendingAdd}</div>
          <div className="stat-label">待增员</div>
        </div>
        <div className="stat-sep" />
        <div className="stat">
          <div className="stat-num is-bad">{pendingStop}</div>
          <div className="stat-label">待减员</div>
        </div>
        <div className="stat-sep" />
        <div className="stat">
          <div className="stat-num is-good">{activeCount}</div>
          <div className="stat-label">参保中</div>
        </div>
      </div>

      <Alert
        type="info" showIcon style={{ marginBottom: 16 }}
        message="标记「已入职」或填了入职日期、但未参保的人才 → 自动生成「社保增员」待办；填了离职日期且仍在缴 → 生成「社保减员」待办。基数与比例由你按参保地政策填写，系统不维护费率规则库。"
      />

      {/* 搜索 + 工具行 */}
      <Card className="search-card" style={{ marginBottom: 16 }} styles={{ body: { padding: 16 } }}>
        <div className="search-grid">
          <div className="search-field">
            <span className="search-label">姓名</span>
            <div className="search-control">
              <Input
                placeholder="按姓名搜索" value={q} allowClear
                onChange={(e) => setQ(e.target.value)}
                onPressEnter={() => { setAppliedQ(q); fetchList(q); }}
              />
            </div>
          </div>
          <div className="search-field">
            <span className="search-label">状态</span>
            <div className="search-control">
              <Select
                value={actionFilter} onChange={setActionFilter}
                options={[
                  { label: "全部", value: "all" },
                  { label: "待增员", value: "add" },
                  { label: "待减员", value: "stop" },
                  { label: "参保中", value: "active" },
                  { label: "已停缴", value: "stopped" },
                  { label: "未参保", value: "none" },
                ]}
              />
            </div>
          </div>
          <div className="search-field">
            <span className="search-label" />
            <div className="search-control" />
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
            <Button icon={<CalculatorOutlined />} onClick={() => setTaxOpen(true)}>个税计算器</Button>
            <Button icon={<BellOutlined />} onClick={manualSync}>同步提醒</Button>
            <Button icon={<ReloadOutlined />} onClick={() => { setQ(""); setAppliedQ(""); setActionFilter("all"); fetchList(""); }}>重置</Button>
            <Button type="primary" icon={<SearchOutlined />} onClick={() => { setAppliedQ(q); fetchList(q); }}>查询</Button>
          </div>
        </div>
      </Card>

      <Card styles={{ body: { padding: 0 } }}>
        <Table
          className="profiles-table"
          columns={columns}
          dataSource={filtered}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
        />
      </Card>

      <SocialEditModal
        item={editing}
        cities={cities}
        onClose={() => setEditing(null)}
        onSaved={() => fetchList(appliedQ)}
      />
      <TaxCalculatorModal open={taxOpen} onClose={() => setTaxOpen(false)} />
    </div>
  );
}
