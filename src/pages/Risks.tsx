import { useState, useEffect, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Card, Table, Tag, Segmented, Empty, Spin, Button, Typography, message,
} from "antd";
import { ReloadOutlined, CheckCircleFilled } from "@ant-design/icons";
import { api } from "../api";
import type { RiskItem, RiskType, RiskLevel } from "../types";
import { RISK_TYPE_LABELS, RISK_LEVEL_LABELS, RISK_LEVEL_META, RISK_TYPE_ICONS } from "../types";
import { countdownText } from "../utils/risk";

const { Title, Text } = Typography;

const LEVELS: RiskLevel[] = ["red", "yellow", "green"];
const TYPES: RiskType[] = ["contract_end", "probation_end", "birthday", "resignation"];

export default function Risks() {
  const [items, setItems] = useState<RiskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [levelFilter, setLevelFilter] = useState<RiskLevel | "all">("all");
  const [typeFilter, setTypeFilter] = useState<RiskType | "all">("all");
  const [view, setView] = useState<"list" | "board">("list");

  const fetchRisks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getRisks();
      setItems(res.items);
    } catch (err) {
      message.error((err as Error).message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchRisks(); }, [fetchRisks]);

  // 级别分布（不受级别筛选影响，用于统计卡数字）
  const levelCounts = useMemo(() => {
    const c: Record<RiskLevel, number> = { red: 0, yellow: 0, green: 0 };
    items.forEach((i) => { c[i.level] += 1; });
    return c;
  }, [items]);

  // 先按级别筛选，再统计各类型数量（类型筛选器的角标随之联动）
  const levelScoped = useMemo(
    () => (levelFilter === "all" ? items : items.filter((i) => i.level === levelFilter)),
    [items, levelFilter]
  );

  const typeCounts = useMemo(() => {
    const c: Record<RiskType, number> = {
      contract_end: 0, probation_end: 0, birthday: 0, resignation: 0,
    };
    levelScoped.forEach((i) => { c[i.type] += 1; });
    return c;
  }, [levelScoped]);

  const rows = useMemo(
    () => (typeFilter === "all" ? levelScoped : levelScoped.filter((i) => i.type === typeFilter)),
    [levelScoped, typeFilter]
  );

  // 分栏视图：按级别归组
  const grouped = useMemo(() => {
    const g: Record<RiskLevel, RiskItem[]> = { red: [], yellow: [], green: [] };
    rows.forEach((i) => { g[i.level].push(i); });
    return g;
  }, [rows]);

  const toggleLevel = (lv: RiskLevel) =>
    setLevelFilter((prev) => (prev === lv ? "all" : lv));

  const columns = [
    {
      title: "姓名",
      dataIndex: "name",
      width: 150,
      render: (name: string, r: RiskItem) => (
        <Link to={`/talents/${r.talent_id}`} style={{ fontWeight: 600 }}>{name}</Link>
      ),
    },
    {
      title: "预警事项",
      dataIndex: "type",
      width: 160,
      render: (t: RiskType) => (
        <span>{RISK_TYPE_ICONS[t]} {RISK_TYPE_LABELS[t]}</span>
      ),
    },
    {
      title: "事项日期",
      dataIndex: "date",
      width: 140,
      render: (d: string) => <Text type="secondary">{d}</Text>,
    },
    {
      title: "倒计时",
      dataIndex: "days_left",
      width: 160,
      // 不设默认排序：保持后端「红→黄→绿，同级按天数升序」的顺序。
      // 若默认按天数排，生日黄级（仅 1–7 天）会被排到部分红色项之前，打乱分级。
      sorter: (a: RiskItem, b: RiskItem) => a.days_left - b.days_left,
      render: (days: number, r: RiskItem) => (
        <span style={{ color: RISK_LEVEL_META[r.level].color, fontWeight: 600 }}>
          {countdownText(days, r.type)}
        </span>
      ),
    },
    {
      title: "级别",
      dataIndex: "level",
      width: 110,
      render: (lv: RiskLevel) => (
        <Tag color={RISK_LEVEL_META[lv].tag} style={{ marginInlineEnd: 0 }}>
          {RISK_LEVEL_LABELS[lv]}
        </Tag>
      ),
    },
  ];

  const total = items.length;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>风险预警看板</Title>
          <Text type="secondary" style={{ fontSize: "0.82rem" }}>
            监控合同到期、试用期结束、生日与离职倒计时，按剩余天数自动分级
          </Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={fetchRisks} loading={loading}>刷新</Button>
      </div>

      {/* 红黄绿统计卡：点击可筛选，再点取消 */}
      <div className="risk-stats">
        <div
          className={`risk-stat risk-stat-total${levelFilter === "all" ? " active" : ""}`}
          onClick={() => setLevelFilter("all")}
        >
          <div className="risk-stat-bar" />
          <div className="risk-stat-value">{total}</div>
          <div className="risk-stat-label">全部预警 · 点击查看全部</div>
        </div>

        {LEVELS.map((lv) => {
          const meta = RISK_LEVEL_META[lv];
          return (
            <div
              key={lv}
              className={`risk-stat${levelFilter === lv ? " active" : ""}`}
              style={{ color: meta.color }}
              onClick={() => toggleLevel(lv)}
            >
              <div className="risk-stat-bar" />
              <div className="risk-stat-value">{levelCounts[lv]}</div>
              <div className="risk-stat-label">
                {meta.label} · {lv === "red" ? "逾期或 7 天内" : lv === "yellow" ? "临近需关注" : "提前提醒"}
              </div>
            </div>
          );
        })}
      </div>

      <Card
        styles={{ body: { paddingTop: 12 } }}
        title={
          <Segmented
            value={typeFilter}
            onChange={(v) => setTypeFilter(v as RiskType | "all")}
            options={[
              { label: `全部事项 ${levelScoped.length}`, value: "all" },
              ...TYPES.map((t) => ({
                label: `${RISK_TYPE_ICONS[t]} ${RISK_TYPE_LABELS[t]} ${typeCounts[t]}`,
                value: t,
              })),
            ]}
          />
        }
        extra={
          <Segmented
            size="small"
            value={view}
            onChange={(v) => setView(v as "list" | "board")}
            options={[
              { label: "列表", value: "list" },
              { label: "分栏", value: "board" },
            ]}
          />
        }
      >
        {loading ? (
          <div style={{ textAlign: "center", padding: "3rem" }}><Spin size="large" /></div>
        ) : rows.length === 0 ? (
          <Empty
            image={<CheckCircleFilled style={{ fontSize: 56, color: "#52c41a" }} />}
            description={
              total === 0
                ? "暂无风险预警，一切正常"
                : "当前筛选条件下没有预警事项"
            }
          />
        ) : view === "board" ? (
          <div className="risk-board">
            {LEVELS.map((lv) => {
              const meta = RISK_LEVEL_META[lv];
              const list = grouped[lv];
              return (
                <div key={lv} className="risk-board-col">
                  <div className="risk-board-head" style={{ background: meta.bg, color: meta.color }}>
                    <span className="date-dot" style={{ background: meta.color }} />
                    {meta.label}
                    <span style={{ color: "#8c8c8c", fontWeight: 400 }}>{list.length} 项</span>
                  </div>
                  <div className="risk-board-body">
                    {list.length === 0 ? (
                      <div style={{ padding: "1.5rem 0", textAlign: "center", fontSize: "0.78rem", color: "#bbb" }}>
                        无
                      </div>
                    ) : (
                      list.map((it) => (
                        <div
                          key={`${it.talent_id}-${it.type}`}
                          className="risk-board-card"
                          style={{ borderLeftColor: meta.color }}
                        >
                          <div className="risk-board-card-top">
                            <Link className="risk-board-card-name" to={`/talents/${it.talent_id}`}>
                              {it.name}
                            </Link>
                            <span style={{ color: meta.color, fontSize: "0.76rem", fontWeight: 600 }}>
                              {countdownText(it.days_left, it.type)}
                            </span>
                          </div>
                          <div className="risk-board-card-meta">
                            {RISK_TYPE_ICONS[it.type]} {RISK_TYPE_LABELS[it.type]} · {it.date}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <Table
            className="risk-table"
            rowKey={(r) => `${r.talent_id}-${r.type}`}
            columns={columns}
            dataSource={rows}
            rowClassName={(r) => `risk-row-${r.level}`}
            pagination={{
              defaultPageSize: 20,
              showSizeChanger: true,
              showTotal: (n) => `共 ${n} 条预警`,
            }}
          />
        )}

        {!loading && total > 0 && (
          <div style={{ marginTop: 12, fontSize: "0.78rem", color: "#999", lineHeight: 1.7 }}>
            分级规则：合同到期 逾期/≤7天<span style={{ color: "#ff4d4f" }}>红</span>、≤30天<span style={{ color: "#faad14" }}>黄</span>、≤90天<span style={{ color: "#52c41a" }}>绿</span>；
            试用期结束与离职倒计时 逾期/≤7天<span style={{ color: "#ff4d4f" }}>红</span>、≤15天<span style={{ color: "#faad14" }}>黄</span>、≤30天<span style={{ color: "#52c41a" }}>绿</span>；
            生日 当天<span style={{ color: "#ff4d4f" }}>红</span>、≤7天<span style={{ color: "#faad14" }}>黄</span>、≤30天<span style={{ color: "#52c41a" }}>绿</span>。
            <br />
            关键日期在 <Link to="/talents">人才库</Link> 编辑人才时录入，未填写的档案不参与预警。
          </div>
        )}
      </Card>
    </div>
  );
}
