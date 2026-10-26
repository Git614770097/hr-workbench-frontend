import { useState, useEffect, useCallback } from "react";
import { Card, Select, Space, Button, Table, Tag, Tooltip, Input, Segmented, Typography, message } from "antd";
import { ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { useSearchParams } from "react-router-dom";
import dayjs from "dayjs";
import { api } from "../api";
import type { UsageEventRow, AuditLogRow } from "../types";
import { MENU_LABELS, menuLabel } from "../usageMeta";
import { parseDbTime } from "../utils/time";

/**
 * 日志管理 —— 双列表（仅管理员）。
 *
 * 「上报明细」：前端埋点（components/UsageTracker）每 30 秒批量上报的原始记录，
 *   一行 = 一个批次（某模块的访问次数 + 停留时长），usage_events 滚动保留 30 天。
 * 「操作审计」：谁、何时、对什么数据、做了什么（新增/修改/删除/预览/下载/导出），
 *   写操作由后端自动留痕，导出等无写操作的动作由前端显式上报，用于事故追溯与合规。
 *
 * 2026-10-24 精简：统计卡/热度排行/活跃趋势/用户×模块矩阵/AI 使用/操作分布已删除
 * （连同后端 GET /logs/overview、/logs/ai-usage、/audit/actions）。埋点采集链路
 * （POST /logs/report）与审计写入（writeAudit）保留——两张表的数据源。
 *
 * 时间口径：audit_logs.ts 是 datetime('now') 落的 UTC，usage_events.ts 是 ISO 带 Z，
 * 两者都必须经 parseDbTime 解析后再格式化，直接 dayjs(ts) 会把审计时间差出 8 小时。
 */

// 上报明细只留 30 天（purgeOldUsage 滚动清理），给 90 天选项查出来也是空的
const EVENT_DAYS = [
  { label: "近 7 天", value: 7 },
  { label: "近 30 天", value: 30 },
];

const AUDIT_DAYS = [
  { label: "近 7 天", value: "7" },
  { label: "近 30 天", value: "30" },
  { label: "近 90 天", value: "90" },
];

const ROLE_LABELS: Record<string, string> = {
  admin: "管理员",
  user: "普通用户",
  hr: "HR",
};

/** 秒级可读的停留时长 */
function dwellText(ms: number): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 上报明细里的 JSON 摘要渲染成人话 */
function usageDetailText(raw: string | null): string {
  if (!raw) return "—";
  try {
    const d = JSON.parse(raw) as { views?: number; dwell_ms?: number };
    const parts: string[] = [];
    if (d.views) parts.push(`访问 ${d.views} 次`);
    if (d.dwell_ms) parts.push(`停留 ${dwellText(d.dwell_ms)}`);
    return parts.length ? parts.join(" · ") : "—";
  } catch {
    return raw;
  }
}

// 操作类型的展示名 + 颜色（同一种 action 在不同页面语义一致）
const ACTION_META: Record<string, { label: string; color: string }> = {
  create: { label: "新增", color: "green" },
  update: { label: "修改", color: "blue" },
  delete: { label: "删除", color: "red" },
  view: { label: "查看", color: "default" },
  export: { label: "导出", color: "orange" },
  client_error: { label: "前端报错", color: "volcano" },
};

const TARGET_META: Record<string, string> = {
  system: "系统",
  talent: "人才",
  resume: "简历原件",
  contract: "合同原件",
  bgcheck: "背调报告",
  job: "岗位",
  pipeline: "招聘流程",
  interview: "面试",
  approval: "审批",
  onboarding: "入职办理",
  requisition: "招聘需求",
  template: "模板",
  user: "用户",
  role: "角色",
  team: "团队",
  task: "待办",
  auth: "账号认证",
};

function actionTag(a: string) {
  const m = ACTION_META[a];
  return m ? <Tag color={m.color}>{m.label}</Tag> : <Tag>{a}</Tag>;
}

function targetLabel(t: string) {
  return TARGET_META[t] || t;
}

/** 审计 detail 是 JSON 串，转成人话 */
function auditDetailText(raw: string | null): string {
  if (!raw) return "—";
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof d.path === "string") parts.push(d.path);
    if (typeof d.method === "string") parts.push(d.method);
    if (typeof d.rows === "number") parts.push(`${d.rows} 条`);
    if (typeof d.selected === "boolean" && d.selected) parts.push("勾选导出");
    if (typeof d.download === "boolean") parts.push(d.download ? "下载" : "在线预览");
    if (typeof d.high_risk === "number" && d.high_risk === 1) parts.push("含高敏项");
    return parts.join(" · ") || JSON.stringify(d);
  } catch {
    return raw;
  }
}

/** 统一的时间显示：数据库时间先 parseDbTime 再格式化（审计 ts 是 UTC） */
function tsText(v: string, withSeconds = false): string {
  const d = parseDbTime(v);
  if (Number.isNaN(d.getTime())) return "—";
  return dayjs(d).format(withSeconds ? "MM-DD HH:mm:ss" : "MM-DD HH:mm");
}

