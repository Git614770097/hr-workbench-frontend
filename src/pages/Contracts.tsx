import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  Card, Table, Input, Select, Button, Space, Tag, DatePicker, Modal,
  Form, message, Alert,
} from "antd";
import { SearchOutlined, ReloadOutlined, BellOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api";
import type { ContractItem } from "../types";
import { STATUS_LABELS } from "../types";

/** 剩余天数：两侧都用 UTC 午夜基准相减，无时区跨日问题 */
function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const today = new Date(`${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T00:00:00Z`);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

/** 到期日 + 剩余天数 Tag（红=已过期 / 橙=30 天内 / 灰=充裕） */
function DateWithTag({ date }: { date: string | null }) {
  if (!date) return <span>—</span>;
  const left = daysUntil(date);
  let tag = null;
  if (left != null) {
    if (left < 0) tag = <Tag color="red" style={{ marginInlineEnd: 0 }}>已过期 {-left} 天</Tag>;
    else if (left <= 30) tag = <Tag color="orange" style={{ marginInlineEnd: 0 }}>仅剩 {left} 天</Tag>;
    else tag = <Tag style={{ marginInlineEnd: 0 }}>{left} 天</Tag>;
  }
  return (
    <Space size={6}>
      <span>{date}</span>
      {tag}
    </Space>
  );
}

export default function Contracts() {
  const [items, setItems] = useState<ContractItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [appliedQ, setAppliedQ] = useState("");
  const [rangeFilter, setRangeFilter] = useState("all");
  const [editing, setEditing] = useState<ContractItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const fetchList = useCallback(async (keyword: string) => {
    setLoading(true);
    try {
      setItems(await api.getContracts(keyword || undefined));
    } catch (e: any) {
      message.error(e?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  // 页面打开：先自动同步一次到期提醒待办（幂等），再拉清单
  useEffect(() => {
    (async () => {
      try {
        const r = await api.syncContractTasks();
        if (r.created + r.updated > 0) {
          message.info(`已同步合同到期提醒：新建 ${r.created} 条、更新 ${r.updated} 条，请在「跟进待办」查看`);
        }
      } catch { /* 同步失败不阻塞页面 */ }
      fetchList("");
    })();
  }, [fetchList]);

  // 前端过滤：30 天内 / 已过期（按合同与试用期中更早的日期判断）
  const filtered = items.filter((r) => {
    if (rangeFilter === "all") return true;
    const days = [daysUntil(r.contract_end), daysUntil(r.probation_end)].filter((d): d is number => d != null);
    if (!days.length) return rangeFilter === "all";
    const earliest = Math.min(...days);
    return rangeFilter === "due30" ? earliest >= 0 && earliest <= 30 : earliest < 0;
  });

  const expiredCount = items.filter((r) => {
    const days = [daysUntil(r.contract_end), daysUntil(r.probation_end)].filter((d): d is number => d != null);
    return days.length && Math.min(...days) < 0;
  }).length;
  const due30Count = items.filter((r) => {
    const days = [daysUntil(r.contract_end), daysUntil(r.probation_end)].filter((d): d is number => d != null);
    const earliest = days.length ? Math.min(...days) : Infinity;
    return earliest >= 0 && earliest <= 30;
  }).length;
  const probationDueCount = items.filter((r) => {
    const d = daysUntil(r.probation_end);
    return d != null && d >= 0 && d <= 30;
  }).length;

  const openEdit = (r: ContractItem) => {
    setEditing(r);
    form.setFieldsValue({
      contract_end: r.contract_end ? dayjs(r.contract_end) : null,
      probation_end: r.probation_end ? dayjs(r.probation_end) : null,
    });
  };

  const handleSave = async () => {
    if (!editing) return;
    const values = await form.validateFields();
    setSaving(true);
    try {
      // 显式传 null 表示清空日期，后端会同步取消对应提醒待办
      await api.updateTalent(editing.id, {
        contract_end: values.contract_end ? values.contract_end.format("YYYY-MM-DD") : null,
        probation_end: values.probation_end ? values.probation_end.format("YYYY-MM-DD") : null,
      });
      message.success("合同日期已保存，到期提醒待办已同步");
      setEditing(null);
      fetchList(appliedQ);
    } catch (e: any) {
      message.error(e?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const manualSync = async () => {
    try {
      const r = await api.syncContractTasks();
      if (r.created + r.updated > 0) {
        message.success(`已同步：新建 ${r.created} 条、更新 ${r.updated} 条、取消 ${r.cancelled} 条`);
      } else {
        message.info("所有到期提醒均为最新，无需更新");
      }
      fetchList(appliedQ);
    } catch (e: any) {
      message.error(e?.message || "同步失败");
    }
  };

  const columns = [
    {
      title: "姓名", dataIndex: "name", key: "name", width: 120,
      render: (v: string, r: ContractItem) => <Link to={`/talents/${r.id}`}>{v}</Link>,
    },
    { title: "手机号", dataIndex: "phone", key: "phone", width: 140, render: (v: string | null) => v || "—" },
    {
      title: "人才状态", dataIndex: "status", key: "status", width: 100,
      render: (v: string) => STATUS_LABELS[v as keyof typeof STATUS_LABELS] || v,
    },
    {
      title: "合同到期日", dataIndex: "contract_end", key: "contract_end", width: 200,
      render: (v: string | null) => <DateWithTag date={v} />,
    },
    {
      title: "试用期到期日", dataIndex: "probation_end", key: "probation_end", width: 200,
      render: (v: string | null) => <DateWithTag date={v} />,
    },
    {
      title: "操作", key: "action", width: 90,
      render: (_: unknown, r: ContractItem) => (
        <Button type="link" size="small" onClick={() => openEdit(r)}>编辑日期</Button>
      ),
    },
  ];

  return (
    <div>
      {/* 统计区：合同/试用期到期概况 */}
      <div className="page-stats" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="stat-num is-bad">{expiredCount}</div>
          <div className="stat-label">已过期（合同或试用期）</div>
        </div>
        <div className="stat-sep" />
        <div className="stat">
          <div className="stat-num is-neutral">{due30Count}</div>
          <div className="stat-label">合同 30 天内到期</div>
        </div>
        <div className="stat-sep" />
        <div className="stat">
          <div className="stat-num is-neutral">{probationDueCount}</div>
          <div className="stat-label">试用期 30 天内到期</div>
        </div>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="合同 / 试用期到期前 30 天（含已过期未处理）会自动在「跟进待办」生成高优先级提醒；编辑日期后提醒自动更新，清空日期则自动取消提醒。"
      />

      {/* 搜索：姓名关键词 + 到期状态筛选 */}
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
            <span className="search-label">到期状态</span>
            <div className="search-control">
              <Select
                value={rangeFilter} onChange={setRangeFilter}
                options={[
                  { label: "全部", value: "all" },
                  { label: "30 天内到期", value: "due30" },
                  { label: "已过期", value: "expired" },
                ]}
              />
            </div>
          </div>
          <div className="search-field">
            <span className="search-label" />
            <div className="search-control" />
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
            <Button icon={<BellOutlined />} onClick={manualSync}>同步提醒</Button>
            <Button icon={<ReloadOutlined />} onClick={() => { setQ(""); setAppliedQ(""); setRangeFilter("all"); fetchList(""); }}>重置</Button>
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

      {/* 编辑合同日期弹窗：保存即同步待办 */}
      <Modal
        title={`编辑合同日期 — ${editing?.name || ""}`}
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={handleSave}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        width={520}
        destroyOnClose
      >
        <Form form={form} layout="horizontal" labelCol={{ span: 6 }} wrapperCol={{ span: 16 }} style={{ marginTop: 16 }}>
          <Form.Item name="contract_end" label="合同到期日" extra="清空日期并保存，将自动取消合同到期提醒">
            <DatePicker style={{ width: "100%" }} placeholder="选择合同到期日（可清空）" />
          </Form.Item>
          <Form.Item name="probation_end" label="试用期到期日" extra="到期前 30 天自动生成转正评估提醒">
            <DatePicker style={{ width: "100%" }} placeholder="选择试用期到期日（可清空）" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
