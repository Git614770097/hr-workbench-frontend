import { useState, useEffect, useCallback, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Card, Button, Select, Input, Space, Tag, Dropdown, message, Empty,
  Segmented, Spin, Tooltip, Modal, Timeline, Rate, Descriptions, Alert, Typography,
  Checkbox,
} from "antd";
import {
  ReloadOutlined, SearchOutlined, UserAddOutlined, MoreOutlined,
  ClockCircleOutlined, FilePdfOutlined, SwapOutlined, DeleteOutlined,
  HistoryOutlined, UserOutlined, MessageOutlined,
  SyncOutlined, CheckCircleOutlined, CloseCircleOutlined, BarsOutlined,
  PhoneOutlined, CalendarOutlined, DownloadOutlined, FileTextOutlined,
} from "@ant-design/icons";
import type { MenuProps } from "antd";
import { api } from "../api";
import type { PipelineCard, PipelineResponse, Stage, StageLog, User, Job } from "../types";
import {
  PIPELINE_STAGES, STAGE_META, PRIORITY_LABELS,
} from "../types";
import { useDict } from "../dict";
import { fmtDate } from "../utils/time";
import AddToPipelineModal from "../components/AddToPipelineModal";
import AnimatedNumber from "../components/AnimatedNumber";
import { DemoSeedButton } from "../components/DemoSeed";
import { useIdentityProfile } from "../useIdentity";
import { termFor } from "../identityProfiles";
import { downloadBlob, dateStamp, csvCell, escapeHtml } from "../utils/file";
import OfferModal from "../components/OfferModal";

const EMPTY_COLUMNS: Record<string, PipelineCard[]> = Object.fromEntries(
  PIPELINE_STAGES.map((s) => [s.key, []])
);

// 复制到剪贴板（看板卡片电话一键复制；失败时给可感知的提示）
const copyText = async (text: string, label: string) => {
  try {
    await navigator.clipboard.writeText(text);
    message.success(`已复制${label}`);
  } catch {
    message.error("复制失败，请手动复制");
  }
};

