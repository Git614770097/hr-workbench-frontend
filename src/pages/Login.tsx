import { useState, useEffect, useCallback, useRef } from "react";
import { Form, Input, Button, Alert, ConfigProvider, theme as antdTheme } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { api } from "../api";
import "../styles/login.css";

interface Props {
  onLogin: () => void;
}

type Mode = "login" | "register" | "forgot";

// 图形验证码有效期（与后端 SESSIONS.put(`captcha:${id}`, code, { expirationTtl: 60 }) 保持一致）
const CAPTCHA_TTL = 60;
// 剩余多少秒开始显示「即将过期」预警
const CAPTCHA_WARN_AT = 10;

export default function Login({ onLogin }: Props) {
  const [mode, setMode] = useState<Mode>("login");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [captchaId, setCaptchaId] = useState("");
  const [captchaSvg, setCaptchaSvg] = useState("");
  const [captchaLoading, setCaptchaLoading] = useState(false);
  // 当前验证码剩余有效秒数
  const [captchaLeft, setCaptchaLeft] = useState(CAPTCHA_TTL);

  const [loginForm] = Form.useForm();
  const [registerForm] = Form.useForm();
  const [forgotForm] = Form.useForm();

  // silent=true 表示由「到期自动刷新」触发：需清空用户已填的旧验证码并告知
  const refreshCaptcha = useCallback(async (silent?: boolean) => {
    setCaptchaLoading(true);
    try {
      const res = await api.getCaptcha();
      setCaptchaId(res.captcha_id);
      setCaptchaSvg(res.svg);
      setCaptchaLeft(CAPTCHA_TTL);
      if (silent) {
        // 到期自动刷新不弹提示，仅清空用户已填的旧验证码（旧码已失效）
        const active = mode === "login" ? loginForm : mode === "register" ? registerForm : forgotForm;
        active.setFieldValue("captcha", "");
      }
    } catch {
      setError("验证码加载失败，请重试");
    } finally {
      setCaptchaLoading(false);
    }
  }, [mode, loginForm, registerForm, forgotForm]);

  // 初始加载一次（用 ref 持有最新引用，避免依赖变化导致的重复请求）
  const refreshRef = useRef(refreshCaptcha);
  refreshRef.current = refreshCaptcha;
  useEffect(() => {
    refreshRef.current();
  }, []);

  // 倒计时每秒递减
  useEffect(() => {
    const timer = window.setInterval(() => {
      setCaptchaLeft((v) => (v > 0 ? v - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 归零即自动刷新，无需用户手动点击
  useEffect(() => {
    if (captchaLeft > 0) return;
    refreshRef.current(true);
  }, [captchaLeft]);

  // 切换模式时清空提示与表单，避免上一模式的错误信息残留
  const switchMode = (next: Mode) => {
    setMode(next);
    setError("");
    setSuccess("");
    loginForm.resetFields();
    registerForm.resetFields();
    forgotForm.resetFields();
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
      setSuccess(res.message || "注册已提交，管理员已收到通知，审批通过后即可登录");
      registerForm.resetFields();
    } catch (err) {
      setError((err as Error).message);
    }
    // 验证码一次性（无论成功失败都已消费），刷新以备重试
    refreshCaptcha();
    setLoading(false);
  };

  const handleForgot = async (values: { phone: string; name: string; captcha: string }) => {
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      const res = await api.forgotPassword({
        phone: values.phone,
        name: values.name,
        captcha_id: captchaId,
        captcha: values.captcha,
      });
      setSuccess(res.message || "重置申请已提交，管理员会尽快核对处理");
      forgotForm.resetFields();
    } catch (err) {
      setError((err as Error).message);
    }
    refreshCaptcha();
    setLoading(false);
  };

  // 验证码输入框 + 图形 + 刷新按钮（登录与注册共用）
  const captchaField = (
    <Form.Item name="captcha" rules={[{ required: true, message: "请输入验证码" }]}>
      <div className="login-captcha">
        <Input placeholder="验证码" maxLength={4} className="login-captcha-input" />
        <div className="login-captcha-box">
          <div
            className="login-captcha-img"
            onClick={() => refreshCaptcha()}
            title="点击刷新验证码（60 秒有效，到期自动刷新）"
            dangerouslySetInnerHTML={{
              __html: captchaSvg || '<span style="color:#98a0ac;font-size:12px;">加载中…</span>',
            }}
          />
          {captchaLeft <= CAPTCHA_WARN_AT && captchaLeft > 0 && (
            <span
              className={`login-captcha-countdown ${captchaLeft <= 3 ? "urgent" : "warn"}`}
              title={`验证码将在 ${captchaLeft} 秒后过期，已自动刷新`}
            >
              {captchaLeft}s 后过期
            </span>
          )}
        </div>
        <ReloadOutlined
          className={`login-captcha-refresh ${captchaLoading ? "spinning" : ""}`}
          onClick={() => refreshCaptcha()}
          title="刷新验证码"
        />
      </div>
    </Form.Item>
  );

  return (
    // 登录页是品牌页，固定浅色 + 企业蓝主色，不跟随后台的明暗换肤（商务专业风）
    <ConfigProvider
      theme={{
        algorithm: antdTheme.defaultAlgorithm,
        token: { colorPrimary: "#2563eb", borderRadius: 8 },
      }}
    >
      <div className="login">
        <span className="login-orb-a" aria-hidden />
        <span className="login-orb-b" aria-hidden />

        <div className="login-shell">
          <div className="login-card">
            <header className="login-card-head">
              <span className="login-logo-mark">HR</span>
              <div className="login-card-head-text">
                <div className="login-card-brand">HR 工作台</div>
                <div className="login-card-tagline">
                  让 <span className="login-hl">AI</span> 替你跑招聘全流程
                </div>
              </div>
            </header>

            <div className="login-tabs">
              <button type="button" className={mode === "login" ? "on" : ""} onClick={() => switchMode("login")}>登录</button>
              <button type="button" className={mode === "register" ? "on" : ""} onClick={() => switchMode("register")}>注册</button>
            </div>

            <h2 className="login-title">
              {mode === "login" ? "欢迎回来" : mode === "register" ? "创建账号" : "找回密码"}
            </h2>
            <p className="login-sub">
              {mode === "login"
                ? "登录你的 AI 招聘工作台"
                : mode === "register"
                  ? "注册后管理员会收到通知，审批通过即可登录"
                  : "提交申请，由管理员核对后为你设置新密码"}
            </p>

            {error && <Alert message={error} type="error" showIcon className="login-alert" />}
            {success && <Alert message={success} type="success" showIcon className="login-alert" />}

            {mode === "login" && (
              <Form form={loginForm} onFinish={handleLogin} layout="vertical">
                <Form.Item
                  name="phone"
                  rules={[
                    { required: true, message: "请输入手机号" },
                    { pattern: /^1[3-9]\d{9}$/, message: "手机号格式不正确" },
                  ]}
                >
                  <Input placeholder="手机号" maxLength={11} />
                </Form.Item>

                <Form.Item name="password" rules={[{ required: true, message: "请输入密码" }]}>
                  <Input.Password placeholder="密码" />
                </Form.Item>

                {captchaField}

                <Form.Item style={{ marginBottom: 6 }}>
                  <Button type="primary" htmlType="submit" block loading={loading}>
                    登录
                  </Button>
                </Form.Item>
              </Form>
            )}

            {mode === "register" && (
              <Form form={registerForm} onFinish={handleRegister} layout="vertical">
                <Form.Item
                  name="phone"
                  rules={[
                    { required: true, message: "请输入手机号" },
                    { pattern: /^1[3-9]\d{9}$/, message: "手机号格式不正确" },
                  ]}
                >
                  <Input placeholder="手机号" maxLength={11} />
                </Form.Item>

                <Form.Item name="name" rules={[{ required: true, message: "请输入姓名" }]}>
                  <Input placeholder="姓名" maxLength={20} />
                </Form.Item>

                <Form.Item
                  name="password"
                  rules={[
                    { required: true, message: "请输入密码" },
                    { min: 6, message: "密码至少 6 位" },
                  ]}
                >
                  <Input.Password placeholder="密码（至少 6 位）" />
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
                  <Input.Password placeholder="确认密码" />
                </Form.Item>

                {captchaField}

                <Form.Item style={{ marginBottom: 6 }}>
                  <Button type="primary" htmlType="submit" block loading={loading}>
                    创建账号
                  </Button>
                </Form.Item>
              </Form>
            )}

            {mode === "forgot" && (
              <Form form={forgotForm} onFinish={handleForgot} layout="vertical">
                <Alert
                  type="info"
                  showIcon
                  className="login-alert"
                  message="本系统未接入短信服务，提交申请后需由管理员核对身份并为你设置新密码。"
                />

                <Form.Item
                  name="phone"
                  rules={[
                    { required: true, message: "请输入手机号" },
                    { pattern: /^1[3-9]\d{9}$/, message: "手机号格式不正确" },
                  ]}
                >
                  <Input placeholder="手机号" maxLength={11} />
                </Form.Item>

                <Form.Item name="name" rules={[{ required: true, message: "请输入姓名" }]}>
                  <Input placeholder="姓名（用于核对身份）" maxLength={20} />
                </Form.Item>

                {captchaField}

                <Form.Item style={{ marginBottom: 6 }}>
                  <Button type="primary" htmlType="submit" block loading={loading}>
                    提交申请
                  </Button>
                </Form.Item>
              </Form>
            )}

            <div className="login-switch">
              {mode === "login" && (
                <>
                  <a onClick={() => switchMode("register")}>立即注册</a>
                  <span className="login-switch-sep">·</span>
                  <a onClick={() => switchMode("forgot")}>忘记密码？</a>
                </>
              )}
              {mode === "register" && <a onClick={() => switchMode("login")}>已有账号？返回登录</a>}
              {mode === "forgot" && <a onClick={() => switchMode("login")}>← 返回登录</a>}
            </div>
          </div>

          <div className="login-foot">
            <span>© {new Date().getFullYear()} HR 工作台 · AI 驱动的人力资源管理系统</span>
          </div>
        </div>
      </div>
    </ConfigProvider>
  );
}
