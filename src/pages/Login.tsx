import { useState, useEffect, useCallback } from "react";
import { Form, Input, Button, Alert, Typography } from "antd";
import { MobileOutlined, LockOutlined, SafetyCertificateOutlined, ReloadOutlined } from "@ant-design/icons";
import { api } from "../api";

interface Props {
  onLogin: () => void;
}

export default function Login({ onLogin }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [captchaId, setCaptchaId] = useState("");
  const [captchaSvg, setCaptchaSvg] = useState("");
  const [captchaLoading, setCaptchaLoading] = useState(false);

  const refreshCaptcha = useCallback(async () => {
    setCaptchaLoading(true);
    try {
      const res = await api.getCaptcha();
      setCaptchaId(res.captcha_id);
      setCaptchaSvg(res.svg);
    } catch {
      setError("验证码加载失败，请重试");
    } finally {
      setCaptchaLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshCaptcha();
  }, [refreshCaptcha]);

  const handleSubmit = async (values: {
    phone: string;
    password: string;
    captcha: string;
  }) => {
    setError("");
    setLoading(true);
    try {
      await api.login({
        phone: values.phone,
        password: values.password,
        captcha_id: captchaId,
        captcha: values.captcha,
      });
      onLogin();
    } catch (err) {
      setError((err as Error).message);
      // 验证码一次性，失败后自动刷新
      refreshCaptcha();
    }
    setLoading(false);
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="auth-brand-logo">🎯</span>
          <Typography.Title level={3} className="auth-brand-title">
            HR 工作台
          </Typography.Title>
          <Typography.Text className="auth-brand-desc">
            人才库 · 文件模板 · 风险预警，一站式人事工作台
          </Typography.Text>
          <div className="auth-brand-points">
            <span>智能人才档案管理</span>
            <span>合同到期风险预警</span>
            <span>标准化文件模板库</span>
          </div>
        </div>

        <div className="auth-form">
          <div className="auth-form-header">
            <Typography.Title level={4} style={{ margin: 0 }}>
              欢迎登录
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              请输入账号信息
            </Typography.Text>
          </div>

          {error && <Alert message={error} type="error" showIcon style={{ marginBottom: 20 }} />}

          <Form onFinish={handleSubmit} layout="vertical" size="large">
            <Form.Item
              name="phone"
              rules={[
                { required: true, message: "请输入手机号" },
                { pattern: /^1[3-9]\d{9}$/, message: "手机号格式不正确" },
              ]}
            >
              <Input prefix={<MobileOutlined />} placeholder="手机号" maxLength={11} />
            </Form.Item>

            <Form.Item name="password" rules={[{ required: true, message: "请输入密码" }]}>
              <Input.Password prefix={<LockOutlined />} placeholder="密码" />
            </Form.Item>

            <Form.Item name="captcha" rules={[{ required: true, message: "请输入验证码" }]}>
              <div className="captcha-row">
                <Input
                  prefix={<SafetyCertificateOutlined />}
                  placeholder="验证码"
                  maxLength={4}
                  className="captcha-input"
                />
                <div
                  className="captcha-img"
                  onClick={refreshCaptcha}
                  title="点击刷新验证码"
                  dangerouslySetInnerHTML={{
                    __html:
                      captchaSvg ||
                      '<span style="color:#999;font-size:12px;">加载中…</span>',
                  }}
                />
                <ReloadOutlined
                  className={`captcha-refresh ${captchaLoading ? "spinning" : ""}`}
                  onClick={refreshCaptcha}
                />
              </div>
            </Form.Item>

            <Form.Item style={{ marginBottom: 8 }}>
              <Button type="primary" htmlType="submit" block loading={loading}>
                登 录
              </Button>
            </Form.Item>
          </Form>

          <p className="auth-switch">
            账号由管理员创建，请联系管理员开通
          </p>
        </div>
      </div>
    </div>
  );
}