export default function Pipeline() {
  const profile = useIdentityProfile();
  const { rejectReasons } = useDict();
  const navigate = useNavigate();
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
  // Offer 一键生成 / 发起审批 / 入职办理
  const [offerCard, setOfferCard] = useState<PipelineCard | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [logModal, setLogModal] = useState<{ open: boolean; title: string; logs: StageLog[]; loading: boolean }>({
    open: false, title: "", logs: [], loading: false,
  });
  // 批量选择：勾选卡片后一次性推进/淘汰，初筛环节最省点击
  const [selected, setSelected] = useState<string[]>([]);
  const [batchSaving, setBatchSaving] = useState(false);
  // 淘汰原因弹窗：单卡或批量共用（linkIds 长度 1 = 单卡；>1 = 批量，统一记一次原因）
  const [rejectModal, setRejectModal] = useState<{ linkIds: string[]; talentName: string } | null>(null);
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

  // 进入看板自动同步一次「阶段停滞」待办：停留 ≥7 天的候选人自动进待办，
  // 不用 HR 自己记着谁卡住了。接口幂等（只对齐不重复建），重复调用无副作用。
  useEffect(() => {
    if (loading) return;
    api.syncStaleTasks()
      .then((r) => {
        if (r.created > 0) {
          message.info(`已为 ${r.created} 位停留超过 7 天的候选人生成「阶段停滞」跟进待办`);
        }
      })
      .catch(() => {});
  }, [loading]);

  useEffect(() => {
    api.getJobOptions().then(setJobs).catch(() => {});
    if (isAdmin) api.getUsers().then(setUsers).catch(() => {});
  }, [isAdmin]);

  // ---- 批量选择（初筛一次刷掉一批人，不必逐张拖）----
  const toggleSelect = (linkId: string, checked: boolean) => {
    setSelected((prev) => (checked ? [...new Set([...prev, linkId])] : prev.filter((x) => x !== linkId)));
  };

  // 列头全选：整列一起处理，「这一列大部分都不要」时最省事
  const toggleColumn = (list: PipelineCard[], checked: boolean) => {
    const ids = list.map((c) => c.link_id);
    setSelected((prev) => {
      const rest = prev.filter((x) => !ids.includes(x));
      return checked ? [...new Set([...rest, ...ids])] : rest;
    });
  };

  // 批量推进：淘汰需统一选原因（走弹窗），其余直接批量流转
  const batchMove = async (toStage: Stage) => {
    if (selected.length === 0) return;
    if (toStage === "rejected") {
      setRejectReason("");
      setRejectNote("");
      setRejectModal({ linkIds: [...selected], talentName: `已选 ${selected.length} 人` });
      return;
    }
    setBatchSaving(true);
    try {
      const res = await api.batchUpdateStage({ link_ids: selected, stage: toStage });
      message.success(
        toStage === "hired"
          ? `已批量流转 ${res.updated} 人到「${STAGE_META[toStage].label}」${res.hired_linked > 0 ? `，生成 ${res.hired_linked} 条试用期跟进待办` : ""}`
          : `已批量流转 ${res.updated} 人到「${STAGE_META[toStage].label}」${res.skipped > 0 ? `（${res.skipped} 人已在该阶段，已跳过）` : ""}`
      );
      setSelected([]);
      fetchPipeline();
    } catch (err) {
      message.error((err as Error).message);
    }
    setBatchSaving(false);
  };

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
      setRejectModal({ linkIds: [linkId], talentName });
      return;
    }
    try {
      const res = await api.updateStage(linkId, toStage);
      if (toStage === "hired") {
        message.success(
          `「${talentName}」已入职，${termFor(profile, "人才状态")}已同步为「已入职」${res.task_created ? "，并生成试用期跟进待办" : ""}`
        );
      } else {
        message.success(`「${talentName}」已流转到「${STAGE_META[toStage].label}」`);
      }
      fetchPipeline();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  // 确认淘汰：带标准原因写入流转日志（单卡与批量共用，按 linkIds 数量分流）
  const confirmReject = async () => {
    if (!rejectModal || !rejectReason) return;
    const ids = rejectModal.linkIds;
    try {
      if (ids.length > 1) {
        const res = await api.batchUpdateStage({
          link_ids: ids, stage: "rejected", reject_reason: rejectReason, remark: rejectNote || undefined,
        });
        message.success(`已批量淘汰 ${res.updated} 人（${rejectReason}）`);
        setSelected([]);
      } else {
        await api.updateStage(ids[0], "rejected", rejectNote || undefined, rejectReason);
        message.success(`「${rejectModal.talentName}」已淘汰（${rejectReason}）`);
      }
      setRejectModal(null);
      fetchPipeline();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleRemove = (card: PipelineCard) => {
    Modal.confirm({
      title: termFor(profile, `确认将「${card.name}」移出该岗位？`),
      content: termFor(profile, "人才档案本身不会删除，仅解除与本岗位的招聘看板关联。"),
      okText: "移出",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: async () => {
        try {
          await api.removeFromPipeline(card.link_id);
          message.success(termFor(profile, "已移出招聘看板"));
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
    items.push({ key: "remove", label: termFor(profile, "移出该岗位"), icon: <DeleteOutlined />, danger: true });
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

  /** 导出当前视图下的看板明细（人才 × 岗位 × 阶段）为 CSV */
  const exportPipeline = () => {
    const rows: string[] = [];
    const stageKeys = visibleStages.map((s) => s.key);
    const total = stageKeys.reduce((n, k) => n + (columns[k] || []).length, 0);
    if (!total) { message.warning("当前视图下没有可导出的数据"); return; }

    const jobLabel = jobs.find((j) => j.id === jobFilter)?.title || termFor(profile, "全部岗位");
    const viewLabel = view === "active" ? "进行中" : "全部阶段";
    rows.push(termFor(profile, "招聘看板导出"));
    rows.push([termFor(profile, `岗位：${jobLabel}`), `视图：${viewLabel}`, `导出时间：${new Date().toLocaleString("zh-CN")}`].map(csvCell).join(","));
    rows.push("");

    rows.push(termFor(profile, "候选人,当前阶段,岗位,评分,当前职位,当前公司,年限,学历,城市,来源渠道,阶段停留(天),联系电话"));
    for (const k of stageKeys) {
      for (const c of columns[k] || []) {
        rows.push([
          c.name,
          STAGE_META[c.stage]?.label || c.stage,
          c.job_title || "—",
          c.rating != null ? c.rating : "—",
          c.current_title || "—",
          c.current_company || "—",
          c.years_experience != null ? c.years_experience : "—",
          c.education || "—",
          c.city || "—",
          c.source || "—",
          c.days_in_stage != null ? c.days_in_stage : "—",
          c.phone || "—",
        ].map(csvCell).join(","));
      }
    }

    const blob = new Blob(["\ufeff" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
    downloadBlob(blob, `${termFor(profile, "招聘看板")}_${dateStamp()}.csv`);
    message.success(`已导出 ${total} 条看板记录`);
  };

  return (
    <div className="page-fill">
      {/* 顶部统计 + 操作（统计复用 page-stats 的 stat 体系，语义色由 CSS 类接管、暗色自动适配） */}
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
          <Button icon={<DownloadOutlined />} onClick={exportPipeline}>导出</Button>
          <Button type="primary" icon={<UserAddOutlined />} onClick={() => setAddOpen(true)}>
            {termFor(profile, "加入招聘看板")}
          </Button>
        </Space>
      </div>

      {/* 筛选条 */}
      <Card className="search-card" style={{ marginBottom: 16 }} styles={{ body: { padding: 16 } }}>
        <div className="search-grid">
          <div className="search-field">
            <span className="search-label">{termFor(profile, "岗位")}</span>
            <div className="search-control">
            <Select
              style={{ width: "100%" }} allowClear placeholder={termFor(profile, "全部岗位")}
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

      {/* 批量操作条：勾选卡片后出现，一次推进或淘汰一批（初筛最省点击） */}
      {selected.length > 0 && (
        <Card className="pipe-batch-bar" style={{ marginBottom: 16 }} styles={{ body: { padding: 12 } }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Typography.Text strong>已选 {selected.length} 人</Typography.Text>
            <Dropdown
              trigger={["click"]}
              menu={{
                items: PIPELINE_STAGES.filter((s) => s.key !== "rejected").map((s) => ({
                  key: s.key,
                  label: (
                    <span>
                      <span className="pipe-col-dot" style={{ background: s.color, display: "inline-block", marginRight: 8 }} />
                      流转到 {s.label}
                    </span>
                  ),
                })),
                onClick: ({ key }) => batchMove(key as Stage),
              }}
            >
              <Button type="primary" loading={batchSaving}>批量推进到…</Button>
            </Dropdown>
            <Button danger disabled={batchSaving} onClick={() => batchMove("rejected")}>批量淘汰</Button>
            <Button type="link" onClick={() => setSelected([])}>取消选择</Button>
          </div>
        </Card>
      )}

      {/* 看板 */}
      {loading ? (
        <div style={{ textAlign: "center", padding: "4rem" }}><Spin size="large" /></div>
      ) : stats.total === 0 ? (
        <Card className="list-card">
          <Empty
            description={
              filtered
                ? "当前筛选条件下没有候选人"
                : termFor(profile, "招聘看板还是空的，点右上角把人才挂到岗位上")
            }
          >
            {!filtered && (
              <div style={{ marginTop: 8 }}>
                <DemoSeedButton onDone={fetchPipeline} />
                <div style={{ marginTop: 12, color: "#999", fontSize: 12 }}>
                  {termFor(profile, "载入后即可体验拖拽流转与招聘漏斗，数据可一键清除")}
                </div>
              </div>
            )}
          </Empty>
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
                  <Checkbox
                    checked={list.length > 0 && list.every((c) => selected.includes(c.link_id))}
                    indeterminate={
                      list.some((c) => selected.includes(c.link_id)) &&
                      !list.every((c) => selected.includes(c.link_id))
                    }
                    onChange={(e) => toggleColumn(list, e.target.checked)}
                    style={{ marginInlineEnd: 2 }}
                  />
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
                        className={`pipe-card${dragging === card.link_id ? " dragging" : ""}${stale14 ? " pipe-card-stalehot" : ""}${selected.includes(card.link_id) ? " pipe-card-selected" : ""}`}
                        draggable
                        onDragStart={() => setDragging(card.link_id)}
                        onDragEnd={() => { setDragging(null); setDropTarget(null); }}
                      >
                        <div className="pipe-card-top">
                          <span className="pipe-card-title">
                            <Checkbox
                              checked={selected.includes(card.link_id)}
                              onChange={(e) => toggleSelect(card.link_id, e.target.checked)}
                            />
                            <Link className="pipe-card-name" to={`/talents/${card.talent_id}`}>
                              {card.name}
                            </Link>
                          </span>
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
                            <Tooltip title={termFor(profile, "点击聚焦该岗位的候选人")}>
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
                              title={termFor(profile, "阶段评分（1-5）：可在人才详情的投递记录中调整")}
                            >
                              ★ {card.rating}
                            </Tag>
                          )}
                        </div>

                        {/* 静态属性合并为一行次要文字，降噪（原先 3 个 Tag） */}
                        {(card.years_experience != null || card.education || card.city || card.source) && (
                          <div className="pipe-card-meta">
                            {[
                              card.years_experience != null ? `${card.years_experience}年经验` : null,
                              card.education,
                              card.city,
                              card.source ? `来源 ${card.source}` : null,
                            ].filter(Boolean).join(" · ")}
                          </div>
                        )}

                        {card.stage_notes && (
                          <Tooltip title={card.stage_notes} placement="topLeft">
                            <div className="pipe-card-note">
                              <MessageOutlined /> {card.stage_notes}
                            </div>
                          </Tooltip>
                        )}

                        <div className="pipe-card-foot">
                          <div className="pipe-card-foot-left">
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
                            {card.next_follow && (
                              <Tooltip title={`有未完成的跟进待办，最早到期日 ${fmtDate(card.next_follow)}`}>
                                <span className="pipe-next">
                                  <CalendarOutlined /> 跟进 {fmtDate(card.next_follow)}
                                </span>
                              </Tooltip>
                            )}
                            {card.next_interview_at && (
                              <Tooltip title={`有待面试安排：${fmtDate(card.next_interview_at)}${card.next_interview_mode === "online" ? "（线上面试）" : card.next_interview_mode === "onsite" ? "（线下面试）" : "（电话面试）"}`}>
                                <span className="pipe-next">
                                  <CalendarOutlined /> 面试 {fmtDate(card.next_interview_at)}
                                </span>
                              </Tooltip>
                            )}
                            {card.owner_name && (
                              <Tooltip title="负责人">
                                <span className="pipe-owner"><UserOutlined /> {card.owner_name}</span>
                              </Tooltip>
                            )}
                          </div>
                          <Space size={2} className="pipe-card-acts">
                            {card.stage === "offer" && (
                              <Tooltip title="生成 Offer / 发起审批">
                                <Button
                                  type="text"
                                  size="small"
                                  icon={<FileTextOutlined />}
                                  onClick={() => setOfferCard(card)}
                                />
                              </Tooltip>
                            )}
                            {card.phone && (
                              <Tooltip title={`复制电话 ${card.phone}`}>
                                <Button
                                  type="text"
                                  size="small"
                                  icon={<PhoneOutlined />}
                                  onClick={() => copyText(card.phone!, "电话")}
                                />
                              </Tooltip>
                            )}
                            {card.resume_url && (
                              <Tooltip title="查看简历">
                                {/* 用 navigate 而非 <Link><Button/></Link>：<a> 里嵌 <button> 是非法 HTML，
                                    部分浏览器下点击会被外层 <a> 抢走，表现为「点了没反应」。 */}
                                <Button
                                  type="text"
                                  size="small"
                                  icon={<FilePdfOutlined />}
                                  onClick={() => navigate(`/talents/${card.talent_id}`)}
                                />
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

      {/* 加入招聘看板 */}
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
          options={rejectReasons.map((r) => ({ label: r, value: r }))}
        />
        <Input.TextArea
          rows={2}
          style={{ marginTop: 12 }}
          placeholder="补充说明（选填）：如面试反馈细节、谈薪分歧点…"
          value={rejectNote}
          onChange={(e) => setRejectNote(e.target.value)}
        />
      </Modal>

      <OfferModal
        card={offerCard}
        open={!!offerCard}
        onClose={() => setOfferCard(null)}
        onApproved={fetchPipeline}
      />
    </div>
  );
}
