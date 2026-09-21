import { useState, useEffect, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Card, Button, Select, Input, Space, Tag, Dropdown, message, Empty,
  Segmented, Spin, Tooltip, Modal, Timeline, Rate, Descriptions,
} from "antd";
import {
  ReloadOutlined, SearchOutlined, UserAddOutlined, MoreOutlined,
  ClockCircleOutlined, FilePdfOutlined, SwapOutlined, DeleteOutlined,
  HistoryOutlined, UserOutlined,
} from "@ant-design/icons";
import type { MenuProps } from "antd";
import { api } from "../api";
import type { PipelineCard, PipelineResponse, Stage, StageLog, Talent, User, Job } from "../types";
import {
  PIPELINE_STAGES, STAGE_META, SOURCE_OPTIONS, PRIORITY_LABELS,
} from "../types";
import AddToPipelineModal from "../components/AddToPipelineModal";

const EMPTY_COLUMNS: Record<string, PipelineCard[]> = Object.fromEntries(
  PIPELINE_STAGES.map((s) => [s.key, []])
);

export default function Pipeline() {
  const [columns, setColumns] = useState<Record<string, PipelineCard[]>>(EMPTY_COLUMNS);
  const [stats, setStats] = useState({ total: 0, active: 0, hired: 0, rejected: 0 });
  const [jobs, setJobs] = useState<Pick<Job, "id" | "title" | "status">[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);

  const [jobFilter, setJobFilter] = useState<string>("");
  const [ownerFilter, setOwnerFilter] = useState<string>("");
  const [draftQ, setDraftQ] = useState("");
  const [appliedQ, setAppliedQ] = useState("");
  // 看板视图：active 只显示进行中的 5 列；all 含终态 7 列
  const [view, setView] = useState<"active" | "all">("active");

  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [logModal, setLogModal] = useState<{ open: boolean; title: string; logs: StageLog[]; loading: boolean }>({
    open: false, title: "", logs: [], loading: false,
  });

  const currentUser: User | null = (() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  })();
  const isAdmin = currentUser?.role === "admin";

  const fetchPipeline = useCallback(async () => {
    setLoading(true);
    try {
      const res: PipelineResponse = await api.getPipeline({
        job_id: jobFilter || undefined,
        owner_id: ownerFilter || undefined,
        q: appliedQ || undefined,
      });
      setColumns({ ...EMPTY_COLUMNS, ...res.columns });
      setStats(res.stats);
    } catch (err) {
      message.error((err as Error).message);
    }
    setLoading(false);
  }, [jobFilter, ownerFilter, appliedQ]);

  useEffect(() => { fetchPipeline(); }, [fetchPipeline]);

  useEffect(() => {
    api.getJobOptions().then(setJobs).catch(() => {});
    if (isAdmin) api.getUsers().then(setUsers).catch(() => {});
  }, [isAdmin]);

  // 切换阶段（拖拽或菜单）
  const moveStage = async (linkId: string, toStage: Stage, talentName: string) => {
    const fromStage = Object.keys(columns).find((s) =>
      columns[s].some((c) => c.link_id === linkId)
    );
    if (fromStage === toStage) return;
    try {
      await api.updateStage(linkId, toStage);
      message.success(`「${talentName}」已流转到「${STAGE_META[toStage].label}」`);
      fetchPipeline();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleRemove = (card: PipelineCard) => {
    Modal.confirm({
      title: `确认将「${card.name}」移出该岗位？`,
      content: "人才档案本身不会删除，仅解除与本岗位的招聘流程关联。",
      okText: "移出",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await api.removeFromPipeline(card.link_id);
          message.success("已移出招聘流程");
          fetchPipeline();
        } catch (err) {
          message.error((err as Error).message);
        }
      },
    });
  };

  const openLogs = async (card: PipelineCard) => {
    setLogModal({ open: true, title: `${card.name} · 阶段流转记录`, logs: [], loading: true });
    try {
      const logs = await api.getStageLogs(card.link_id);
      setLogModal((m) => ({ ...m, logs, loading: false }));
    } catch (err) {
      message.error((err as Error).message);
      setLogModal((m) => ({ ...m, loading: false }));
    }
  };

  // 每列的阶段切换菜单（其余阶段 + 移出）
  const buildStageMenu = (card: PipelineCard): MenuProps["items"] => {
    const items: MenuProps["items"] = PIPELINE_STAGES
      .filter((s) => s.key !== card.stage)
      .map((s) => ({
        key: s.key,
        label: (
          <span>
            <span className="pipe-col-dot" style={{ background: s.color, display: "inline-block", marginRight: 8 }} />
            流转到 {s.label}
          </span>
        ),
      }));
    items.push({ type: "divider" });
    items.push({ key: "logs", label: "查看流转记录", icon: <HistoryOutlined /> });
    items.push({ key: "remove", label: "移出该岗位", icon: <DeleteOutlined />, danger: true });
    return items;
  };

  const onStageMenuClick = (card: PipelineCard, key: string) => {
    if (key === "logs") return openLogs(card);
    if (key === "remove") return handleRemove(card);
    moveStage(card.link_id, key as Stage, card.name);
  };

  const visibleStages = useMemo(
    () => (view === "active" ? PIPELINE_STAGES.filter((s) => !s.terminal) : PIPELINE_STAGES),
    [view]
  );

  const filtered = !!(jobFilter || ownerFilter || appliedQ);

  return (
    <div>
      {/* 顶部统计 + 操作 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <Space size="large" wrap>
          <span style={{ fontSize: 13, color: "#666" }}>
            进行中 <b style={{ fontSize: 18, color: "#3b82f6" }}>{stats.active}</b> 人
          </span>
          <span style={{ fontSize: 13, color: "#666" }}>
            已入职 <b style={{ fontSize: 18, color: "#10b981" }}>{stats.hired}</b> 人
          </span>
          <span style={{ fontSize: 13, color: "#666" }}>
            已淘汰 <b style={{ fontSize: 18, color: "#ef4444" }}>{stats.rejected}</b> 人
          </span>
          <span style={{ fontSize: 13, color: "#666" }}>
            流程内合计 <b style={{ fontSize: 18, color: "#262626" }}>{stats.total}</b> 人
          </span>
        </Space>
        <Space>
          <Segmented
            value={view}
            onChange={(v) => setView(v as "active" | "all")}
            options={[
              { label: "进行中", value: "active" },
              { label: "全部阶段", value: "all" },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={fetchPipeline} loading={loading}>刷新</Button>
          <Button type="primary" icon={<UserAddOutlined />} onClick={() => setAddOpen(true)}>
            加入招聘流程
          </Button>
        </Space>
      </div>

      {/* 筛选条 */}
      <Card style={{ marginBottom: 16 }} styles={{ body: { padding: 16 } }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={labelStyle}>岗位</span>
            <Select
              style={{ width: "100%" }} allowClear placeholder="全部岗位"
              value={jobFilter || undefined}
              onChange={(v) => setJobFilter(v || "")}
              options={jobs.map((j) => ({
                label: j.status === "closed" ? `${j.title}（已关闭）` : j.title,
                value: j.id,
              }))}
              showSearch
              optionFilterProp="label"
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={labelStyle}>候选人</span>
            <Input
              style={{ width: "100%" }} placeholder="姓名 / 职位 / 公司"
              value={draftQ}
              onChange={(e) => setDraftQ(e.target.value)}
              onPressEnter={() => setAppliedQ(draftQ)}
              allowClear
            />
          </div>
          {isAdmin && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={labelStyle}>创建人</span>
              <Select
                style={{ width: "100%" }} allowClear placeholder="全部"
                value={ownerFilter || undefined}
                onChange={(v) => setOwnerFilter(v || "")}
                options={users.map((u) => ({ label: u.name, value: u.id }))}
              />
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={labelStyle} />
            <Space>
              <Button type="primary" icon={<SearchOutlined />} onClick={() => setAppliedQ(draftQ)}>搜索</Button>
              <Button icon={<ReloadOutlined />} onClick={() => {
                setDraftQ(""); setAppliedQ(""); setJobFilter(""); setOwnerFilter("");
              }}>重置</Button>
            </Space>
          </div>
        </div>
      </Card>

      {/* 看板 */}
      {loading ? (
        <div style={{ textAlign: "center", padding: "4rem" }}><Spin size="large" /></div>
      ) : stats.total === 0 ? (
        <Card>
          <Empty
            description={
              filtered
                ? "当前筛选条件下没有候选人"
                : "招聘流程还是空的，点击右上角「加入招聘流程」把人才挂到岗位上"
            }
          />
        </Card>
      ) : (
        <div className="pipe-board">
          {visibleStages.map((s) => {
            const list = columns[s.key] || [];
            return (
              <div
                key={s.key}
                className="pipe-col"
                onDragOver={(e) => { e.preventDefault(); setDropTarget(s.key); }}
                onDragLeave={() => setDropTarget((t) => (t === s.key ? null : t))}
                onDrop={() => {
                  if (dragging) {
                    const card = Object.values(columns).flat().find((c) => c.link_id === dragging);
                    if (card) moveStage(dragging, s.key, card.name);
                  }
                  setDragging(null);
                  setDropTarget(null);
                }}
              >
                <div className="pipe-col-head" style={{ background: s.bg, color: s.color }}>
                  <span className="pipe-col-dot" style={{ background: s.color }} />
                  {s.label}
                  <span className="pipe-col-count">{list.length}</span>
                </div>
                <div className={`pipe-col-body${dropTarget === s.key ? " drop-target" : ""}`}>
                  {list.length === 0 ? (
                    <div className="pipe-empty">拖拽卡片到此</div>
                  ) : (
                    list.map((card) => (
                      <div
                        key={card.link_id}
                        className={`pipe-card${dragging === card.link_id ? " dragging" : ""}`}
                        draggable
                        onDragStart={() => setDragging(card.link_id)}
                        onDragEnd={() => { setDragging(null); setDropTarget(null); }}
                      >
                        <div className="pipe-card-top">
                          <Link className="pipe-card-name" to={`/talents/${card.talent_id}`}>
                            {card.name}
                          </Link>
                          <Dropdown
                            menu={{ items: buildStageMenu(card), onClick: ({ key }) => onStageMenuClick(card, key) }}
                            trigger={["click"]}
                          >
                            <Button type="text" size="small" icon={<MoreOutlined />} />
                          </Dropdown>
                        </div>

                        {(card.current_title || card.current_company) && (
                          <div className="pipe-card-sub">
                            {[card.current_title, card.current_company].filter(Boolean).join(" · ")}
                          </div>
                        )}

                        <div className="pipe-card-tags">
                          {card.job_title && (
                            <Tag color="blue" style={{ fontSize: 11, marginInlineEnd: 0 }}>
                              {card.job_title}
                            </Tag>
                          )}
                          {card.years_experience != null && (
                            <Tag style={{ fontSize: 11, marginInlineEnd: 0 }}>{card.years_experience}年</Tag>
                          )}
                          {card.education && (
                            <Tag style={{ fontSize: 11, marginInlineEnd: 0 }}>{card.education}</Tag>
                          )}
                          {card.city && (
                            <Tag style={{ fontSize: 11, marginInlineEnd: 0 }}>{card.city}</Tag>
                          )}
                        </div>

                        <div className="pipe-card-foot">
                          {card.days_in_stage >= 7 && !STAGE_META[card.stage]?.terminal ? (
                            <Tooltip title={`已在本阶段停留 ${card.days_in_stage} 天，建议尽快推进`}>
                              <span className="pipe-card-stale" style={{ color: "#fa541c" }}>
                                <ClockCircleOutlined /> 停留 {card.days_in_stage} 天
                              </span>
                            </Tooltip>
                          ) : (
                            <span style={{ fontSize: "0.72rem", color: "#a8adb5" }}>
                              {card.days_in_stage === 0 ? "今天更新" : `停留 ${card.days_in_stage} 天`}
                            </span>
                          )}
                          <Space size={2}>
                            {card.resume_url && (
                              <Tooltip title="查看简历">
                                <Link to={`/talents/${card.talent_id}`}>
                                  <Button type="text" size="small" icon={<FilePdfOutlined />} />
                                </Link>
                              </Tooltip>
                            )}
                            <Tooltip title="快速流转">
                              <Dropdown
                                menu={{
                                  items: PIPELINE_STAGES.filter((x) => x.key !== card.stage).map((x) => ({
                                    key: x.key, label: `流转到 ${x.label}`,
                                  })),
                                  onClick: ({ key }) => moveStage(card.link_id, key as Stage, card.name),
                                }}
                                trigger={["click"]}
                              >
                                <Button type="text" size="small" icon={<SwapOutlined />} />
                              </Dropdown>
                            </Tooltip>
                          </Space>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 加入招聘流程 */}
      <AddToPipelineModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSuccess={fetchPipeline}
      />

      {/* 流转记录 */}
      <Modal
        title={logModal.title}
        open={logModal.open}
        onCancel={() => setLogModal((m) => ({ ...m, open: false }))}
        footer={<Button onClick={() => setLogModal((m) => ({ ...m, open: false }))}>关闭</Button>}
        width={560}
      >
        {logModal.loading ? (
          <div style={{ textAlign: "center", padding: "2rem" }}><Spin /></div>
        ) : logModal.logs.length === 0 ? (
          <Empty description="暂无流转记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Timeline
            items={logModal.logs.map((l) => ({
              color: STAGE_META[l.to_stage]?.color || "blue",
              children: (
                <div>
                  <div style={{ fontSize: "0.85rem" }}>
                    {l.from_stage ? (
                      <>
                        <Tag style={{ fontSize: 11 }}>{STAGE_META[l.from_stage]?.label || l.from_stage}</Tag>
                        →
                      </>
                    ) : "加入流程："}
                    <Tag color={STAGE_META[l.to_stage]?.color} style={{ fontSize: 11 }}>
                      {STAGE_META[l.to_stage]?.label || l.to_stage}
                    </Tag>
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "#999", marginTop: 2 }}>
                    {l.user_name || "系统"} · {new Date(l.created_at + "Z").toLocaleString("zh-CN")}
                    {l.remark ? ` · ${l.remark}` : ""}
                  </div>
                </div>
              ),
            }))}
          />
        )}
      </Modal>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  width: 48, flexShrink: 0, textAlign: "right", fontSize: 13, color: "#666",
};
