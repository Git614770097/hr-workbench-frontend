import { useState } from "react";
import { Modal, Button, Space, Alert, Tag, Typography, message } from "antd";
import { api } from "../api";

interface Props {
  open: boolean;
  bound: boolean;
  onClose: () => void;
}

// 飞书推送绑定：通过飞书 OAuth 授权把当前账号与飞书 open_id 绑定，之后到期/面试/审批
// 提醒会自动推送到飞书。授权会跳转飞书、完成后由飞书带回本系统并自动刷新绑定状态。
export default function FeishuBindModal({ open, bound, onClose }: Props) {
  const [binding, setBinding] = useState(false);
  const [testing, setTesting] = useState(false);

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
          description={
            <>
              点击「绑定飞书」会跳转到飞书完成授权（仅获取你的 open_id 用于收发消息），完成后自动返回本系统即完成绑定。
            </>
          }
        />
        <div>
          <Space>
            <Typography.Text type="secondary">当前状态：</Typography.Text>
            {bound ? <Tag color="green">已绑定飞书</Tag> : <Tag color="default">未绑定</Tag>}
          </Space>
        </div>
        <Space>
          {bound ? (
            <Button loading={testing} onClick={handleTest}>发送测试</Button>
          ) : (
            <Button type="primary" loading={binding} onClick={handleBind}>绑定飞书</Button>
          )}
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          需管理员先在「系统设置 → 飞书集成」里配置飞书应用后才能绑定；未配置时点击绑定会给出提示。
        </Typography.Text>
      </Space>
    </Modal>
  );
}
