import { useEffect, useState } from "react";
import { Modal, Input, Button, Space, Alert, Tag, Typography, Popconfirm, message } from "antd";
import { api } from "../api";
import type { AiOwnKeyInfo } from "../types";

const { Text } = Typography;

interface Props {
  open: boolean;
  onClose: () => void;
}

// AI Key 设置（BYOK）：每日免费 AI 次数用完时，填自己的 DeepSeek Key 立即可继续用。
// 花自己的钱、不占系统配额；Key 加密保存在本人账户下，仅自己可用。
export default function AiKeyModal({ open, onClose }: Props) {
  const [info, setInfo] = useState<AiOwnKeyInfo>({ configured: false, masked: null });
  const [loading, setLoading] = useState(false);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);

  // 每次打开都拉一次最新状态（可能在别的页面刚配好/移除）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    api.getOwnAiKey()
      .then((res) => { if (!cancelled) setInfo(res); })
      .catch(() => { /* 拉取失败静默：按未配置展示，保存时自会报错 */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const handleSave = async () => {
    const trimmed = key.trim();
    setSaving(true);
    try {
      const res = await api.setOwnAiKey(trimmed);
      setInfo({ configured: true, masked: res.masked });
      setKey("");
      message.success("Key 已保存，之后的 AI 生成都走你自己的额度，不占系统配额");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    try {
      await api.deleteOwnAiKey();
      setInfo({ configured: false, masked: null });
      setKey("");
      message.success("已移除，之后的 AI 生成回到系统配额");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "操作失败");
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      title="AI Key 设置"
      width={560}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: "100%" }} size={16}>
        <Alert
          type="info"
          showIcon
          message="每日免费次数用完后，用自己的 Key 继续"
          description={
            <>
              系统每天提供一定次数的免费 AI 生成，用完当天就不能再用了。
              填一个自己的 DeepSeek Key，之后 AI 消耗算<b>你自己账号</b>的额度（按量计费，一次几分钱），
              不占系统次数，也不用等明天重置。Key 加密保存在你的账户下，仅你可用。
            </>
          }
        />

        <div>
          <Space>
            <Text type="secondary">当前状态：</Text>
            {loading ? (
              <Tag>读取中…</Tag>
            ) : info.configured ? (
              <Tag color="green">已配置 {info.masked}</Tag>
            ) : (
              <Tag color="default">未配置（使用系统配额）</Tag>
            )}
          </Space>
        </div>

        <div>
          <Text type="secondary">DeepSeek API Key</Text>
          <Input.Password
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={info.configured ? "重新输入以更换 Key" : "粘贴你的 DeepSeek Key（sk- 开头）"}
            style={{ marginTop: 6 }}
            autoComplete="off"
          />
          <Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 6 }}>
            获取方式：打开 platform.deepseek.com 注册登录 → 充值（按量计费）→ 点「API keys」创建一串 Key 粘贴过来。
            保存时会真实验证 Key 有效性，无效不会保存。
          </Text>
        </div>

        <Space wrap>
          <Button type="primary" loading={saving} disabled={!key.trim()} onClick={handleSave}>
            {info.configured ? "保存并更新" : "保存并启用"}
          </Button>
          <Button onClick={() => window.open("https://platform.deepseek.com", "_blank", "noopener")}>
            去申请 Key
          </Button>
          {info.configured && (
            <Popconfirm
              title="确定移除自己的 Key 吗？"
              description="移除后 AI 生成回到系统每日配额。"
              okText="移除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={handleRemove}
            >
              <Button danger>移除 Key</Button>
            </Popconfirm>
          )}
        </Space>
      </Space>
    </Modal>
  );
}