// ---------------------------------------------------------------- 上报明细

function UsageEventsView() {
  const [draftDays, setDraftDays] = useState(7);
  const [draftMenu, setDraftMenu] = useState("");
  const [days, setDays] = useState(7);
  const [menuFilter, setMenuFilter] = useState("");

  const [events, setEvents] = useState<UsageEventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const fetchEvents = useCallback(
    async (p: number) => {
      setLoading(true);
      try {
        const res = await api.getUsageEvents({
          days,
          menu: menuFilter || undefined,
          page: p,
          page_size: 10,
        });
        setEvents(res.items);
        setTotal(res.total);
      } catch (err) {
        message.error((err as Error).message);
      }
      setLoading(false);
    },
    [days, menuFilter]
  );

  useEffect(() => {
    setPage(1);
    fetchEvents(1);
  }, [fetchEvents]);

  const columns = [
    {
      title: "时间",
      dataIndex: "ts",
      width: 150,
      render: (v: string) => tsText(v),
    },
    {
      title: "用户",
      dataIndex: "user_name",
      width: 140,
      render: (v: string, r: UsageEventRow) => (
        <Space size={6}>
          <span>{v}</span>
          <Tag style={{ marginInlineEnd: 0 }}>{ROLE_LABELS[r.role || ""] || r.role || "—"}</Tag>
        </Space>
      ),
    },
    { title: "模块", dataIndex: "menu", width: 120, render: (v: string) => menuLabel(v) },
    {
      title: "终端",
      dataIndex: "platform",
      width: 80,
      render: (v: string | null) => (v === "mobile" ? "手机" : "电脑"),
    },
    { title: "动态", dataIndex: "detail", render: (v: string | null) => usageDetailText(v) },
  ];

  return (
    <>
      {/* 搜索区（约定：只放搜索字段） */}
      <Card className="search-card" style={{ marginBottom: 16 }}>
        <div className="search-grid">
          <div className="search-field">
            <span className="search-label">统计周期</span>
            <div className="search-control">
              <Select value={draftDays} onChange={setDraftDays} options={EVENT_DAYS} />
            </div>
          </div>
          <div className="search-field">
            <span className="search-label">模块</span>
            <div className="search-control">
              <Select
                allowClear
                placeholder="全部模块"
                value={draftMenu || undefined}
                onChange={(v) => setDraftMenu(v || "")}
                options={Object.entries(MENU_LABELS).map(([value, label]) => ({ value, label }))}
              />
            </div>
          </div>
        </div>
      </Card>

      <Card className="list-card">
        {/* 工具行：左说明，右侧重置 / 查询（查询最右） */}
        <div className="toolbar">
          <Space size={4} wrap>
            <span style={{ fontSize: 13 }}>上报明细</span>
            <Tooltip title="一行 = 一个上报批次（某模块的访问次数 + 停留时长），由前端每 30 秒批量上报一次，最新一次操作最长延迟 30 秒可见；明细滚动保留 30 天">
              <span className="logs-sec-tip">说明</span>
            </Tooltip>
          </Space>
          <Space>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => { setDraftDays(7); setDraftMenu(""); setDays(7); setMenuFilter(""); }}
            >
              重置
            </Button>
            <Button type="primary" icon={<SearchOutlined />} onClick={() => { setDays(draftDays); setMenuFilter(draftMenu); }}>
              查询
            </Button>
          </Space>
        </div>

        <Table<UsageEventRow>
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={events}
          pagination={{
            current: page,
            total,
            pageSize: 10,
            showSizeChanger: false,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p) => { setPage(p); fetchEvents(p); },
          }}
          locale={{ emptyText: "该条件下没有上报记录" }}
          scroll={{ x: 760 }}
        />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- 操作审计

