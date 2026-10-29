import { useState } from "react";
import { Modal, Button, Space, Alert, Tag, Typography, message, Popconfirm } from "antd";
import { api } from "../api";

interface Props {
  open: boolean;
  bound: boolean;
  onClose: () => void;
}

// 飞书提醒管理（顶栏绿图标进入，仅已绑定用户）：发送测试消息 / 解绑。
//
// 绑定不在本弹窗完成：顶栏飞书图标（未绑定时带红点）点击后直接整页跳转飞书授权页，
// 授权回来由 FeishuBindConfirmModal 确认账号后写库（链路见 App.tsx 与 worker
// /oauth/callback）。本弹窗历史上的 iframe 授权页 / 复制绑定链接 / 重新加载等
// 绑定 UI 已于 2026-10-21 删除——头像菜单项删除后那些分支已不可达，纯属死代码；
// 如需找回可用 git log 查看（如将来做「不离开页面」的绑定方式再议）。
export default function FeishuBindModal({ open, bound, onClose }: Props) {
  const [testing, setTesting] = useState(false);
  const [unbinding, setUnbinding] = useState(false);

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
    <Modal open={open} onCancel={onClose} footer={null} title="飞书提醒管理" width={520} destroyOnClose>
      <Space direction="vertical" style={{ width: "100%" }} size={16}>
        <Alert
          type="info"
          showIcon
          message="把到期 / 面试 / 审批提醒推送到你的飞书"
          description={
            bound
              ? "已推送到你本人的飞书。可发送一条测试消息验证通道，也可随时解绑（渠道回退 PushPlus）。"
              : "尚未绑定：点右上角飞书图标（带红点那个）即可开始绑定。"
          }
        />
        <div>
          <Space>
            <Typography.Text type="secondary">当前状态：</Typography.Text>
            {bound ? <Tag color="green">已绑定飞书</Tag> : <Tag color="default">未绑定</Tag>}
          </Space>
        </div>

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

        <Typography.Text type="secondary" style={{ fontSize: "var(--font-hint)" }}>
          提醒经飞书应用发送（你自助配置的 &gt; 团队 &gt; 系统默认）。绑定报「你没有 XX 的使用权限」或收不到消息时，
          到「消息推送设置 → 飞书应用配置」填入你自己企业的应用凭证即可。
        </Typography.Text>
      </Space>
    </Modal>
  );
}
