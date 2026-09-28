import { useState } from "react";
import { Modal, Input, Button, Space, Alert, Tag, Typography, Popconfirm, message } from "antd";
import { api } from "../api";

const { Text } = Typography;

interface Props {
  open: boolean;
  configured: boolean;
  onClose: () => void;
  /** 保存成功后回调，把最新配置状态回传给父组件更新 user */
  onConfiguredChange: (configured: boolean) => void;
}

// 个人消息推送设置：配置 PushPlus token，让到期提醒推到本人微信。
export default function PushplusModal({ open, configured, onClose, onConfiguredChange }: Props) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const handleSave = async () => {
    const trimmed = token.trim();
    setSaving(true);
    try {
      const res = await api.updateMyPushplus(trimmed);
      onConfiguredChange(res.configured);
      setToken("");
      message.success(res.configured ? "推送已开启，到期提醒将推送到你的微信" : "已关闭推送");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await api.testMyPushplus();
      if (res.ok) {
        message.success("测试消息已发送，请到微信查看");
      } else {
        message.error(res.message || "发送失败");
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : "发送失败");
    } finally {
      setTesting(false);
    }
  };

  const handleDisable = async () => {
    try {
      const res = await api.updateMyPushplus("");
      onConfiguredChange(res.configured);
      setToken("");
      message.success("已关闭推送");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "操作失败");
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title="消息推送设置"
      width={520}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: "100%" }} size={16}>
        <Alert
          type="info"
          showIcon
          message="把「待办 / 合同 / 试用期」到期提醒推送到你的个人微信"
          description={
            <>
              系统每天会汇总一次未来 3 天内到期的提醒：<b>你自己负责的待办</b>推给你本人，
              <b>合同和试用期到期</b>推给所有已配置的用户。配置后无需打开系统也能收到。
            </>
          }
        />

        <div>
          <Space>
            <Text type="secondary">当前状态：</Text>
            {configured ? (
              <Tag color="green">已开启推送</Tag>
            ) : (
              <Tag color="default">未配置</Tag>
            )}
          </Space>
        </div>

        <div>
          <Text type="secondary">PushPlus token</Text>
          <Input.Password
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={configured ? "重新输入以更换 token" : "粘贴你的 PushPlus token"}
            style={{ marginTop: 6 }}
            autoComplete="off"
          />
          <Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 6 }}>
            获取方式：打开 pushplus.plus，用微信扫码登录，首页「一对一推送」里复制那串 token。
          </Text>
        </div>

        <Space>
          <Button type="primary" loading={saving} onClick={handleSave}>
            {configured ? "保存并更新" : "保存并开启"}
          </Button>
          {configured && (
            <Button loading={testing} onClick={handleTest}>
              发送测试
            </Button>
          )}
          {configured && (
            <Popconfirm
              title="确定关闭推送吗？"
              description="关闭后你将不再收到到期提醒。"
              okText="关闭"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={handleDisable}
            >
              <Button danger>关闭推送</Button>
            </Popconfirm>
          )}
        </Space>
      </Space>
    </Modal>
  );
}
