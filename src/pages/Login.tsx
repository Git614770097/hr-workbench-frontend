import { useState, useEffect, useCallback, useRef } from "react";
import { Form, Input, Button, Alert, ConfigProvider, theme as antdTheme, Radio } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { api } from "../api";
import { INTENDED_ROLES } from "../types";
import { IDENTITY_PROFILES, DEFAULT_PROFILE, type IdentityProfile } from "../identityProfiles";
import "../styles/login.css";

interface Props {
  onLogin: () => void;
}

type Mode = "login" | "register" | "forgot";

// 邀请码：支持从 /?r=CODE 邀请链接进入注册页时自动带上。
// 后端对非法/不存在的邀请码静默忽略，不影响注册结果。
//
// ⚠️ 必须写成「函数 + 组件挂载时调用」，不能用模块级常量：
// Login 是同步 import 的，模块常量会在应用启动时求值一次；而落地页切换版本用的是
// history.replaceState（不刷新页面），之后 SPA 导航到 /login 时模块不会重新求值，
// 读到的仍是首屏那一刻的 URL —— 于是「切到猎头版 → 点注册」还是 HR 版（曾经的断链）。
function refCodeFromUrl() {
  return new URLSearchParams(window.location.search).get("r")?.trim().toUpperCase() || "";
}

// 身份分版本：未登录时读不到用户身份，用链接参数 ?for=headhunter 指定版本。
// 落地页的「登录 / 注册」入口会带上它，注册表单据此预选「我的身份」。
function profileFromUrl(): IdentityProfile | null {
  const key = new URLSearchParams(window.location.search).get("for")?.trim() || "";
  return IDENTITY_PROFILES[key] || null;
}

// 图形验证码有效期（与后端 SESSIONS.put(`captcha:${id}`, code, { expirationTtl: 60 }) 保持一致）
const CAPTCHA_TTL = 60;
// 剩余多少秒开始显示「即将过期」预警
const CAPTCHA_WARN_AT = 10;

