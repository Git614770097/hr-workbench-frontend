import { useState, useEffect, useCallback } from "react";
import { Form, Input, Button, Alert, Typography } from "antd";
import {
  MobileOutlined, LockOutlined, SafetyCertificateOutlined, ReloadOutlined, UserOutlined,
} from "@ant-design/icons";
import { api } from "../api";

interface Props {
  onLogin: () => void;
}

type Mode = "login" | "register";

export default function Login({ onLogin }: Props) {
  const [mode, setMode] = useState<Mode>("login");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [captchaId, setCaptchaId] = useState("");
  const [captchaSvg, setCaptchaSvg] = useState("");
  const [captchaLoading, setCaptchaLoading] = useState(false);

  const [loginForm] = Form.useForm();
  const [registerForm] = Form.useForm();

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

  // 切换登录/注册时清空提示与表单，避免上一模式的错误信息残留
  const switchMode = (next: Mode) => {
    setMode(next);
    setError("");
    setSuccess("");
    loginForm.resetFields();
    registerForm.resetFields();
    refreshCaptcha();
  };

  const handleLogin = async (values: { phone: string; password: string; captcha: string }) => {
    setError("");
    setSuccess("");
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

  const handleRegister = async (values: {
    phone: string; name: string; password: string; confirm: string; captcha: string;
  }) => {
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      const res = await api.register({
        phone: values.phone,
        name: values.name,
        password: values.password,
        captcha_id: captchaId,
        captcha: values.captcha,
      });
      setSuccess(res.message || "注册已提交，请等待管理员审批后登录");
      registerForm.resetFields();
    } catch (err) {
      setError((err as Error).message);
    }
    // 验证码一次性（无论成功失败都已消费），刷新以备重试
    refreshCaptcha();
    setLoading(false);
  };

  // 验证码输入框 + 图形 + 刷新按钮（登录与注册共用）
  const captchaField = (
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
            __html: captchaSvg || '<span style="color:#999;font-size:12px;">加载中…</span>',
          }}
        />
        <ReloadOutlined
          className={`captcha-refresh ${captchaLoading ? "spinning" : ""}`}
          onClick={refreshCaptcha}
        />
      </div>
    </Form.Item>
  );

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <Typography.Title level={3} className="auth-brand-title">
            人力资源管理系统
          </Typography.Title>
          <Typography.Text className="auth-brand-desc">
            人才库 · 招聘流程 · 岗位管理，一站式人事工作台
          </Typography.Text>
          <div className="auth-brand-points">
            <span>智能人才档案管理</span>
            <span>招聘流程可视化看板</span>
            <span>模板库管理</span>
          </div>
        </div>

        <div className="auth-form">
          <div className="auth-form-header">
            <Typography.Title level={4} style={{ margin: 0 }}>
              {mode === "login" ? "欢迎登录" : "注册账号"}
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {mode === "login" ? "请输入账号信息" : "提交后需管理员审批通过"}
            </Typography.Text>
          </div>

          {error && <Alert message={error} type="error" showIcon style={{ marginBottom: 20 }} />}
          {success && <Alert message={success} type="success" showIcon style={{ marginBottom: 20 }} />}

          {mode === "login" ? (
            <Form form={loginForm} onFinish={handleLogin} layout="vertical" size="large">
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

              {captchaField}

              <Form.Item style={{ marginBottom: 8 }}>
                <Button type="primary" htmlType="submit" block loading={loading}>
                  登 录
                </Button>
              </Form.Item>
            </Form>
          ) : (
            <Form form={registerForm} onFinish={handleRegister} layout="vertical" size="large">
              <Form.Item
                name="phone"
                rules={[
                  { required: true, message: "请输入手机号" },
                  { pattern: /^1[3-9]\d{9}$/, message: "手机号格式不正确" },
                ]}
              >
                <Input prefix={<MobileOutlined />} placeholder="手机号" maxLength={11} />
              </Form.Item>

              <Form.Item name="name" rules={[{ required: true, message: "请输入姓名" }]}>
                <Input prefix={<UserOutlined />} placeholder="姓名" maxLength={20} />
              </Form.Item>

              <Form.Item
                name="password"
                rules={[
                  { required: true, message: "请输入密码" },
                  { min: 6, message: "密码至少 6 位" },
                ]}
              >
                <Input.Password prefix={<LockOutlined />} placeholder="密码（至少 6 位）" />
              </Form.Item>

              <Form.Item
                name="confirm"
                dependencies={["password"]}
                rules={[
                  { required: true, message: "请再次输入密码" },
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      if (!value || getFieldValue("password") === value) return Promise.resolve();
                      return Promise.reject(new Error("两次输入的密码不一致"));
                    },
                  }),
                ]}
              >
                <Input.Password prefix={<LockOutlined />} placeholder="确认密码" />
              </Form.Item>

              {captchaField}

              <Form.Item style={{ marginBottom: 8 }}>
                <Button type="primary" htmlType="submit" block loading={loading}>
                  提交注册
                </Button>
              </Form.Item>
            </Form>
          )}

          <p className="auth-switch">
            {mode === "login" ? (
              <>
                还没有账号？
                <a className="auth-switch-link" onClick={() => switchMode("register")}>立即注册</a>
              </>
            ) : (
              <>
                已有账号？
                <a className="auth-switch-link" onClick={() => switchMode("login")}>返回登录</a>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
