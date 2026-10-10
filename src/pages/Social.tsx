import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  Card, Table, Input, Select, Button, Space, Tag, Modal,
  Form, message, InputNumber, AutoComplete, Alert, Typography, Popconfirm,
} from "antd";
import {
  SearchOutlined, ReloadOutlined, BellOutlined, CalculatorOutlined,
  UserAddOutlined, UserDeleteOutlined, SafetyCertificateOutlined, InfoCircleOutlined,
  DollarOutlined, SettingOutlined, DownloadOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import type { SocialItem, SocialRateTemplate } from "../types";
import { SI_STATUS_LABELS, SI_STATUS_COLORS } from "../types";
import AnimatedNumber from "../components/AnimatedNumber";
import { useDismissible } from "../hooks/useDismissible";
import { useIdentityProfile } from "../useIdentity";
import { termFor } from "../identityProfiles";
import { exportXlsx, dateStamp } from "../utils/file";

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

/**
 * 月缴额 = 社保基数 × 比例 + 公积金基数 × 比例（比例按百分数存，如 10.5 表示 10.5%）
 * 任一侧缺基数或比例即按 0 计；两侧都缺返回 null（显示 —）。
 */
function monthlyFee(r: SocialItem, kind: "personal" | "company"): number | null {
  const siRate = kind === "personal" ? r.si_rate_personal : r.si_rate_company;
  const hfRate = kind === "personal" ? r.hf_rate_personal : r.hf_rate_company;
  const si = r.si_base != null && siRate != null ? (r.si_base * siRate) / 100 : null;
  const hf = r.hf_base != null && hfRate != null ? (r.hf_base * hfRate) / 100 : null;
  if (si == null && hf == null) return null;
  return Math.round(((si ?? 0) + (hf ?? 0)) * 100) / 100;
}

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

/** 参保城市费率模板：内置参考值 + 自己维护的（同城自己的优先，可覆盖参考值） */
function RateTemplateModal({
  open, rates, onClose, onSaved,
}: {
  open: boolean;
  rates: SocialRateTemplate[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [city, setCity] = useState("");
  const [vals, setVals] = useState<{
    si_rate_personal: number | null; si_rate_company: number | null;
    hf_rate_personal: number | null; hf_rate_company: number | null;
  }>({ si_rate_personal: null, si_rate_company: null, hf_rate_personal: null, hf_rate_company: null });
  const [saving, setSaving] = useState(false);

  const numBox = (key: keyof typeof vals, placeholder: string) => (
    <InputNumber
      style={{ width: "100%" }} min={0} max={100} step={0.5} placeholder={placeholder}
      value={vals[key]} onChange={(v) => setVals({ ...vals, [key]: v ?? null })}
    />
  );

  const pick = (r: SocialRateTemplate) => {
    setCity(r.city);
    setVals({
      si_rate_personal: r.si_rate_personal, si_rate_company: r.si_rate_company,
      hf_rate_personal: r.hf_rate_personal, hf_rate_company: r.hf_rate_company,
    });
  };

  const save = async () => {
    if (!city.trim()) { message.warning("先填参保城市"); return; }
    setSaving(true);
    try {
      await api.saveSocialRate({ city: city.trim(), ...vals });
      message.success(`${city} 的默认比例已保存`);
      setCity("");
      setVals({ si_rate_personal: null, si_rate_company: null, hf_rate_personal: null, hf_rate_company: null });
      onSaved();
    } catch (e: any) {
      message.error(e?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: SocialRateTemplate) => {
    try {
      await api.deleteSocialRate(r.id);
      message.success("已删除");
      onSaved();
    } catch (e: any) {
      message.error(e?.message || "删除失败");
    }
  };

  const cols = [
    {
      title: "城市", dataIndex: "city", key: "city", width: 110,
      render: (v: string, r: SocialRateTemplate) => (
        <Space size={4}>
          <span>{v}</span>
          {r.is_system ? <Tag color="blue" style={{ marginInlineEnd: 0 }}>参考值</Tag> : null}
        </Space>
      ),
    },
    { title: "社保个人", dataIndex: "si_rate_personal", key: "p1", render: (v: number | null) => (v != null ? `${v}%` : "—") },
    { title: "社保单位", dataIndex: "si_rate_company", key: "p2", render: (v: number | null) => (v != null ? `${v}%` : "—") },
    { title: "公积金个人", dataIndex: "hf_rate_personal", key: "p3", render: (v: number | null) => (v != null ? `${v}%` : "—") },
    { title: "公积金单位", dataIndex: "hf_rate_company", key: "p4", render: (v: number | null) => (v != null ? `${v}%` : "—") },
    {
      title: "操作", key: "op", width: 140,
      render: (_: unknown, r: SocialRateTemplate) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => pick(r)}>载入</Button>
          <Popconfirm
            title={r.is_system ? "内置参考值不可删除，可填同名城市覆盖" : `删除「${r.city}」的默认比例？`}
            okText="确定" cancelText="取消"
            onConfirm={() => (r.is_system ? undefined : remove(r))}
          >
            <Button type="link" size="small" danger disabled={!!r.is_system}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Modal
      title="参保城市费率模板" open={open} onCancel={onClose} footer={null} width={760} destroyOnClose
    >
      <Alert
        type="warning" showIcon style={{ marginBottom: 16 }}
        message="内置值仅为参考起点（养老 8% + 医疗约 2% + 失业 0.5% 的全国框架），各地单位侧比例与公积金区间差异较大，请按当地社保 / 公积金中心最新口径核对后再用。"
      />
      <Table
        size="small" columns={cols} dataSource={rates} rowKey="id" pagination={false}
        style={{ marginBottom: 16 }} scroll={{ x: 560 }}
      />
      <Typography.Text strong>新增 / 覆盖</Typography.Text>
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ width: 120 }}>
          <div className="m-field-label" style={{ margin: "0 0 6px" }}>城市</div>
          <AutoComplete
            style={{ width: "100%" }} value={city} onChange={setCity}
            options={rates.map((r) => ({ value: r.city }))}
            placeholder="如 上海"
            filterOption={(input, option) => (option?.value ?? "").includes(input)}
          />
        </div>
        <div style={{ width: 110 }}>
          <div className="m-field-label" style={{ margin: "0 0 6px" }}>社保个人%</div>
          {numBox("si_rate_personal", "10.5")}
        </div>
        <div style={{ width: 110 }}>
          <div className="m-field-label" style={{ margin: "0 0 6px" }}>社保单位%</div>
          {numBox("si_rate_company", "26.5")}
        </div>
        <div style={{ width: 110 }}>
          <div className="m-field-label" style={{ margin: "0 0 6px" }}>公积金个人%</div>
          {numBox("hf_rate_personal", "7")}
        </div>
        <div style={{ width: 110 }}>
          <div className="m-field-label" style={{ margin: "0 0 6px" }}>公积金单位%</div>
          {numBox("hf_rate_company", "7")}
        </div>
        <div style={{ alignSelf: "flex-end" }}>
          <Button type="primary" loading={saving} onClick={save}>保存</Button>
        </div>
      </div>
      <Typography.Text type="secondary" style={{ display: "block", marginTop: 8, fontSize: 12 }}>
        保存后编辑参保信息时选该城市会自动带出；同名城市已有的会直接覆盖。
      </Typography.Text>
    </Modal>
  );
}

/** 编辑参保信息弹窗 */
function SocialEditModal({
  item, cities, rates, onClose, onSaved,
}: {
  item: SocialItem | null;
  cities: string[];
  rates: SocialRateTemplate[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const profile = useIdentityProfile();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [tplHint, setTplHint] = useState<SocialRateTemplate | null>(null);

  const RATE_KEYS = ["si_rate_personal", "si_rate_company", "hf_rate_personal", "hf_rate_company"] as const;

  /** 选城市后按模板带出比例：只填当前为空的字段，避免覆盖 HR 手工调过的值 */
  const applyRates = (city?: string | null) => {
    const tpl = city ? rates.find((r) => r.city === city) : undefined;
    if (!tpl) { setTplHint(null); return; }
    const cur = form.getFieldsValue();
    const patch: Record<string, number> = {};
    for (const k of RATE_KEYS) {
      if (cur[k] == null && tpl[k] != null) patch[k] = tpl[k] as number;
    }
    if (Object.keys(patch).length) form.setFieldsValue(patch);
    setTplHint(tpl);
  };

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
    setTplHint(null);
    // 已有参保城市但还没填比例的存量记录，打开时顺手带出
    if (item.si_city) applyRates(item.si_city);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, form, rates]);

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
              ? termFor(profile, `${item.name} 入职日期：${item.hire_date}（在「编辑人才」中可改）`)
              : `${item.name} 尚未填入职日期，标记「已入职」或补填入职日期后才会生成社保增员待办`
          }
        />
      )}
      <Form form={form} layout="horizontal" labelCol={{ span: 6 }} wrapperCol={{ span: 16 }} style={{ marginTop: 16 }}>
        <Form.Item name="si_status" label="参保状态">
          <Select options={Object.entries(SI_STATUS_LABELS).map(([k, v]) => ({ label: v, value: k }))} />
        </Form.Item>
        <Form.Item name="si_city" label="参保地" extra="选城市后自动带出该城市的默认缴费比例（可在下方改）">
          <AutoComplete
            options={Array.from(new Set([...cities, ...rates.map((r) => r.city)])).map((c) => ({ value: c }))}
            placeholder="输入或选择参保城市"
            filterOption={(input, option) => (option?.value ?? "").includes(input)}
            onChange={(v) => { form.setFieldsValue({ si_city: v }); applyRates(v); }}
          />
        </Form.Item>
        {tplHint ? (
          <Alert
            type="info" showIcon style={{ marginBottom: 16 }}
            message={`已按「${tplHint.city}」${tplHint.is_system ? "内置参考值" : "你的模板"}带出：社保 ${tplHint.si_rate_personal ?? "—"}% / ${tplHint.si_rate_company ?? "—"}%，公积金 ${tplHint.hf_rate_personal ?? "—"}% / ${tplHint.hf_rate_company ?? "—"}%`}
            description={tplHint.is_system ? "参考值，请按当地社保 / 公积金中心最新口径核对" : undefined}
          />
        ) : null}
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
  const profile = useIdentityProfile();
  const [items, setItems] = useState<SocialItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [appliedQ, setAppliedQ] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [editing, setEditing] = useState<SocialItem | null>(null);
  const [taxOpen, setTaxOpen] = useState(false);
  const [rates, setRates] = useState<SocialRateTemplate[]>([]);
  const [rateOpen, setRateOpen] = useState(false);
  const intro = useDismissible("social.intro");

  const loadRates = useCallback(async () => {
    try {
      setRates(await api.getSocialRates());
    } catch { /* 模板拉不到不影响主流程，只是不自动带出 */ }
  }, []);

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
          message.info(`已同步社保增减员提醒：新建 ${r.created} 条、更新 ${r.updated} 条，请在「待办日历」查看`);
        }
      } catch { /* 同步失败不阻塞页面 */ }
      fetchList("");
      loadRates();
    })();
  }, [fetchList, loadRates]);

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

  // 月缴额合计：全量用于顶部统计卡，filtered 用于表格合计行
  const allPersonal = items.reduce((s, r) => s + (monthlyFee(r, "personal") ?? 0), 0);
  const allCompany = items.reduce((s, r) => s + (monthlyFee(r, "company") ?? 0), 0);
  const sumPersonal = filtered.reduce((s, r) => s + (monthlyFee(r, "personal") ?? 0), 0);
  const sumCompany = filtered.reduce((s, r) => s + (monthlyFee(r, "company") ?? 0), 0);

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
      title: "个人月缴", key: "fee_p", width: 110,
      render: (_: unknown, r: SocialItem) => {
        const v = monthlyFee(r, "personal");
        return v != null ? <span style={{ fontWeight: 500 }}>¥{v.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}</span> : "—";
      },
    },
    {
      title: "单位月缴", key: "fee_c", width: 110,
      render: (_: unknown, r: SocialItem) => {
        const v = monthlyFee(r, "company");
        return v != null ? <span style={{ fontWeight: 500 }}>¥{v.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}</span> : "—";
      },
    },
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
    <div className="page-fill">
      {/* 统计区：增减员 / 参保概况 */}
      <div className="page-stats" style={{ marginBottom: 16 }}>
        <div className="stat">
          <span className="stat-icon is-warn"><UserAddOutlined /></span>
          <span className="stat-body">
            <span className="stat-num is-warn"><AnimatedNumber value={pendingAdd} format={(n) => Math.round(n).toLocaleString("zh-CN")} /></span>
            <span className="stat-label">待增员</span>
          </span>
        </div>
        <div className="stat">
          <span className="stat-icon is-bad"><UserDeleteOutlined /></span>
          <span className="stat-body">
            <span className="stat-num is-bad"><AnimatedNumber value={pendingStop} format={(n) => Math.round(n).toLocaleString("zh-CN")} /></span>
            <span className="stat-label">待减员</span>
          </span>
        </div>
        <div className="stat">
          <span className="stat-icon is-good"><SafetyCertificateOutlined /></span>
          <span className="stat-body">
            <span className="stat-num is-good"><AnimatedNumber value={activeCount} format={(n) => Math.round(n).toLocaleString("zh-CN")} /></span>
            <span className="stat-label">参保中</span>
          </span>
        </div>
        <div className="stat">
          <span className="stat-icon is-neutral"><DollarOutlined /></span>
          <span className="stat-body">
            <span className="stat-num is-neutral"><AnimatedNumber value={allPersonal + allCompany} format={(n) => `¥${Math.round(n).toLocaleString("zh-CN")}`} /></span>
            <span className="stat-label">月缴合计</span>
          </span>
        </div>
      </div>

      {!intro.dismissed && (
        <Alert
          type="info" showIcon closable style={{ marginBottom: 16 }}
          message={termFor(profile, "标记「已入职」或填了入职日期、但未参保的人才 → 自动生成「社保增员」待办；填了离职日期且仍在缴 → 生成「社保减员」待办。基数与比例由你按参保地政策填写，系统不维护费率规则库；「个人月缴 / 单位月缴」由基数 × 对应比例自动算出（社保 + 公积金）。")}
          onClose={intro.dismiss}
        />
      )}

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
            {intro.dismissed && (
              <Button icon={<InfoCircleOutlined />} onClick={intro.restore}>说明</Button>
            )}
            <Button icon={<SettingOutlined />} onClick={() => setRateOpen(true)}>费率模板</Button>
            <Button icon={<CalculatorOutlined />} onClick={() => setTaxOpen(true)}>个税计算器</Button>
            <Button icon={<BellOutlined />} onClick={manualSync}>同步提醒</Button>
            <Button icon={<ReloadOutlined />} onClick={() => { setQ(""); setAppliedQ(""); setActionFilter("all"); fetchList(""); }}>重置</Button>
            <Button type="primary" icon={<SearchOutlined />} onClick={() => { setAppliedQ(q); fetchList(q); }}>查询</Button>
            <Button icon={<DownloadOutlined />} onClick={async () => {
              await exportXlsx(`社保公积金台账_${dateStamp()}.xlsx`, [{
                name: "社保台账",
                columns: [
                  { header: "姓名", key: "name", width: 12 },
                  { header: "手机号", key: "phone", width: 14 },
                  { header: "状态", key: "status", width: 10 },
                  { header: "入职日期", key: "hire_date", width: 12 },
                  { header: "离职日期", key: "resignation_date", width: 12 },
                  { header: "参保状态", key: "si_status", width: 10 },
                  { header: "参保地", key: "si_city", width: 10 },
                  { header: "社保基数", key: "si_base", width: 12 },
                  { header: "公积金基数", key: "hf_base", width: 12 },
                  { header: "社保个人比例", key: "si_rate_personal", width: 14 },
                  { header: "社保单位比例", key: "si_rate_company", width: 14 },
                  { header: "公积金个人比例", key: "hf_rate_personal", width: 14 },
                  { header: "公积金单位比例", key: "hf_rate_company", width: 14 },
                ],
                rows: filtered.map((r) => ({
                  name: r.name,
                  phone: r.phone || "",
                  status: r.status,
                  hire_date: r.hire_date || "",
                  resignation_date: r.resignation_date || "",
                  si_status: SI_STATUS_LABELS[r.si_status || "none"] || r.si_status || "",
                  si_city: r.si_city || "",
                  si_base: r.si_base ?? "",
                  hf_base: r.hf_base ?? "",
                  si_rate_personal: r.si_rate_personal ?? "",
                  si_rate_company: r.si_rate_company ?? "",
                  hf_rate_personal: r.hf_rate_personal ?? "",
                  hf_rate_company: r.hf_rate_company ?? "",
                })),
              }]);
            }}>导出 Excel</Button>
          </div>
        </div>
      </Card>

      <Card className="list-card" styles={{ body: { padding: 0 } }}>
        <Table
          className="profiles-table"
          columns={columns}
          dataSource={filtered}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
          summary={() => (
            <Table.Summary fixed>
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={7}>
                  合计（当前筛选 {filtered.length} 人）
                </Table.Summary.Cell>
                <Table.Summary.Cell index={7}>
                  <span style={{ fontWeight: 500 }}>个人 ¥{sumPersonal.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}</span>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={8}>
                  <span style={{ fontWeight: 500 }}>单位 ¥{sumCompany.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}</span>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={9} colSpan={2}>
                  <span style={{ fontWeight: 500 }}>用工总成本 ¥{(sumPersonal + sumCompany).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}/月</span>
                </Table.Summary.Cell>
              </Table.Summary.Row>
            </Table.Summary>
          )}
        />
      </Card>

      <SocialEditModal
        item={editing}
        cities={cities}
        rates={rates}
        onClose={() => setEditing(null)}
        onSaved={() => fetchList(appliedQ)}
      />
      <RateTemplateModal
        open={rateOpen}
        rates={rates}
        onClose={() => setRateOpen(false)}
        onSaved={loadRates}
      />
      <TaxCalculatorModal open={taxOpen} onClose={() => setTaxOpen(false)} />
    </div>
  );
}
