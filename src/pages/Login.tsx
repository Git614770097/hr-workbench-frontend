import { useState } from "react";
import { Form, Input, Button, Alert, Typography } from "antd";
import { MobileOutlined, LockOutlined } from "@ant-design/icons";
import { api } from "../api";

interface Props {
  onLogin: () => void;
}

export default function Login({ onLogin }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (values: { phone: string; password: string }) => {
    setError("");
    setLoading(true);
    try {
      await api.login(values);
      onLogin();
    } catch (err) {
      setError((err as Error).message);
    }
    setLoading(false);
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-header">
          <span className="auth-logo">🎯</span>
          <Typography.Title level={3}>HR 人才库管理系统</Typography.Title>
          <Typography.Text type="secondary">手机号登录</Typography.Text>
        </div>
        {error && <Alert message={error} type="error" showIcon style={{ marginBottom: 16 }} />}
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
          <Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading}>
              登录
            </Button>
          </Form.Item>
        </Form>
        <p className="auth-switch" style={{ fontSize: "0.8rem", color: "#aaa" }}>
          首个登录的手机号自动成为管理员
        </p>
      </div>
    </div>
  );
}
