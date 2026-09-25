import { useState, useEffect, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Card, Button, Select, Input, Space, Tag, Dropdown, message, Empty,
  Segmented, Spin, Tooltip, Modal, Timeline, Rate, Descriptions, Alert, Typography,
} from "antd";
import {
  ReloadOutlined, SearchOutlined, UserAddOutlined, MoreOutlined,
  ClockCircleOutlined, FilePdfOutlined, SwapOutlined, DeleteOutlined,
  HistoryOutlined, UserOutlined, MessageOutlined,
  SyncOutlined, CheckCircleOutlined, CloseCircleOutlined, BarsOutlined,
} from "@ant-design/icons";
import type { MenuProps } from "antd";
import { api } from "../api";
import type { PipelineCard, PipelineResponse, Stage, StageLog, Talent, User, Job } from "../types";
import {
  PIPELINE_STAGES, STAGE_META, SOURCE_OPTIONS, PRIORITY_LABELS, REJECT_REASONS,
} from "../types";
import AddToPipelineModal from "../components/AddToPipelineModal";
import AnimatedNumber from "../components/AnimatedNumber";

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
  // 淘汰原因弹窗：拖入「已淘汰」先选标准原因（受控 state，不依赖 Form 取值）
  const [rejectModal, setRejectModal] = useState<{ linkId: string; talentName: string } | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectNote, setRejectNote] = useState("");

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
    // 淘汰前必须选标准原因：结构化记录用于漏斗「淘汰原因分布」，反哺 JD 与画像修正
    if (toStage === "rejected") {
      setRejectReason("");
      setRejectNote("");
      setRejectModal({ linkId, talentName });
      return;
    }
    try {
      const res = await api.updateStage(linkId, toStage);
      if (toStage === "hired") {
        message.success(
          `「${talentName}」已入职，人才状态已同步为「已入职」${res.task_created ? "，并生成试用期跟进待办" : ""}`
        );
      } else {
        message.success(`「${talentName}」已流转到「${STAGE_META[toStage].label}」`);
      }
      fetchPipeline();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  // 确认淘汰：带标准原因写入流转日志
  const confirmReject = async () => {
    if (!rejectModal || !rejectReason) return;
    try {
      await api.updateStage(rejectModal.linkId, "rejected", rejectNote || undefined, rejectReason);
      message.success(`「${rejectModal.talentName}」已淘汰（${rejectReason}）`);
      setRejectModal(null);
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
      {/* 顶部统计 + 操作（统计复用 page-head 的 stat 体系，语义色由 CSS 类接管、暗色自动适配） */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <div className="page-stats">
          <div className="stat">
            <span className="stat-icon is-neutral"><SyncOutlined /></span>
            <span className="stat-body">
              <span className="stat-num"><AnimatedNumber value={stats.active} format={(n) => Math.round(n).toLocaleString("zh-CN")} /></span>
              <span className="stat-label">进行中</span>
            </span>
          </div>
          <div className="stat">
            <span className="stat-icon is-good"><CheckCircleOutlined /></span>
            <span className="stat-body">
              <span className="stat-num is-good"><AnimatedNumber value={stats.hired} format={(n) => Math.round(n).toLocaleString("zh-CN")} /></span>
              <span className="stat-label">已入职</span>
            </span>
          </div>
          <div className="stat">
            <span className="stat-icon is-bad"><CloseCircleOutlined /></span>
            <span className="stat-body">
              <span className="stat-num is-bad"><AnimatedNumber value={stats.rejected} format={(n) => Math.round(n).toLocaleString("zh-CN")} /></span>
              <span className="stat-label">已淘汰</span>
            </span>
          </div>
          <div className="stat">
            <span className="stat-icon is-neutral"><BarsOutlined /></span>
            <span className="stat-body">
              <span className="stat-num is-neutral"><AnimatedNumber value={stats.total} format={(n) => Math.round(n).toLocaleString("zh-CN")} /></span>
              <span className="stat-label">流程内合计</span>
            </span>
          </div>
        </div>
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
      <Card className="search-card" style={{ marginBottom: 16 }} styles={{ body: { padding: 16 } }}>
        <div className="search-grid">
          <div className="search-field">
            <span className="search-label">岗位</span>
            <div className="search-control">
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
          </div>
          <div className="search-field">
            <span className="search-label">候选人</span>
            <div className="search-control">
            <Input
              style={{ width: "100%" }} placeholder="姓名 / 职位 / 公司"
              value={draftQ}
              onChange={(e) => setDraftQ(e.target.value)}
              onPressEnter={() => setAppliedQ(draftQ)}
              allowClear
            />
            </div>
          </div>
          {isAdmin && (
            <div className="search-field">
              <span className="search-label">创建人</span>
              <div className="search-control">
              <Select
                style={{ width: "100%" }} allowClear placeholder="全部"
                value={ownerFilter || undefined}
                onChange={(v) => setOwnerFilter(v || "")}
                options={users.map((u) => ({ label: u.name, value: u.id }))}
              />
              </div>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
            <Button icon={<ReloadOutlined />} onClick={() => {
              setDraftQ(""); setAppliedQ(""); setJobFilter(""); setOwnerFilter("");
            }}>重置</Button>
            <Button type="primary" icon={<SearchOutlined />} onClick={() => setAppliedQ(draftQ)}>查询</Button>
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
                    list.map((card) => {
                      // 停留预警分级：≥7 天黄色、≥14 天红色（仅非终态阶段）
                      const stale14 = card.days_in_stage >= 14 && !STAGE_META[card.stage]?.terminal;
                      const stale7 = card.days_in_stage >= 7 && !STAGE_META[card.stage]?.terminal;
                      return (
                      <div
                        key={card.link_id}
                        className={`pipe-card${dragging === card.link_id ? " dragging" : ""}${stale14 ? " pipe-card-stalehot" : ""}`}
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
                            <Tooltip title="点击聚焦该岗位的候选人">
                              <Tag
                                color="blue"
                                style={{ fontSize: 11, marginInlineEnd: 0, cursor: "pointer" }}
                                onClick={() => card.job_id && setJobFilter(card.job_id)}
                              >
                                {card.job_title}
                              </Tag>
                            </Tooltip>
                          )}
                          {card.rating != null && (
                            <Tag
                              color={card.rating >= 4 ? "gold" : card.rating === 3 ? "orange" : undefined}
                              style={{ fontSize: 11, marginInlineEnd: 0 }}
                              title="阶段评分（1-5）：可在人才详情的投递记录中调整"
                            >
                              ★ {card.rating}
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

                        {card.stage_notes && (
                          <Tooltip title={card.stage_notes} placement="topLeft">
                            <div className="pipe-card-note">
                              <MessageOutlined /> {card.stage_notes}
                            </div>
                          </Tooltip>
                        )}

                        <div className="pipe-card-foot">
                          {stale7 ? (
                            <Tooltip title={`已在本阶段停留 ${card.days_in_stage} 天，${stale14 ? "超过 14 天，请立即推进、约面或释放" : "建议尽快推进"}`}>
                              <span className={`pipe-stale${stale14 ? " hot" : " warn"}`}>
                                <ClockCircleOutlined /> {stale14 ? "停留超时" : "停留偏久"} {card.days_in_stage} 天
                              </span>
                            </Tooltip>
                          ) : (
                            <span className="pipe-stale">
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
                      );
                    })
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
                  <Typography.Text type="secondary" style={{ fontSize: "0.75rem", display: "block", marginTop: 2 }}>
                    {l.user_name || "系统"} · {new Date(l.created_at + "Z").toLocaleString("zh-CN")}
                    {l.remark ? ` · ${l.remark}` : ""}
                  </Typography.Text>
                </div>
              ),
            }))}
          />
        )}
      </Modal>

      {/* 淘汰原因：拖入「已淘汰」时先记录标准原因（受控 state，供漏斗分布统计） */}
      <Modal
        title={`淘汰原因 · ${rejectModal?.talentName || ""}`}
        open={!!rejectModal}
        onOk={confirmReject}
        onCancel={() => setRejectModal(null)}
        okText="确认淘汰"
        okButtonProps={{ danger: true, disabled: !rejectReason }}
        cancelText="取消"
        width={480}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="标准原因会进入漏斗「淘汰原因分布」，用于复盘 JD 与画像；补充说明仅供团队参考。"
        />
        <Select
          placeholder="选择淘汰原因（必选）"
          style={{ width: "100%" }}
          value={rejectReason || undefined}
          onChange={(v) => setRejectReason(v || "")}
          options={REJECT_REASONS.map((r) => ({ label: r, value: r }))}
        />
        <Input.TextArea
          rows={2}
          style={{ marginTop: 12 }}
          placeholder="补充说明（选填）：如面试反馈细节、谈薪分歧点…"
          value={rejectNote}
          onChange={(e) => setRejectNote(e.target.value)}
        />
      </Modal>
    </div>
  );
}
