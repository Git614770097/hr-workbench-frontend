import { useState, useEffect } from "react";
import { Modal, Input, Button, Alert, message } from "antd";
import { api } from "../api";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export default function PayConfigModal({ open, onClose, onSaved }: Props) {
  const [wechat, setWechat] = useState("");
  const [alipay, setAlipay] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.getPayConfig()
      .then((c) => {
        setWechat(c.wechat_qr || "");
        setAlipay(c.alipay_qr || "");
        setNote(c.note || "");
      })
      .catch(() => {});
  }, [open]);

  const readFile = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error("读取图片失败"));
      reader.readAsDataURL(file);
    });

  const handleWechat = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setWechat(await readFile(f));
  };
  const handleAlipay = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setAlipay(await readFile(f));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.setPayConfig({ wechat_qr: wechat, alipay_qr: alipay, note });
      message.success("收款设置已保存");
      onSaved();
      onClose();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="支付收款设置" open={open} onCancel={onClose} footer={null}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="上传微信 / 支付宝收款码截图，用户在点「会员续费」时即可看到并扫码付款。"
      />
      <div style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 6 }}>微信收款码</div>
        <input type="file" accept="image/*" onChange={handleWechat} />
        {wechat ? (
          <div style={{ marginTop: 8 }}>
            <img
              src={wechat}
              alt="微信收款码"
              style={{ width: 140, height: 140, objectFit: "contain", border: "1px solid var(--color-border-tertiary)", borderRadius: 8, background: "#fff" }}
            />
            <Button type="link" size="small" danger onClick={() => setWechat("")}>
              清除
            </Button>
          </div>
        ) : null}
      </div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 6 }}>支付宝收款码</div>
        <input type="file" accept="image/*" onChange={handleAlipay} />
        {alipay ? (
          <div style={{ marginTop: 8 }}>
            <img
              src={alipay}
              alt="支付宝收款码"
              style={{ width: 140, height: 140, objectFit: "contain", border: "1px solid var(--color-border-tertiary)", borderRadius: 8, background: "#fff" }}
            />
            <Button type="link" size="small" danger onClick={() => setAlipay("")}>
              清除
            </Button>
          </div>
        ) : null}
      </div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 6 }}>说明文字（选填，展示在收款码上方）</div>
        <Input.TextArea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="例如：年费 ¥49.9，扫码付款后联系管理员开通"
        />
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button onClick={onClose}>取消</Button>
        <Button type="primary" loading={saving} onClick={handleSave}>
          保存
        </Button>
      </div>
    </Modal>
  );
}