export default function Login({ onLogin }: Props) {
  // 品牌档案：带 ?for=xxx 时用指定版本，否则用默认（HR）版本。
  // 惰性 state 在挂载时读一次 URL，保证「落地页切版本 → 点登录/注册」能拿到正确版本。
  const [brand] = useState<IdentityProfile>(() => profileFromUrl() || DEFAULT_PROFILE);
  // 邀请码：同样在挂载时读一次
  const [refCode] = useState(refCodeFromUrl);
  // 浏览器标签页标题跟随品牌（猎头版不该是「招聘全生命周期管理系统」）
  useEffect(() => {
    document.title = `${brand.name} · ${brand.tagline}`;
  }, [brand.name, brand.tagline]);
  const [mode, setMode] = useState<Mode>("login");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [captchaId, setCaptchaId] = useState("");
  const [captchaSvg, setCaptchaSvg] = useState("");
  const [captchaLoading, setCaptchaLoading] = useState(false);
  // 当前验证码剩余有效秒数
  const [captchaLeft, setCaptchaLeft] = useState(CAPTCHA_TTL);
  // 邀请码默认收起（选填项，避免占满注册表单高度）；带 ?r= 进来自动展开
  const [refOpen, setRefOpen] = useState(!!refCode);
  // 注册短信验证码：发送中 + 60 秒重发倒计时
  const [smsSending, setSmsSending] = useState(false);
  const [smsLeft, setSmsLeft] = useState(0);

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

  // 短信验证码重发倒计时
  useEffect(() => {
    if (smsLeft <= 0) return;
    const t = window.setTimeout(() => setSmsLeft((v) => v - 1), 1000);
    return () => window.clearTimeout(t);
  }, [smsLeft]);

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
    }
    setLoading(false);
  };

  const handleRegister = async (values: {
    phone: string; name: string; password: string; confirm: string; sms_code: string; ref?: string; intended_role?: string;
  }) => {
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      await api.register({
        phone: values.phone,
        name: values.name,
        password: values.password,
        sms_code: values.sms_code,
        ref: (values.ref || "").trim(),
        intended_role: values.intended_role || "hr",
      });
      setSuccess("注册成功，审核通过后用同一手机号登录即可");
      registerForm.resetFields();
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  };

  // 发送短信验证码（手机号合法后才能发，60 秒倒计时内禁用）。
  // 注册、登录共用同一发送逻辑，仅读取的表单不同。
  const sendSms = async (phone: string, scene: "register" | "reset") => {
    if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
      setError("请输入正确的手机号后再获取验证码");
      return;
    }
    setError("");
    setSmsSending(true);
    try {
      await api.sendSms(phone, scene);
      setSmsLeft(60);
    } catch (err) {
      setError((err as Error).message);
    }
    setSmsSending(false);
  };

  const handleSendRegisterSms = () => sendSms(registerForm.getFieldValue("phone"), "register");
  const handleSendForgotSms = () => sendSms(forgotForm.getFieldValue("phone"), "reset");

  const handleForgot = async (values: { phone: string; name: string; sms_code: string }) => {
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      const res = await api.forgotPassword({
        phone: values.phone,
        name: values.name,
        sms_code: values.sms_code,
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
            <aside className="login-brand">
              <span className="login-brand-tag"><i />云端部署 · 打开浏览器即用</span>
              <h1>让 <span className="login-hl">AI</span> 替你<br />{brand.loginHeroTail}</h1>
              <p className="login-brand-lead">{brand.loginLead}</p>
              <ul className="login-points">
                {brand.loginPoints.map((t, i) => (
                  <li key={i}><span className="num">{String(i + 1).padStart(2, "0")}</span><span>{t}</span></li>
                ))}
              </ul>
              <div className="login-kpis">
                <div><b className="num">6+</b><span>核心模块</span></div>
                <div><b className="num">110+</b><span>{brand.templateKpiLabel}</span></div>
              </div>
            </aside>

            <main className="login-form">
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
                    ? "注册后管理员会尽快开通，开通后用同一手机号直接登录"
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

                  {/* 登录：图文验证码（避免每次登录都发短信产生费用；注册仍用短信） */}
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
                    name="intended_role"
                    label="我的身份"
                    initialValue={brand.key}
                    rules={[{ required: true, message: "请选择身份" }]}
                  >
                    <Radio.Group className="reg-role-group">
                      {INTENDED_ROLES.map((r) => (
                        <Radio.Button key={r.key} value={r.key} className="reg-role-item">
                          <span className="reg-role-label">{r.label}</span>
                          <span className="reg-role-desc">{r.desc}</span>
                        </Radio.Button>
                      ))}
                    </Radio.Group>
                  </Form.Item>

                  {/* 两列并排：注册字段多，纵向堆叠会把卡片撑到需要滚动（窄屏自动回落单列） */}
                  <div className="reg-2col">
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
                  </div>

                  <div className="reg-2col">
                    <Form.Item
                      name="password"
                      rules={[
                        { required: true, message: "请输入密码" },
                        { min: 6, message: "密码至少 6 位" },
                      ]}
                    >
                      <Input.Password placeholder="设置密码（至少 6 位）" />
                    </Form.Item>

                    <Form.Item
                      name="confirm"
                      dependencies={["password"]}
                      rules={[
                        { required: true, message: "请再次输入密码" },
                        ({ getFieldValue }) => ({
                          validator(_, value) {
                            if (!value || getFieldValue("password") === value) return Promise.resolve();
                            return Promise.reject(new Error("两次密码不一致"));
                          },
                        }),
                      ]}
                    >
                      <Input.Password placeholder="确认密码" />
                    </Form.Item>
                  </div>

                  {refOpen ? (
                    <Form.Item
                      name="ref"
                      initialValue={refCode}
                      extra={refCode ? "已通过邀请链接自动填入" : "填写后双方会员时长都有赠送"}
                    >
                      <Input placeholder="邀请码" maxLength={12} />
                    </Form.Item>
                  ) : (
                    <div className="login-ref-toggle">
                      <a onClick={() => setRefOpen(true)}>有邀请码？</a>
                      <span>填写后双方会员时长都有赠送</span>
                    </div>
                  )}

                  {/* 注册：短信验证码（替代图形验证码，确保手机号真实可用） */}
                  <Form.Item
                    name="sms_code"
                    // 重新发送会让旧码立即失效（阿里云只认最新一条）——这是「明明收到了
                    // 短信却报验证码错误」的最常见原因，必须在输入框旁边讲清楚。
                    extra={smsLeft > 0 ? "验证码已发送，5 分钟内有效；若收到多条短信，请只使用最新一条" : undefined}
                    rules={[
                      { required: true, message: "请输入短信验证码" },
                      { pattern: /^\d{4,8}$/, message: "验证码格式不正确" },
                    ]}
                  >
                    <div className="login-captcha">
                      <Input placeholder="短信验证码" maxLength={8} className="login-captcha-input" />
                      <Button
                        type="link"
                        className="login-sms-btn"
                        disabled={smsLeft > 0 || smsSending}
                        loading={smsSending}
                        onClick={handleSendRegisterSms}
                      >
                        {smsLeft > 0 ? `${smsLeft}s 后重发` : "获取验证码"}
                      </Button>
                    </div>
                  </Form.Item>

                  <Form.Item style={{ marginBottom: 6 }}>
                    <Button type="primary" htmlType="submit" block loading={loading}>
                      创建账号
                    </Button>
                  </Form.Item>
                </Form>
              )}

              {mode === "forgot" && (
                <Form form={forgotForm} onFinish={handleForgot} layout="vertical">
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

                  {/* 忘记密码：短信验证码（与注册一致） */}
                  <Form.Item
                    name="sms_code"
                    extra={smsLeft > 0 ? "验证码已发送，5 分钟内有效；若收到多条短信，请只使用最新一条" : undefined}
                    rules={[
                      { required: true, message: "请输入短信验证码" },
                      { pattern: /^\d{4,8}$/, message: "验证码格式不正确" },
                    ]}
                  >
                    <div className="login-captcha">
                      <Input placeholder="短信验证码" maxLength={8} className="login-captcha-input" />
                      <Button
                        type="link"
                        className="login-sms-btn"
                        disabled={smsLeft > 0 || smsSending}
                        loading={smsSending}
                        onClick={handleSendForgotSms}
                      >
                        {smsLeft > 0 ? `${smsLeft}s 后重发` : "获取验证码"}
                      </Button>
                    </div>
                  </Form.Item>

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
            </main>
          </div>

          <div className="login-foot">
            <span>© {new Date().getFullYear()} {brand.name} · {brand.loginFooterTail}</span>
          </div>
        </div>
      </div>
    </ConfigProvider>
  );
}
