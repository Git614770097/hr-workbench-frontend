import { useState, useEffect } from "react";
import { Modal, Typography, Tag, Empty, Spin, Alert, Button, Radio, Popconfirm, message } from "antd";
import { MergeCellsOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { DuplicateGroup } from "../types";
import { STATUS_LABELS, STATUS_COLORS } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** 合并成功后通知外层刷新人才列表 */
  onMerged?: () => void;
}

// 疑似重复检测：按手机号分组的重复人才，可选中保留一条、其余一键合并，或进详情页处理
export default function DuplicateTalentsModal({ open, onClose, onMerged }: Props) {
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [error, setError] = useState("");
  // 每组选中的「保留」记录：{ 手机号: 人才id }，默认取第一条
  const [keepMap, setKeepMap] = useState<Record<string, string>>({});
  const [mergingPhone, setMergingPhone] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    api.getDuplicateTalents()
      .then((res) => {
        if (cancelled) return;
        setGroups(res.groups);
        setKeepMap((prev) => {
          const next: Record<string, string> = {};
          for (const g of res.groups) next[g.phone] = prev[g.phone] || g.items[0]?.id || "";
          return next;
        });
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const handleMerge = async (g: DuplicateGroup) => {
    const keepId = keepMap[g.phone] || g.items[0]?.id;
    const mergeIds = g.items.filter((it) => it.id !== keepId).map((it) => it.id);
    if (!keepId || mergeIds.length === 0) return;
    setMergingPhone(g.phone);
    try {
      await api.mergeTalents(keepId, mergeIds);
      message.success(`已把 ${g.items.length} 条合并为 1 条`);
      onMerged?.();
      const res = await api.getDuplicateTalents();
      setGroups(res.groups);
      setKeepMap((prev) => {
        const next: Record<string, string> = {};
        for (const ng of res.groups) next[ng.phone] = prev[ng.phone] || ng.items[0]?.id || "";
        return next;
      });
    } catch (e) {
      message.error((e as Error).message);
    }
    setMergingPhone(null);
  };

  return (
    <Modal title="疑似重复人才" open={open} onCancel={onClose} footer={null} width={760} destroyOnClose>
      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem" }}><Spin /></div>
      ) : error ? (
        <Alert type="error" showIcon message={error} />
      ) : groups.length === 0 ? (
        <Empty description="没有发现手机号重复的人才" />
      ) : (
        <>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
            以下 {groups.length} 组人才的手机号相同，可能是重复录入。勾选要<b>保留</b>的一条，
            其余会被并入（补空字段、迁移沟通记录/标签/应聘岗位）后删除；也可点姓名进详情页单独处理。
          </Typography.Paragraph>
          <div style={{ maxHeight: "64vh", overflowY: "auto" }}>
            {groups.map((g) => {
              const keepId = keepMap[g.phone] || g.items[0]?.id;
              return (
                <div key={g.phone} style={{ border: "1px solid #f0f0f0", borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>
                  <div style={{ background: "#fafafa", padding: "6px 10px", fontSize: 13, fontWeight: 600 }}>
                    手机号 {g.phone}
                    <Tag color="orange" style={{ marginInlineStart: 8, marginInlineEnd: 0 }}>{g.items.length} 条</Tag>
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
                        <Link to={`/talents/${it.id}`} onClick={onClose} style={{ fontWeight: 600, minWidth: 72 }}>
                          {it.name || "未命名"}
                        </Link>
                        <span style={{ color: "#666", fontSize: 13, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {[it.current_company, it.current_title].filter(Boolean).join(" · ") || "—"}
                        </span>
                        {it.status && (
                          <Tag color={STATUS_COLORS[it.status] || "default"} style={{ marginInlineEnd: 0 }}>
                            {STATUS_LABELS[it.status] || it.status}
                          </Tag>
                        )}
                      </div>
                    ))}
                  </Radio.Group>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", borderTop: "1px solid #f5f5f5", background: "#fcfcfc" }}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      保留「{g.items.find((it) => it.id === keepId)?.name || "未命名"}」，其余 {g.items.length - 1} 条并入后删除
                    </Typography.Text>
                    <Popconfirm
                      title="确认合并？"
                      description={`将保留选中的一条，其余 ${g.items.length - 1} 条会被删除且无法恢复。`}
                      okText="确认合并"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => handleMerge(g)}
                    >
                      <Button
                        type="primary"
                        size="small"
                        icon={<MergeCellsOutlined />}
                        loading={mergingPhone === g.phone}
                      >
                        合并为一条
                      </Button>
                    </Popconfirm>
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
