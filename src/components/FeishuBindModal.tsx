import { useCallback, useEffect, useState } from "react";
import { Modal, Button, Space, Alert, Tag, Typography, Spin, message } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { api } from "../api";

interface Props {
  open: boolean;
  bound: boolean;
  onClose: () => void;
}

// 飞书官方扫码登录 SDK（LarkSSOSDKWebQRCode）：把我们后端生成的授权 URL（goto）
// 包成一个飞书托管的二维码 iframe；用户飞书 App 扫一扫、手机确认后，飞书仍走
// redirect_uri 把 code 带回 /api/feishu/oauth/callback —— 与跳转授权同一条后端链路。
// SDK 极小，仅暴露 window.QRLogin({ id, goto, width, height, style })。
declare global {
  interface Window {
    QRLogin?: (opts: { id: string; goto: string; width?: number; height?: number; style?: string }) => { matchOrigin: (origin: string) => boolean };
  }
}

const FEISHU_QR_SDK = "https://sf3-cn.feishucdn.com/obj/static/lark/passport/qrcode/LarkSSOSDKWebQRCode-1.0.1.js";
const QR_BOX_ID = "feishu-qr-box";
const QR_SIZE = 200;

function loadQrSdk(): Promise<void> {
  if (window.QRLogin) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = FEISHU_QR_SDK;
    s.async = true;
    s.onload = () => (window.QRLogin ? resolve() : reject(new Error("二维码组件加载后未就绪")));
    s.onerror = () => reject(new Error("二维码组件加载失败（网络原因）"));
    document.head.appendChild(s);
  });
}

// 飞书推送绑定：通过飞书 OAuth 把当前账号与飞书 open_id 绑定，之后到期/面试/审批
// 提醒会自动推送到飞书。两种授权方式等价：扫码（默认）或跳转网页授权；
// 完成后由飞书带回本系统并自动刷新绑定状态。
export default function FeishuBindModal({ open, bound, onClose }: Props) {
  const [binding, setBinding] = useState(false);
  const [testing, setTesting] = useState(false);
  const [qrState, setQrState] = useState<"loading" | "ready" | "failed">("loading");
  const [qrError, setQrError] = useState("");

  const initQr = useCallback(async () => {
    setQrState("loading");
    setQrError("");
    try {
      const [res] = await Promise.all([api.feishuBindUrl(), loadQrSdk()]);
      const box = document.getElementById(QR_BOX_ID);
      // 弹窗可能在请求期间被关闭（destroyOnClose 会卸载内容），容器已不存在
      if (!box) return;
      box.innerHTML = "";
      window.QRLogin!({ id: QR_BOX_ID, goto: res.url, width: QR_SIZE, height: QR_SIZE, style: "border:none;display:block" });
      setQrState("ready");
    } catch (err) {
      setQrError(err instanceof Error ? err.message : "二维码初始化失败");
      setQrState("failed");
    }
  }, []);

  useEffect(() => {
    if (open && !bound) void initQr();
    return () => {
      const box = document.getElementById(QR_BOX_ID);
      if (box) box.innerHTML = "";
    };
  }, [open, bound, initQr]);

  const handleBind = async () => {
    setBinding(true);
    try {
      const res = await api.feishuBindUrl();
      window.location.href = res.url; // 跳转飞书授权
    } catch (err) {
      message.error(err instanceof Error ? err.message : "发起授权失败");
      setBinding(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await api.testFeishu();
      if (res.ok) message.success("测试消息已发送，请到飞书查看");
      else message.error(res.message || "发送失败");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "发送失败");
    } finally {
      setTesting(false);
    }
  };

  return (
    <Modal open={open} onCancel={onClose} footer={null} title="飞书推送设置" width={520} destroyOnClose>
      <Space direction="vertical" style={{ width: "100%" }} size={16}>
        <Alert
          type="info"
          showIcon
          message="把到期 / 面试 / 审批提醒推送到你的飞书"
          description="授权仅获取你的 open_id 用于收发消息；扫码或在飞书网页里确认后自动返回本系统，即完成绑定。"
        />
        <div>
          <Space>
            <Typography.Text type="secondary">当前状态：</Typography.Text>
            {bound ? <Tag color="green">已绑定飞书</Tag> : <Tag color="default">未绑定</Tag>}
          </Space>
        </div>

        {!bound && (
          <>
            <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
              <div
                id={QR_BOX_ID}
                style={{
                  width: QR_SIZE,
                  height: QR_SIZE,
                  flex: "0 0 auto",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "1px solid #f0f0f0",
                  borderRadius: 8,
                }}
              >
                {qrState === "loading" && <Spin size="large" />}
              </div>
              <Space direction="vertical" size={8} style={{ flex: 1 }}>
                {qrState === "failed" ? (
                  <Alert
                    type="warning"
                    showIcon
                    message="二维码暂时不可用"
                    description={qrError || "请使用右侧按钮跳转授权"}
                  />
                ) : (
                  <>
                    <Typography.Text strong>飞书扫一扫绑定</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      打开飞书 App → 点右上角「+」→ 扫一扫 → 扫描左侧二维码 → 在手机上确认授权。二维码有效期约 5 分钟，过期点下方刷新。
                    </Typography.Text>
                    <Button size="small" icon={<ReloadOutlined />} loading={qrState === "loading"} onClick={() => void initQr()}>
                      刷新二维码
                    </Button>
                  </>
                )}
              </Space>
            </div>
            <div style={{ textAlign: "center" }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>— 或 —</Typography.Text>
            </div>
            <div style={{ textAlign: "center" }}>
              <Button loading={binding} onClick={handleBind}>跳转网页授权</Button>
            </div>
          </>
        )}

        {bound && (
          <Space>
            <Button loading={testing} onClick={handleTest}>发送测试</Button>
          </Space>
        )}

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          需管理员先在「系统设置 → 飞书集成」里配置飞书应用后才能绑定；未配置时点击绑定会给出提示。
        </Typography.Text>
      </Space>
    </Modal>
  );
}
