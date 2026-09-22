import { useState, useEffect } from "react";
import { Modal, Typography, Tag, Empty, Spin, Alert } from "antd";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { DuplicateGroup } from "../types";
import { STATUS_LABELS, STATUS_COLORS } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
}

// 疑似重复检测：按手机号分组的重复人才，点姓名进入详情页核对/删除多余记录
export default function DuplicateTalentsModal({ open, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    api.getDuplicateTalents()
      .then((res) => { if (!cancelled) setGroups(res.groups); })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  return (
    <Modal title="疑似重复人才" open={open} onCancel={onClose} footer={null} width={720} destroyOnClose>
      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem" }}><Spin /></div>
      ) : error ? (
        <Alert type="error" showIcon message={error} />
      ) : groups.length === 0 ? (
        <Empty description="没有发现手机号重复的人才" />
      ) : (
        <>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
            以下 {groups.length} 组人才的手机号相同，可能是重复录入。点击姓名进入详情页核对，确认多余的可直接删除。
          </Typography.Paragraph>
          <div style={{ maxHeight: "64vh", overflowY: "auto" }}>
            {groups.map((g) => (
              <div key={g.phone} style={{ border: "1px solid #f0f0f0", borderRadius: 8, marginBottom: 10, overflow: "hidden" }}>
                <div style={{ background: "#fafafa", padding: "6px 10px", fontSize: 13, fontWeight: 600 }}>
                  手机号 {g.phone}
                  <Tag color="orange" style={{ marginInlineStart: 8, marginInlineEnd: 0 }}>{g.items.length} 条</Tag>
                </div>
                {g.items.map((it) => (
                  <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderTop: "1px solid #f5f5f5" }}>
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
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
