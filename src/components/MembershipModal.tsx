import { useState, useEffect } from "react";
import { Modal, Tag, Alert, Spin, Button, message } from "antd";
import { api } from "../api";
import { fmtDate } from "../utils/time";
import type { User } from "../types";

interface Props {
  open: boolean;
  user: User;
  onClose: () => void;
}

function memberState(paidUntil?: string | null) {
  if (!paidUntil) return { status: "none" as const, label: "未开通" };
  // 与后端存储格式对齐：仅日期串视为当天 23:59:59，带空格的时间串按原样处理。
  let iso: string;
  if (/^\d{4}-\d{2}-\d{2}$/.test(paidUntil)) {
    iso = `${paidUntil}T23:59:59Z`;
  } else if (paidUntil.includes(" ") && !paidUntil.includes("T")) {
    iso = paidUntil.replace(" ", "T") + "Z";
  } else {
    iso = paidUntil;
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { status: "none" as const, label: "未开通" };
  return d.getTime() > Date.now()
    ? { status: "active" as const, label: `有效至 ${fmtDate(paidUntil)}` }
    : { status: "expired" as const, label: `已过期 ${fmtDate(paidUntil)}` };
}

export default function MembershipModal({ open, user, onClose }: Props) {
  const [cfg, setCfg] = useState<{ wechat_qr: string | null; alipay_qr: string | null; note: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.getPayConfig()
      .then(setCfg)
      .catch((e) => message.error((e as Error).message))
      .finally(() => setLoading(false));
  }, [open]);

  const st = memberState(user.paid_until);

  // 用户付款后主动通知管理员：推 PushPlus 申请开通（冻结用户也能用，路径 /api/auth/me/* 已放行）
  const handleRequestOpen = async () => {
    setRequesting(true);
    try {
      const res = await api.requestMembership();
      if (res.ok) {
        message.success(res.message || "已通知管理员，请稍候");
      } else {
        message.error((res as { error?: string }).error || "申请失败");
      }
    } catch (e) {
      message.error((e as Error).message || "申请失败");
    } finally {
      setRequesting(false);
    }
  };

  return (
    <Modal title="会员与续费" open={open} onCancel={onClose} footer={null}>
      <div style={{ marginBottom: 12 }}>
        当前状态：
        {user.status === "frozen" ? (
          <Tag color="orange">已冻结（只读）</Tag>
        ) : st.status === "active" ? (
          <Tag color="green">{st.label}</Tag>
        ) : st.status === "expired" ? (
          <Tag color="red">{st.label}</Tag>
        ) : (
          <Tag>未开通</Tag>
        )}
      </div>
      {loading ? (
        <div style={{ textAlign: "center", padding: 24 }}>
          <Spin />
        </div>
      ) : (
        <div>
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="扫码付款后，点下方「我已付款，申请开通」，系统会通知管理员为你开通；开通后此处状态会自动更新。"
          />
          {cfg?.note && (
            <p style={{ whiteSpace: "pre-wrap", color: "var(--color-text-secondary)", marginBottom: 12 }}>
              {cfg.note}
            </p>
          )}
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", justifyContent: "center" }}>
            {cfg?.wechat_qr ? (
              <div style={{ textAlign: "center" }}>
                <div style={{ marginBottom: 6 }}>微信支付</div>
                <img
                  src={cfg.wechat_qr}
                  alt="微信收款码"
                  style={{ width: 180, height: 180, objectFit: "contain", border: "1px solid var(--color-border-tertiary)", borderRadius: 8, background: "#fff" }}
                />
              </div>
            ) : null}
            {cfg?.alipay_qr ? (
              <div style={{ textAlign: "center" }}>
                <div style={{ marginBottom: 6 }}>支付宝</div>
                <img
                  src={cfg.alipay_qr}
                  alt="支付宝收款码"
                  style={{ width: 180, height: 180, objectFit: "contain", border: "1px solid var(--color-border-tertiary)", borderRadius: 8, background: "#fff" }}
                />
              </div>
            ) : null}
          </div>
          {!cfg?.wechat_qr && !cfg?.alipay_qr && (
            <p style={{ color: "var(--color-text-tertiary)", textAlign: "center", marginTop: 12 }}>
              管理员尚未配置收款码，请线下联系管理员获取付款方式。
            </p>
          )}
          <Button
            type="primary"
            block
            style={{ marginTop: 16 }}
            loading={requesting}
            onClick={handleRequestOpen}
          >
            我已付款，申请开通
          </Button>
        </div>
      )}
    </Modal>
  );
}
