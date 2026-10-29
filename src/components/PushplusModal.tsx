import { useEffect, useState } from "react";
import { Modal, Input, Button, Space, Alert, Tag, Typography, Popconfirm, Collapse, message } from "antd";
import { api } from "../api";
import type { FeishuMyApp } from "../types";

const { Text } = Typography;

interface Props {
  open: boolean;
  configured: boolean;
  onClose: () => void;
  /** 保存成功后回调，把最新配置状态回传给父组件更新 user */
  onConfiguredChange: (configured: boolean) => void;
}

// 个人消息推送设置：配置 PushPlus token，让到期提醒推到本人微信。
// 下方折叠区可自助配置飞书应用（跨企业用户配自己企业的应用，绑定/发信走同一应用）。
export default function PushplusModal({ open, configured, onClose, onConfiguredChange }: Props) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // ---- 飞书应用配置（折叠区）----
  const [app, setApp] = useState<FeishuMyApp | null>(null);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [appName, setAppName] = useState("");
  const [appSaving, setAppSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setToken("");
    setAppSecret("");
    api.getFeishuMyApp().then((res) => {
      setApp(res);
      setAppId(res.app_id || "");
      setAppName(res.name || "");
    }).catch(() => setApp(null));
  }, [open]);

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

  const handleAppSave = async () => {
    const trimmedId = appId.trim();
    if (!trimmedId) {
      message.error("App ID 必填");
      return;
    }
    if (!app?.configured && !appSecret.trim()) {
      message.error("首次配置必须填 App Secret");
      return;
    }
    setAppSaving(true);
    try {
      const res = await api.saveFeishuMyApp({
        app_id: trimmedId,
        app_secret: appSecret.trim() || undefined,
        name: appName.trim() || undefined,
      });
      setAppSecret("");
      const fresh = await api.getFeishuMyApp().catch(() => null);
      if (fresh) {
        setApp(fresh);
        setAppId(fresh.app_id || "");
        setAppName(fresh.name || "");
      }
      message.success(res.scope === "team" ? "已保存，全团队的飞书绑定/发信将使用这套应用" : "已保存，你的飞书绑定/发信将使用这套应用");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "保存失败");
    } finally {
      setAppSaving(false);
    }
  };

  const handleAppDelete = async () => {
    try {
      await api.deleteFeishuMyApp();
      setApp((prev) => (prev ? { ...prev, configured: false, app_id: null, name: null } : prev));
      setAppId("");
      setAppName("");
      setAppSecret("");
      message.success("已删除你的飞书应用配置，回落到上一级配置");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "删除失败");
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
          <Text type="secondary" style={{ fontSize: "var(--font-hint)", display: "block", marginTop: 6 }}>
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

        <Collapse
          ghost
          items={[
            {
              key: "feishu-app",
              label: <Text strong>飞书应用配置（跨企业用户自助，可选）</Text>,
              children: (
                <Space direction="vertical" style={{ width: "100%" }} size={12}>
                  <Alert
                    type="info"
                    showIcon
                    message="绑定飞书时提示「你没有 XX 的使用权限」？"
                    description={
                      <>
                        那是飞书官方拦截：你和系统默认应用不在同一个飞书企业，换账号也没用。
                        在这里填入<b>你自己企业</b>创建的飞书自建应用凭证即可正常绑定。
                        创建方法：飞书开放平台 → 创建企业自建应用 → 开通「获取用户基本信息」权限并发版 → 复制 App ID / App Secret。
                        没有企业？在飞书群加自定义机器人，把 webhook 填到「飞书集成」也行（消息群内可见）。
                      </>
                    }
                  />
                  {app?.scope === "team" && (
                    <Alert
                      type="warning"
                      showIcon
                      message="你所在团队已配置飞书应用，保存会覆盖全团队的配置"
                      description="只有团队管理者需要配置；普通成员无需填写，直接绑定即可。"
                    />
                  )}
                  <div>
                    <Text type="secondary">App ID</Text>
                    <Input
                      value={appId}
                      onChange={(e) => setAppId(e.target.value)}
                      placeholder="cli_ 开头，在飞书开放平台应用详情页复制"
                      style={{ marginTop: 6 }}
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    <Text type="secondary">App Secret</Text>
                    <Input.Password
                      value={appSecret}
                      onChange={(e) => setAppSecret(e.target.value)}
                      placeholder={app?.configured ? "留空则不修改已存的 Secret" : "应用详情页重置后复制"}
                      style={{ marginTop: 6 }}
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    <Text type="secondary">备注名（可选）</Text>
                    <Input
                      value={appName}
                      onChange={(e) => setAppName(e.target.value)}
                      placeholder="如：本公司飞书应用"
                      style={{ marginTop: 6 }}
                      autoComplete="off"
                    />
                  </div>
                  <Space>
                    <Button type="primary" loading={appSaving} onClick={handleAppSave}>
                      {app?.configured ? "保存并更新" : "保存应用配置"}
                    </Button>
                    {app?.configured && (
                      <Popconfirm
                        title="确定删除这套飞书应用配置吗？"
                        description="删除后回落到上一级配置（团队/全局）。已绑定的用户需重新扫码绑定。"
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={handleAppDelete}
                      >
                        <Button danger>删除配置</Button>
                      </Popconfirm>
                    )}
                  </Space>
                  <Text type="secondary" style={{ fontSize: "var(--font-hint)" }}>
                    注意：飞书的 open_id 是应用级标识——用哪个应用绑定，之后就用同一个应用发消息。
                    更换应用后，已绑定的用户需要重新扫码绑定一次。
                  </Text>
                </Space>
              ),
            },
          ]}
        />
      </Space>
    </Modal>
  );
}
