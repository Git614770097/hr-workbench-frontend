import { useState, type CSSProperties, type ReactNode } from "react";
import { Alert, Button, Card, Space, Spin, Tag, Typography } from "antd";
import { RobotOutlined, ReloadOutlined, CopyOutlined } from "@ant-design/icons";
import { copyText } from "../utils/clipboard";
import { message } from "antd";

// AI 结果卡：简历解读 / 沟通文案 / 面试问题 / 综合评估 四处复用。
// 统一处理四态：未生成（占位说明）/ 生成中 / 失败降级（不阻塞原流程）/ 结果。
// 标题常驻「AI 生成」角标——AI 产出是草稿，必须让用户一眼看出这不是人工写的。
export interface AiResultCardProps {
  title: string;
  /** 点「生成」时调用；返回 null 表示调用方已自行提示错误，这里不再展示降级条 */
  onGenerate: () => Promise<Record<string, unknown> | null>;
  render: (data: any) => ReactNode;
  /** 结果转纯文本（「复制全部」用）；不传则不显示复制按钮 */
  toText?: (data: any) => string;
  /** 未生成时的占位说明 */
  hint?: string;
  /** 标题右侧额外控件（如场景/语气选择） */
  extra?: ReactNode;
  style?: CSSProperties;
  /** 生成中按钮上方的补充说明，如「正在读取简历原文…」 */
  loadingTip?: string;
}

export default function AiResultCard({
  title, onGenerate, render, toText, hint, extra, style, loadingTip,
}: AiResultCardProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [copied, setCopied] = useState(false);

  const run = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await onGenerate();
      if (res === null) return; // 调用方已处理
      setData(res);
      setCopied(false);
    } catch (err) {
      // 配额用尽 / AI 不可用 / 网络异常：都只提示，不阻塞任何原有流程
      setError((err as Error).message || "生成失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!data || !toText) return;
    const ok = await copyText(toText(data));
    if (ok) {
      message.success("已复制到剪贴板");
      setCopied(true);
    } else {
      message.error("复制失败，请手动选择复制");
    }
  };

  return (
    <Card
      size="small"
      style={style}
      title={
        <Space size={6}>
          <RobotOutlined />
          <span>{title}</span>
          <Tag color="purple" style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: "18px" }}>AI 生成</Tag>
          {data?._cached ? (
            <Tag style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: "18px" }}>缓存</Tag>
          ) : null}
        </Space>
      }
      extra={
        <Space size={8}>
          {extra}
          {data && toText ? (
            <Button size="small" type={copied ? "primary" : "default"} ghost={copied} icon={<CopyOutlined />} onClick={handleCopy}>
              {copied ? "已复制" : "复制全部"}
            </Button>
          ) : null}
          <Button size="small" type="primary" ghost icon={<ReloadOutlined />} loading={loading} onClick={run}>
            {data ? "重新生成" : "生成"}
          </Button>
        </Space>
      }
    >
      {loading ? (
        <div style={{ textAlign: "center", padding: "18px 0" }}>
          <Spin />
          <div style={{ marginTop: 8, fontSize: 12, color: "#8c8c8c" }}>
            {loadingTip || "AI 正在生成，约需 5-15 秒…"}
          </div>
        </div>
      ) : error ? (
        <Alert
          type="warning"
          showIcon
          message={error}
          description="AI 服务暂时不可用不影响其他功能，可稍后重试或手动处理。"
          action={<Button size="small" onClick={run}>重试</Button>}
        />
      ) : data ? (
        <div>{render(data)}</div>
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {hint || "点击「生成」，AI 会基于当前信息给出草稿，供你参考修改后使用。"}
        </Typography.Text>
      )}
    </Card>
  );
}
