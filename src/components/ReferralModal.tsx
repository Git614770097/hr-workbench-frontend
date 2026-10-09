import { useState, useEffect } from "react";
import { Modal, Alert, Spin, Button, Table, Tag, message } from "antd";
import { CopyOutlined } from "@ant-design/icons";
import { api } from "../api";
import { fmtDate } from "../utils/time";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Invited {
  name: string;
  phone: string;
  status: string;
  created_at: string;
  rewarded_at: string | null;
  reward_months: number | null;
}

export default function ReferralModal({ open, onClose }: Props) {
  const [data, setData] = useState<{
    code: string;
    link: string;
    config: { enabled: boolean; referrerMonths: number; inviteeMonths: number; capMonthsPerYear: number };
    invited: Invited[];
  } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.getReferral()
      .then(setData)
      .catch((e) => message.error((e as Error).message))
      .finally(() => setLoading(false));
  }, [open]);

  const copy = async (text: string, tip: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(tip);
    } catch {
      message.error("复制失败，请手动选中后复制");
    }
  };

  const cfg = data?.config;

  return (
    <Modal title="我的推广" open={open} onCancel={onClose} footer={null} width={620}>
      {loading || !data ? (
        <div style={{ textAlign: "center", padding: 32 }}>
          <Spin />
        </div>
      ) : (
        <div>
          {cfg?.enabled === false ? (
            <Alert type="info" showIcon message="推广活动当前未开启，以下邀请码暂不参与奖励。" style={{ marginBottom: 16 }} />
          ) : (
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 16 }}
              message={`邀请同行注册并开通会员：你 +${cfg?.referrerMonths ?? 2} 个月，对方 +${cfg?.inviteeMonths ?? 1} 个月`}
              description="奖励在对方完成开通后自动到账，双方都会收到通知。每年累计奖励上限 12 个月。"
            />
          )}

          <div className="referral-code-box">
            <div className="referral-code-label">我的邀请码</div>
            <div className="referral-code-value">{data.code}</div>
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => copy(data.code, "邀请码已复制")}
            >
              复制
            </Button>
          </div>

          <div className="referral-link-box">
            <span className="referral-link-text">{data.link}</span>
            <Button
              type="link"
              size="small"
              icon={<CopyOutlined />}
              onClick={() => copy(data.link, "邀请链接已复制")}
            >
              复制链接
            </Button>
          </div>

          <div style={{ marginTop: 20, fontWeight: 600, marginBottom: 8 }}>
            已邀请 {data.invited.length} 人
          </div>
          <Table
            rowKey={(r) => r.phone + r.created_at}
            size="small"
            pagination={false}
            dataSource={data.invited}
            locale={{ emptyText: "还没有人通过你的邀请码注册" }}
            columns={[
              { title: "姓名", dataIndex: "name", width: 90 },
              { title: "手机号", dataIndex: "phone", width: 120 },
              {
                title: "状态",
                dataIndex: "status",
                width: 130,
                render: (s: string, r: Invited) =>
                  s === "rewarded" ? (
                    <Tag color="green">{`已奖励 +${r.reward_months ?? 0} 个月`}</Tag>
                  ) : s === "invalid" ? (
                    <Tag color="red">已作废</Tag>
                  ) : (
                    <Tag>待对方开通</Tag>
                  ),
              },
              {
                title: "邀请时间",
                dataIndex: "created_at",
                width: 110,
                render: (v: string) => (v ? fmtDate(v) : "-"),
              },
              {
                title: "到账时间",
                dataIndex: "rewarded_at",
                render: (v: string | null) => (v ? fmtDate(v) : "-"),
              },
            ]}
          />
        </div>
      )}
    </Modal>
  );
}
