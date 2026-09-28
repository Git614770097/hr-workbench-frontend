import { useState } from "react";
import { Modal, Input, Button, Space, Alert, Typography, message } from "antd";
import { api } from "../api";

const { Text } = Typography;

interface Props {
  open: boolean;
  /**
   * 强制模式：管理员用临时密码重置过账号，登录后必须先改掉。
   * 此模式下不允许点遮罩/点叉关闭，只能改完或选「稍后再说」。
   */
  forced?: boolean;
  onClose: () => void;
  /** 修改成功后回调（父组件据此清掉 must_change_password 标记） */
  onSuccess: () => void;
}

// 修改自己的密码：原密码 + 新密码 + 确认新密码。
// 规则与后端 /auth/me/password 保持一致：新密码至少 6 位、不能与原密码相同。
export default function PasswordModal({ open, forced = false, onClose, onSuccess }: Props) {
  // 受控 state 作唯一真源（禁 Form.Item name noStyle 嵌套，见项目约定）
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const reset = () => {
    setOldPwd("");
    setNewPwd("");
    setConfirmPwd("");
    setError("");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    if (!oldPwd || !newPwd) {
      setError("原密码和新密码均为必填");
      return;
    }
    if (newPwd.length < 6) {
      setError("新密码至少 6 位");
      return;
    }
    if (newPwd !== confirmPwd) {
      setError("两次输入的新密码不一致");
      return;
    }
    if (oldPwd === newPwd) {
      setError("新密码不能与原密码相同");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api.changeMyPassword({ old_password: oldPwd, new_password: newPwd });
      message.success("密码已修改，下次登录请使用新密码");
      reset();
      onSuccess();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "修改失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={forced ? undefined : handleClose}
      // 强制模式不给关闭入口，避免用户直接跳过
      closable={!forced}
      maskClosable={!forced}
      keyboard={!forced}
      footer={null}
      title="修改密码"
      width={440}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: "100%" }} size={16}>
        {forced && (
          <Alert
            type="warning"
            showIcon
            message="请修改临时密码"
            description="管理员为你重置了密码，当前使用的是临时密码。修改后才能正常使用系统。"
          />
        )}

        <div>
          <Text type="secondary">原密码</Text>
          <Input.Password
            value={oldPwd}
            onChange={(e) => setOldPwd(e.target.value)}
            placeholder="请输入当前使用的密码"
            style={{ marginTop: 6 }}
            autoComplete="current-password"
          />
        </div>

        <div>
          <Text type="secondary">新密码</Text>
          <Input.Password
            value={newPwd}
            onChange={(e) => setNewPwd(e.target.value)}
            placeholder="至少 6 位，且不能与原密码相同"
            style={{ marginTop: 6 }}
            autoComplete="new-password"
          />
        </div>

        <div>
          <Text type="secondary">确认新密码</Text>
          <Input.Password
            value={confirmPwd}
            onChange={(e) => setConfirmPwd(e.target.value)}
            placeholder="请再次输入新密码"
            style={{ marginTop: 6 }}
            autoComplete="new-password"
            onPressEnter={handleSubmit}
          />
        </div>

        {error && <Alert type="error" showIcon message={error} />}

        <Space>
          <Button type="primary" loading={saving} onClick={handleSubmit}>
            确认修改
          </Button>
          <Button onClick={handleClose} disabled={saving}>
            {forced ? "稍后再说" : "取消"}
          </Button>
        </Space>
      </Space>
    </Modal>
  );
}
