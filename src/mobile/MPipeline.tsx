import { useEffect, useMemo, useState } from "react";
import { Select, Input, Drawer, Button, Tag, Rate, Timeline, Popconfirm, message, Spin } from "antd";
import { ArrowRightOutlined, CloseCircleOutlined, DeleteOutlined, StarOutlined } from "@ant-design/icons";
import { api } from "../api";
import type { PipelineCard, PipelineResponse, Stage, StageLog } from "../types";
import { PIPELINE_STAGES } from "../types";
import { useDict } from "../dict";
import { useIdentityProfile } from "../useIdentity";
import { termFor } from "../identityProfiles";

// 手机上横向多列看板放不下，改成「一次看一个阶段」的横向 Tab
const VISIBLE_STAGES = PIPELINE_STAGES.filter(
  (s) => !s.terminal || s.key === "rejected"
);

export default function MPipeline() {
  const { rejectReasons } = useDict();
  const profile = useIdentityProfile();
  const [data, setData] = useState<PipelineResponse | null>(null);
  const [jobs, setJobs] = useState<{ id: string; title: string }[]>([]);
  const [jobFilter, setJobFilter] = useState<string>("");
  const [q, setQ] = useState("");
  const [stage, setStage] = useState<Stage>("screening");
  const [loading, setLoading] = useState(true);

  const [card, setCard] = useState<PipelineCard | null>(null);
  const [reason, setReason] = useState("");
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [logs, setLogs] = useState<StageLog[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.getPipeline({ job_id: jobFilter || undefined, q: q || undefined });
      setData(res);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [jobFilter, q]);

  useEffect(() => {
    api.getJobOptions().then((r) => setJobs(r.map((j) => ({ id: j.id, title: j.title })))).catch(() => {});
  }, []);

  const cards = useMemo(() => (data?.columns?.[stage] || []), [data, stage]);

  const nextStage = (cur: Stage) => {
    const i = PIPELINE_STAGES.findIndex((s) => s.key === cur);
    if (i < 0) return null;
    const n = PIPELINE_STAGES[i + 1];
    // 淘汰 / 放弃走独立入口，不作为「推进」
    if (!n || n.key === "rejected" || n.key === "withdrawn") return null;
    return n;
  };

  const openCard = async (c: PipelineCard) => {
    setCard(c);
    setReason("");
    setRemark("");
    setLogs([]);
    try {
      setLogs(await api.getStageLogs(c.link_id));
    } catch {
      // 记录拉不到不影响操作
    }
  };

  const move = async (to: Stage, rejectReason?: string) => {
    if (!card) return;
    setSaving(true);
    try {
      await api.updateStage(card.link_id, to, remark || undefined, rejectReason);
      message.success(`已${to === "rejected" ? "淘汰" : `推进到「${PIPELINE_STAGES.find((s) => s.key === to)?.label}」`}`);
      setCard(null);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!card) return;
    try {
      await api.removeFromPipeline(card.link_id);
      message.success("已移出流程");
      setCard(null);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const next = card ? nextStage(card.stage) : null;

  return (
    <div>
      <div className="m-filter">
        <Input.Search
          placeholder={termFor(profile, "搜索姓名 / 岗位")}
          allowClear
          onSearch={(v) => setQ(v.trim())}
          style={{ flex: 1 }}
        />
      </div>
      <div className="m-filter">
        <Select
          placeholder={termFor(profile, "全部岗位")}
          allowClear
          value={jobFilter || undefined}
          onChange={(v) => setJobFilter(v || "")}
          options={jobs.map((j) => ({ value: j.id, label: j.title }))}
          style={{ flex: 1 }}
        />
      </div>

      <div className="m-stage-tabs">
        {VISIBLE_STAGES.map((s) => (
          <button
            key={s.key}
            className={`m-stage-tab${stage === s.key ? " active" : ""}`}
            onClick={() => setStage(s.key)}
          >
            {s.label}
            <span className="m-stage-count">{data?.columns?.[s.key]?.length || 0}</span>
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "40px 0" }}>
          <Spin />
        </div>
      ) : cards.length === 0 ? (
        <div className="m-empty">该阶段暂无候选人</div>
      ) : (
        cards.map((c) => (
          <div key={c.link_id} className="m-card" onClick={() => openCard(c)}>
            <div className="m-card-row" style={{ justifyContent: "space-between" }}>
              <span className="m-card-title">{c.name}</span>
              {c.rating ? (
                <span style={{ flex: "none", display: "flex", alignItems: "center", gap: 2, color: "#f59e0b" }}>
                  <StarOutlined />
                  {c.rating}
                </span>
              ) : null}
            </div>
            <div className="m-card-meta">{c.job_title || termFor(profile, "未关联岗位")}</div>
            <div className="m-card-meta">
              停留 {c.days_in_stage} 天
              {c.next_follow ? ` · 下次跟进 ${c.next_follow.slice(0, 10)}` : ""}
              {c.source ? ` · ${c.source}` : ""}
            </div>
          </div>
        ))
      )}

      <Drawer
        rootClassName="m-drawer"
        placement="bottom"
        open={!!card}
        onClose={() => setCard(null)}
        height="auto"
        styles={{ body: { paddingBottom: 20, maxHeight: "70vh", overflowY: "auto" } }}
      >
        {card ? (
          <div>
            <div className="m-sheet-title">{card.name}</div>
            <div className="m-sheet-sub">
              {card.job_title || termFor(profile, "未关联岗位")}
              {card.phone ? ` · ${card.phone}` : ""}
            </div>
            {card.rating ? <Rate disabled value={card.rating} style={{ fontSize: 16 }} /> : null}

            <div className="m-field-label">备注（随本次流转一起记录）</div>
            <Input.TextArea
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              rows={2}
              placeholder="面试印象、待办事项…"
            />

            <div className="m-actions">
              {next ? (
                <Button block type="primary" icon={<ArrowRightOutlined />} loading={saving} onClick={() => move(next.key)}>
                  推进到「{next.label}」
                </Button>
              ) : null}

              <div className="m-field-label">流转到其他阶段</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {PIPELINE_STAGES.filter((s) => s.key !== card.stage && s.key !== "rejected" && s.key !== "withdrawn").map(
                  (s) => (
                    <Tag
                      key={s.key}
                      color={s.color}
                      style={{ padding: "6px 12px", fontSize: 14, cursor: "pointer" }}
                      onClick={() => move(s.key)}
                    >
                      {s.label}
                    </Tag>
                  )
                )}
              </div>

              <div className="m-field-label">淘汰（需选原因）</div>
              <div style={{ display: "flex", gap: 8 }}>
                <Select
                  placeholder="选择淘汰原因"
                  value={reason || undefined}
                  onChange={setReason}
                  options={rejectReasons.map((r) => ({ value: r, label: r }))}
                  style={{ flex: 1 }}
                />
                <Button danger icon={<CloseCircleOutlined />} disabled={!reason} loading={saving} onClick={() => move("rejected", reason)}>
                  淘汰
                </Button>
              </div>

              <Popconfirm title="从招聘流程中移除？历史记录会一并清除" onConfirm={remove} okText="移除" cancelText="取消">
                <Button block danger icon={<DeleteOutlined />}>
                  移出流程
                </Button>
              </Popconfirm>
            </div>

            {logs.length > 0 ? (
              <>
                <div className="m-field-label">流转记录</div>
                <Timeline
                  items={logs.map((l) => ({
                    children: (
                      <span style={{ fontSize: 13 }}>
                        {PIPELINE_STAGES.find((s) => s.key === l.to_stage)?.label || l.to_stage}
                        <span style={{ color: "var(--m-text-sub)", marginLeft: 6 }}>
                          {(l.created_at || "").slice(0, 10)}
                        </span>
                        {l.remark ? <div style={{ color: "var(--m-text-sub)" }}>{l.remark}</div> : null}
                      </span>
                    ),
                  }))}
                />
              </>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
