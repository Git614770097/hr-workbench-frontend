import { useState, useEffect, useCallback } from "react";
import { Card, Table, Tag, Select, Input, Button, Space, Typography, Tooltip, message } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api";
import type { AuditLogRow, AuditActionStat } from "../types";

/**
 * 操作审计页（仅管理员）。
 *
 * 与「日志管理 / 使用热度」的区别：
 *  - 使用热度：用户在哪个菜单停留了多久，用于产品迭代参考；
 *  - 本页：谁、在何时、对什么数据、做了什么（新增/修改/删除/预览/下载/导出），
 *    用于事故追溯与个人信息合规。
 *
 * 数据来源：所有写操作由后端中间件自动记录；简历/合同/背调报告的预览与下载、
 * 以及浏览器内的导出（Excel/PDF）为显式埋点上报。因此「新增/修改/删除」一定看得见，
 * 「谁看过谁的简历」「谁导走了多少条数据」也看得到——这是个人合规最关心的两类行为。
 */

const DAY_OPTIONS = [
  { label: "近 7 天", value: "7" },
  { label: "近 30 天", value: "30" },
  { label: "近 90 天", value: "90" },
];

// 操作类型的展示名 + 颜色（同一种 action 在不同页面语义一致）
const ACTION_META: Record<string, { label: string; color: string }> = {
  create: { label: "新增", color: "green" },
  update: { label: "修改", color: "blue" },
  delete: { label: "删除", color: "red" },
  view: { label: "查看", color: "default" },
  export: { label: "导出", color: "orange" },
};

const TARGET_META: Record<string, string> = {
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

/** detail 是 JSON 串，转成人话 */
function detailText(raw: string | null): string {
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

export default function AuditLogs() {
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [stats, setStats] = useState<AuditActionStat[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState("30");
  const [action, setAction] = useState<string | undefined>();
  const [targetType, setTargetType] = useState<string | undefined>();
  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getAuditLogs({ days: Number(days), action, target_type: targetType, q, page, limit: 50 });
      setRows(r.items);
      setTotal(r.total);
      const s = await api.getAuditActionStats(Number(days));
      setStats(s.items);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [days, action, targetType, q, page]);

  useEffect(() => { load(); }, [load]);

  return (
    <Space direction="vertical" style={{ width: "100%" }} size={12}>
      <Card size="small">
        <Space wrap size={16} align="center">
          <Space size={8}>
            <span className="ant-form-text">时间范围</span>
            <Select
              value={days}
              onChange={(v) => { setDays(v); setPage(1); }}
              options={DAY_OPTIONS}
              style={{ width: 110 }}
            />
          </Space>
          <Space size={8}>
            <span className="ant-form-text">操作类型</span>
            <Select
              value={action}
              onChange={(v) => { setAction(v); setPage(1); }}
              allowClear
              placeholder="全部"
              style={{ width: 110 }}
              options={Object.entries(ACTION_META).map(([k, v]) => ({ label: v.label, value: k }))}
            />
          </Space>
          <Space size={8}>
            <span className="ant-form-text">对象类型</span>
            <Select
              value={targetType}
              onChange={(v) => { setTargetType(v); setPage(1); }}
              allowClear
              placeholder="全部"
              style={{ width: 120 }}
              options={Object.entries(TARGET_META).map(([k, v]) => ({ label: v, value: k }))}
            />
          </Space>
          <Space size={8}>
            <span className="ant-form-text">关键词</span>
            <Input.Search
              allowClear
              placeholder="对象名 / 操作人 / 详情"
              style={{ width: 220 }}
              defaultValue={qInput}
              onSearch={(v) => { setQ(v.trim()); setQInput(v.trim()); setPage(1); }}
            />
          </Space>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        </Space>
      </Card>

      {stats.length > 0 && (
        <Card size="small" title={`操作分布（近 ${days} 天）`}>
          <Space wrap size={12}>
            {stats.map((s) => (
              <Tag key={s.action} color={ACTION_META[s.action]?.color} style={{ padding: "2px 10px" }}>
                {ACTION_META[s.action]?.label || s.action} {s.n}
              </Tag>
            ))}
          </Space>
        </Card>
      )}

      <Card size="small">
        <Table<AuditLogRow>
          rowKey="id"
          loading={loading}
          dataSource={rows}
          size="middle"
          pagination={{
            current: page,
            pageSize: 50,
            total,
            showSizeChanger: false,
            showTotal: (t) => `共 ${t} 条`,
            onChange: (p) => setPage(p),
          }}
          columns={[
            {
              title: "时间",
              dataIndex: "ts",
              width: 165,
              render: (v: string) => (
                <Tooltip title={v}>
                  <span>{dayjs(v).format("MM-DD HH:mm:ss")}</span>
                </Tooltip>
              ),
            },
            {
              title: "操作",
              dataIndex: "action",
              width: 84,
              render: actionTag,
            },
            {
              title: "对象",
              dataIndex: "target_type",
              width: 110,
              render: (v: string) => targetLabel(v),
            },
            {
              title: "对象名称",
              dataIndex: "target_name",
              render: (v: string | null, r) => v || <Typography.Text type="secondary">—</Typography.Text>,
            },
            {
              title: "详情",
              dataIndex: "detail",
              render: (v: string | null) => <Typography.Text type="secondary">{detailText(v)}</Typography.Text>,
            },
            {
              title: "操作人",
              dataIndex: "user_name",
              width: 120,
              render: (v: string | null, r) => (
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
              render: (v: string | null) => v || <Typography.Text type="secondary">—</Typography.Text>,
            },
          ]}
        />
      </Card>
    </Space>
  );
}
