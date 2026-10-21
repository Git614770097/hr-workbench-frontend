import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Button, Space, Alert, Tag, Typography, Spin, message, Popconfirm } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { api } from "../api";

interface Props {
  open: boolean;
  bound: boolean;
  onClose: () => void;
}

// 飞书推送绑定：通过飞书 OAuth 把当前账号与飞书 open_id 绑定，之后到期/面试/审批
// 提醒会自动推送到飞书。
//
// 二维码方案说明（2026-10-21 浏览器实测后确定）：
// 飞书官方扫码 SDK（LarkSSOSDKWebQRCode）内部把授权 URL 包进
// accounts.feishu.cn/accounts/auth_login/qr 挂件渲染二维码，但该挂件端点现已
// 对所有请求返回 4401「请求无效」（实测带完整会话/真实 UA 均如此，旧方案已失效）。
// 因此改为**直接 iframe 授权页本体**：
//   - 授权端点 open-apis/authen/v1/authorize 实测无 X-Frame-Options / 无 CSP
//     frame-ancestors，可嵌入；落地页 accounts/page/login 默认即「扫码登录」tab，
//     canvas 二维码 + qrlogin/init + polling 全链路 200
//   - 用户扫码 → 手机确认 → 授权页自动继续 → code 回跳 /api/feishu/oauth/callback
//     → 破框脚本把顶层窗口带回 /?feishu=bound（与跳转授权同一条后端链路）
const QR_W = 300;
const QR_H = 400;

export default function FeishuBindModal({ open, bound, onClose }: Props) {
  const [binding, setBinding] = useState(false);
  const [testing, setTesting] = useState(false);
  const [unbinding, setUnbinding] = useState(false);
  const [qrUrl, setQrUrl] = useState("");
  const [qrState, setQrState] = useState<"loading" | "ready" | "failed">("loading");
  const [qrError, setQrError] = useState("");
  const loadTimer = useRef<number | undefined>(undefined);

  const initQr = useCallback(async () => {
    setQrState("loading");
    setQrError("");
    window.clearTimeout(loadTimer.current);
    try {
      const res = await api.feishuBindUrl();
      setQrUrl(res.url);
      // 跨域 iframe 读不到内部状态，onload 只证明服务器有响应；8s 未加载视为失败
      loadTimer.current = window.setTimeout(() => {
        setQrState((s) => (s === "loading" ? "failed" : s));
        setQrError((e) => e || "飞书授权页加载超时，请改用右下角按钮跳转授权");
      }, 8000);
    } catch (err) {
      setQrError(err instanceof Error ? err.message : "二维码初始化失败");
      setQrState("failed");
    }
  }, []);

  useEffect(() => {
    if (open && !bound) void initQr();
    return () => window.clearTimeout(loadTimer.current);
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

  const handleUnbind = async () => {
    setUnbinding(true);
    try {
      await api.unbindFeishu();
      message.success("已解绑，将不再给你的飞书推送");
      onClose();
      // 让顶层用户态立即刷新（Layout 绑定的 bound 来自 /me）
      window.location.reload();
    } catch (err) {
      message.error(err instanceof Error ? err.message : "解绑失败");
    } finally {
      setUnbinding(false);
    }
  };

  return (
    <Modal open={open} onCancel={onClose} footer={null} title="飞书推送设置" width={560} destroyOnClose>
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
                style={{
                  width: QR_W,
                  height: QR_H,
                  flex: "0 0 auto",
                  border: "1px solid #f0f0f0",
                  borderRadius: 8,
                  overflow: "hidden",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "#fff",
                }}
              >
                {qrState === "loading" && !qrUrl && <Spin size="large" />}
                {qrState === "failed" && !qrUrl && (
                  <Typography.Text type="secondary" style={{ padding: 12, textAlign: "center", fontSize: 12 }}>
                    {qrError || "二维码加载失败"}
                  </Typography.Text>
                )}
                {qrUrl && (
                  <iframe
                    key={qrUrl /* state 每次刷新都会变，换 key 强制重载 */}
                    src={qrUrl}
                    title="飞书扫码绑定"
                    width={QR_W}
                    height={QR_H}
                    style={{ border: 0, display: "block" }}
                    onLoad={() => {
                      window.clearTimeout(loadTimer.current);
                      setQrState("ready");
                    }}
                  />
                )}
              </div>
              <Space direction="vertical" size={8} style={{ flex: 1 }}>
                {qrState === "failed" ? (
                  <Alert
                    type="warning"
                    showIcon
                    message="二维码暂时不可用"
                    description={qrError || "请使用下方按钮跳转授权"}
                  />
                ) : (
                  <>
                    <Typography.Text strong>飞书扫一扫绑定</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      打开飞书 App → 点右上角「+」→ 扫一扫 → 扫描左侧二维码 → 在手机上确认授权。
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      二维码有效期约 5 分钟，过期后点飞书页面里的「刷新二维码」，或点下方按钮重新加载。
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      授权页顶部显示的飞书账号<b>必须是你本人的</b>；如果显示的是别人（共用电脑或切换过账号），点授权页里的「<b>使用其他账号</b>」切换，或点下方「跳转网页授权」重新走一遍。扫码授权后系统还会再让你确认一次账号。
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
            <Popconfirm
              title="解绑飞书"
              description="解绑后将不再给你的飞书推送提醒（渠道回退 PushPlus），需要时随时可以重新绑定。确定解绑？"
              onConfirm={handleUnbind}
              okButtonProps={{ danger: true }}
            >
              <Button danger loading={unbinding}>解绑</Button>
            </Popconfirm>
          </Space>
        )}

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          需管理员先在「系统设置 → 飞书集成」里配置飞书应用后才能绑定；未配置时点击绑定会给出提示。
        </Typography.Text>
      </Space>
    </Modal>
  );
}
