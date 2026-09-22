import { useState, useEffect } from "react";
import { Modal, Typography, Tag, Empty, Spin, Alert, Button, Radio, Popconfirm, message, Tooltip } from "antd";
import { MergeCellsOutlined, WarningOutlined, FileTextOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { DuplicateGroup, DuplicateTalentItem } from "../types";
import { STATUS_LABELS, STATUS_COLORS, MERGE_FIELDS, MERGE_FIELD_LABELS, duplicateWeight } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 合并成功后通知外层刷新人才列表 */
  onMerged?: () => void;
}

/** 按关联数据量推荐一条最值得保留的记录 */
function recommendedId(items: DuplicateTalentItem[]): string {
  let best = items[0];
  for (const it of items) if (duplicateWeight(it) > duplicateWeight(best)) best = it;
  return best?.id || "";
}

/** 合并预览：基于 keep 已填字段与各来源已填字段，推导补入项与「内容不同」的冲突项。
 *  冲突项才是真正需要注意的——来源里的这份内容合并后会被保留记录的值覆盖掉。 */
function previewMerge(keep: DuplicateTalentItem, sources: DuplicateTalentItem[]) {
  const fillIn: string[] = [];
  const conflict: string[] = [];
  for (const f of MERGE_FIELDS) {
    const srcHas = sources.filter((s) => s.sig[f] !== undefined);
    if (srcHas.length === 0) continue;
    const keepSig = keep.sig[f];
    if (keepSig === undefined) {
      fillIn.push(MERGE_FIELD_LABELS[f] || f);
    } else if (srcHas.some((s) => s.sig[f] !== keepSig)) {
      conflict.push(MERGE_FIELD_LABELS[f] || f);
    }
    // keepSig 存在且全部相同 → 内容一致，合并无影响，不提示
  }
  // 保留记录没有简历时才会借用来源简历，否则来源的简历文件会被清理掉
  const resumeDiscarded = !keep.has_resume && sources.some((s) => s.has_resume);
  return { fillIn, conflict, resumeDiscarded };
}