function AuditLogView() {
  const [draftDays, setDraftDays] = useState("30");
  const [draftAction, setDraftAction] = useState<string | undefined>();
  const [draftTarget, setDraftTarget] = useState<string | undefined>();
  const [draftQ, setDraftQ] = useState("");

  const [days, setDays] = useState("30");
  const [action, setAction] = useState<string | undefined>();
  const [targetType, setTargetType] = useState<string | undefined>();
  const [q, setQ] = useState("");

  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const fetchRows = useCallback(
    async (p: number) => {
      setLoading(true);
      try {
        const r = await api.getAuditLogs({
          days: Number(days),
          action,
          target_type: targetType,
          q,
          page: p,
          limit: 50,
        });
        setRows(r.items);
        setTotal(r.total);
      } catch (e) {
        message.error((e as Error).message);
      }
      setLoading(false);
    },
    [days, action, targetType, q]
  );

  useEffect(() => {
    setPage(1);
    fetchRows(1);
  }, [fetchRows]);

  const columns = [
    {
      title: "时间",
      dataIndex: "ts",
      width: 165,
      render: (v: string) => (
        <Tooltip title={v}>
          <span>{tsText(v, true)}</span>
        </Tooltip>
      ),
    },
    { title: "操作", dataIndex: "action", width: 84, render: actionTag },
    { title: "对象", dataIndex: "target_type", width: 110, render: (v: string) => targetLabel(v) },
    {
      title: "对象名称",
      dataIndex: "target_name",
      render: (v: string | null) => v || <Typography.Text type="secondary">-</Typography.Text>,
    },
    {
      title: "详情",
      dataIndex: "detail",
      render: (v: string | null) => <Typography.Text type="secondary">{auditDetailText(v)}</Typography.Text>,
    },
    {
      title: "操作人",
      dataIndex: "user_name",
      width: 120,
      render: (v: string | null, r: AuditLogRow) => (
        <Space size={4}>
          <span>{v || "匿名"}</span>
          {r.role === "admin" && <Tag color="gold" style={{ marginInlineEnd: 0 }}>管理员</Tag>}
        </Space>
      ),
    },
    {
      title: "IP",
      dataIndex: "ip",
      width: 130,
      render: (v: string | null) => v || <Typography.Text type="secondary">-</Typography.Text>,
    },
  ];

  return (
    <>
      {/* 搜索区（约定：只放搜索字段） */}
      <Card className="search-card" style={{ marginBottom: 16 }}>
        <div className="search-grid">
          <div className="search-field">
            <span className="search-label">时间范围</span>
            <div className="search-control">
              <Select value={draftDays} onChange={setDraftDays} options={AUDIT_DAYS} />
            </div>
          </div>
          <div className="search-field">
            <span className="search-label">操作类型</span>
            <div className="search-control">
              <Select
                allowClear
                placeholder="全部"
                value={draftAction}
                onChange={setDraftAction}
                options={Object.entries(ACTION_META).map(([k, v]) => ({ label: v.label, value: k }))}
              />
            </div>
          </div>
          <div className="search-field">
            <span className="search-label">对象类型</span>
            <div className="search-control">
              <Select
                allowClear
                placeholder="全部"
                value={draftTarget}
                onChange={setDraftTarget}
                options={Object.entries(TARGET_META).map(([k, v]) => ({ label: v, value: k }))}
              />
            </div>
          </div>
          <div className="search-field">
            <span className="search-label">关键词</span>
            <div className="search-control">
              <Input
                allowClear
                placeholder="对象名 / 操作人 / 详情"
                value={draftQ}
                onChange={(e) => setDraftQ(e.target.value)}
                onPressEnter={() => { setDays(draftDays); setAction(draftAction); setTargetType(draftTarget); setQ(draftQ.trim()); }}
              />
            </div>
          </div>
        </div>
      </Card>

      <Card className="list-card">
        {/* 工具行：左说明，右侧重置 / 查询（查询最右） */}
        <div className="toolbar">
          <Space size={4} wrap>
            <span style={{ fontSize: 13 }}>操作审计</span>
            <Tooltip title="写操作（新增/修改/删除）由后端自动留痕；简历/合同的预览与下载、浏览器内导出为前端显式上报。用于事故追溯与个人信息合规">
              <span className="logs-sec-tip">说明</span>
            </Tooltip>
          </Space>
          <Space>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                setDraftDays("30"); setDraftAction(undefined); setDraftTarget(undefined); setDraftQ("");
                setDays("30"); setAction(undefined); setTargetType(undefined); setQ("");
              }}
            >
              重置
            </Button>
            <Button
              type="primary"
              icon={<SearchOutlined />}
              onClick={() => { setDays(draftDays); setAction(draftAction); setTargetType(draftTarget); setQ(draftQ.trim()); }}
            >
              查询
            </Button>
          </Space>
        </div>

        <Table<AuditLogRow>
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={rows}
          columns={columns}
          pagination={{
            current: page,
            total,
            pageSize: 50,
            showSizeChanger: false,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p) => { setPage(p); fetchRows(p); },
          }}
          locale={{ emptyText: "该条件下没有操作记录" }}
          scroll={{ x: 900 }}
        />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- 页面容器

export default function Logs() {
  // ?tab=audit 直达操作审计（/audit 旧地址重定向到这里）；切换时同步 URL，刷新不丢 Tab
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") === "audit" ? "audit" : "events";

  return (
    <div className="page-fill logs-page">
      <div style={{ marginBottom: 16 }}>
        <Segmented
          value={tab}
          onChange={(v) => setSearchParams({ tab: String(v) }, { replace: true })}
          options={[
            { label: "上报明细", value: "events" },
            { label: "操作审计", value: "audit" },
          ]}
        />
      </div>
      {/* 条件渲染而非 Tabs：antd Tabs 只隐藏不卸载，会把两张表的请求一次性都发出去 */}
      {tab === "events" ? <UsageEventsView /> : <AuditLogView />}
    </div>
  );
}
