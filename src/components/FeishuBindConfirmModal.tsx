import { useEffect, useState } from "react";
import Modal from "antd/es/modal";
import Button from "antd/es/button";
import Space from "antd/es/space";
import Alert from "antd/es/alert";
import Avatar from "antd/es/avatar";
import Spin from "antd/es/spin";
import Typography from "antd/es/typography";
// ⚠️ 深路径导入，别用 `from "@ant-design/icons"`（桶文件会拖入全部 831 个图标）。
import ExclamationCircleOutlined from "@ant-design/icons/es/icons/ExclamationCircleOutlined";
import { api } from "../api";

interface Props {
  /** 后端生成的一次性确认 token；null = 不展示 */
  ck: string | null;
  onDone: (bound: boolean) => void;
}

// 飞书绑定确认页：授权回来后先让用户看清「即将绑定的飞书账号是谁」再写库。
// 背景：飞书授权页默认带出浏览器里已登录的飞书账号（成员用他人电脑/旧登录态
// 没清时，弹出的不是本人的账号），静默绑定会把提醒推到一个错误的飞书上——
// 这层确认把「绑错」暴露在用户眼前。
export default function FeishuBindConfirmModal({ ck, onDone }: Props) {
  const [info, setInfo] = useState<{ name: string; avatarUrl: string } | null>(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!ck) { setInfo(null); setError(""); return; }
    // 待确认信息（只读，不消费 token）
    api.feishuBindPending(ck)
      .then((d) => setInfo({ name: d.name || "（未获取到昵称）", avatarUrl: d.avatar_url || "" }))
      .catch((e) => setError((e as Error).message || "确认信息已过期，请重新扫码"));
  }, [ck]);

  const handleConfirm = async () => {
    if (!ck) return;
    setConfirming(true);
    try {
      await api.confirmFeishuBind(ck);
      onDone(true);
    } catch (e) {
      const msg = (e as Error).message || "";
      // open_id 被占用（409）时服务端已消耗确认 token，再点「确认绑定」只会得到
      // 「已过期」——直接关弹窗，让用户从顶栏入口用本人飞书重新授权，路更清晰
      if (msg.includes("已经绑定到其他账号")) { onDone(false); return; }
      setError(msg);
      setConfirming(false);
    }
  };

  return (
    <Modal
      open={!!ck}
      onCancel={() => onDone(false)}
      footer={null}
      title="确认绑定你的飞书"
      width={440}
      maskClosable={false}
    >
      {error ? (
        <Alert type="error" showIcon message={error} />
      ) : !info ? (
        <div style={{ textAlign: "center", padding: 24 }}><Spin /></div>
      ) : (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {info.avatarUrl
              ? <Avatar size={52} src={info.avatarUrl} />
              : <Avatar size={52} icon={<ExclamationCircleOutlined />} />}
            <div>
              <Typography.Text strong style={{ fontSize: 16 }}>{info.name}</Typography.Text>
              <br />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>这是你本人的飞书账号吗？</Typography.Text>
            </div>
          </div>
          <Alert
            type="warning"
            showIcon
            message="确认后，到期 / 面试 / 审批提醒将推送到上面这个飞书账号"
            description="如果不是你本人的飞书（比如在共用电脑上、或切换过飞书账号），点「取消」，回到飞书授权页换账号重新扫。"
          />
          <Space style={{ justifyContent: "flex-end", width: "100%" }}>
            <Button onClick={() => onDone(false)}>取消</Button>
            <Button type="primary" loading={confirming} onClick={handleConfirm}>确认绑定</Button>
          </Space>
        </Space>
      )}
    </Modal>
  );
}