// 疑似重复检测：按手机号分组的重复人才，可选中保留一条、其余一键合并，或进详情页处理
export default function DuplicateTalentsModal({ open, onClose, onMerged }: Props) {
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [error, setError] = useState("");
  // 每组选中的「保留」记录：{ 手机号: 人才id }，默认取关联数据最多的一条
  const [keepMap, setKeepMap] = useState<Record<string, string>>({});
  const [mergingPhone, setMergingPhone] = useState<string | null>(null);

  const applyGroups = (gs: DuplicateGroup[]) => {
    setGroups(gs);
    setKeepMap((prev) => {
      const next: Record<string, string> = {};
      for (const g of gs) {
        // 用户已选过就尊重用户选择，否则给推荐值
        const prevId = prev[g.phone];
        next[g.phone] = prevId && g.items.some((it) => it.id === prevId) ? prevId : recommendedId(g.items);
      }
      return next;
    });
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    api.getDuplicateTalents()
      .then((res) => { if (!cancelled) applyGroups(res.groups); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const handleMerge = async (g: DuplicateGroup) => {
    const keepId = keepMap[g.phone] || recommendedId(g.items);
    const mergeIds = g.items.filter((it) => it.id !== keepId).map((it) => it.id);
    if (!keepId || mergeIds.length === 0) return;
    setMergingPhone(g.phone);
    try {
      await api.mergeTalents(keepId, mergeIds);
      message.success(`已把 ${g.items.length} 条合并为 1 条`);
      onMerged?.();
      const res = await api.getDuplicateTalents();
      // 这组已消失，清掉它的选择，避免残留脏 key
      setKeepMap((prev) => { const next = { ...prev }; delete next[g.phone]; return next; });
      applyGroups(res.groups);
    } catch (e) {
      message.error((e as Error).message);
    }
    setMergingPhone(null);
  };

  return (
    <Modal title="疑似重复人才" open={open} onCancel={onClose} footer={null} width={880} destroyOnClose>
      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem" }}><Spin /></div>
      ) : error ? (
        <Alert type="error" showIcon message={error} />
      ) : groups.length === 0 ? (
        <Empty description="没有发现手机号重复的人才" />
      ) : (
        <>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
            以下 {groups.length} 组人才手机号相同，可能是重复录入。选中要<b>保留</b>的一条，
            其余会被并入后删除（<b>只补空字段，不覆盖</b>已有内容；沟通记录、标签、应聘岗位会一并迁移）。
            默认勾选关联数据最多的一条；若提示「内容不一样」，建议先点姓名进详情页比对再合并。
          </Typography.Paragraph>
          <div style={{ maxHeight: "64vh", overflowY: "auto" }}>
            {groups.map((g) => {
              const keepId = keepMap[g.phone] || recommendedId(g.items);
              const keep = g.items.find((it) => it.id === keepId);
              const sources = g.items.filter((it) => it.id !== keepId);
              const recId = recommendedId(g.items);
              const names = Array.from(new Set(g.items.map((it) => (it.name || "").trim()).filter(Boolean)));
              const pv = keep ? previewMerge(keep, sources) : { fillIn: [], conflict: [], resumeDiscarded: false };
              const moved = sources.reduce((n, s) => n + s.job_count + s.comm_count + s.tag_count, 0);
              return (
                <div key={g.phone} style={{ border: "1px solid #f0f0f0", borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>
                  <div style={{ background: "#fafafa", padding: "6px 10px", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                    <span>手机号 {g.phone}</span>
                    <Tag color="orange" style={{ marginInlineEnd: 0 }}>{g.items.length} 条</Tag>
                    {names.length > 1 && (
                      <Tag icon={<WarningOutlined />} color="red" style={{ marginInlineEnd: 0 }}>
                        姓名不一致（{names.join(" / ")}）
                      </Tag>
                    )}
                  </div>
                  <Radio.Group
                    value={keepId}
                    onChange={(e) => setKeepMap((prev) => ({ ...prev, [g.phone]: e.target.value }))}
                    style={{ display: "block", width: "100%" }}
                  >
                    {g.items.map((it) => (
                      <div
                        key={it.id}
                        style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderTop: "1px solid #f5f5f5" }}
                      >
                        <Radio value={it.id} />
                        <Link to={`/talents/${it.id}`} onClick={onClose} style={{ fontWeight: 600, minWidth: 64, flex: "0 0 auto" }}>
                          {it.name || "未命名"}
                        </Link>
                        {it.id === recId && <Tag color="blue" style={{ marginInlineEnd: 0 }}>推荐</Tag>}
                        <span style={{ color: "#666", fontSize: 13, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {[it.current_company, it.current_title, it.city, it.education].filter(Boolean).join(" · ") || "—"}
                        </span>
                        <span style={{ fontSize: 12, color: "#999", flex: "0 0 auto" }}>
                          {it.has_resume ? <FileTextOutlined title="已上传简历" style={{ marginInlineEnd: 6 }} /> : null}
                          岗位 {it.job_count} · 沟通 {it.comm_count} · 标签 {it.tag_count}
                        </span>
                        {it.status && (
                          <Tag color={STATUS_COLORS[it.status] || "default"} style={{ marginInlineEnd: 0, flex: "0 0 auto" }}>
                            {STATUS_LABELS[it.status] || it.status}
                          </Tag>
                        )}
                      </div>
                    ))}
                  </Radio.Group>
                  <div style={{ padding: "8px 10px", borderTop: "1px solid #f5f5f5", background: "#fcfcfc", fontSize: 12 }}>
                    <div style={{ color: "#666", marginBottom: 6 }}>
                      保留「<b>{keep?.name || "未命名"}</b>」，其余 {sources.length} 条并入后删除
                      {moved > 0 && <>；将迁移 {moved} 条关联数据</>}
                      {pv.fillIn.length > 0
                        ? <>；将补入 {pv.fillIn.length} 项（{pv.fillIn.join("、")}）</>
                        : <>；无空字段可补</>}
                    </div>
                    {pv.conflict.length > 0 && (
                      <div style={{ color: "#d46b08", marginBottom: 6 }}>
                        <WarningOutlined style={{ marginInlineEnd: 4 }} />
                        这几项两边内容不一样，合并后以保留记录为准：
                        <Tooltip title="点姓名进详情页比对两份内容，确认保留哪一份更准确">
                          <span style={{ borderBottom: "1px dashed #d46b08" }}>
                            {pv.conflict.join("、")}（共 {pv.conflict.length} 项）
                          </span>
                        </Tooltip>
                      </div>
                    )}
                    {pv.resumeDiscarded && (
                      <div style={{ color: "#cf1322", marginBottom: 6 }}>
                        <WarningOutlined style={{ marginInlineEnd: 4 }} />
                        保留记录已有简历，来源记录的简历文件会被一并清理（保留记录未上传简历时才会借用来源的）。
                      </div>
                    )}
                    <div style={{ textAlign: "right" }}>
                      <Popconfirm
                        title="确认合并？"
                        description={`将保留「${keep?.name || "未命名"}」，其余 ${sources.length} 条会被删除且无法恢复。`}
                        okText="确认合并"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => handleMerge(g)}
                      >
                        <Button type="primary" size="small" icon={<MergeCellsOutlined />} loading={mergingPhone === g.phone}>
                          合并为一条
                        </Button>
                      </Popconfirm>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Modal>
  );
}
