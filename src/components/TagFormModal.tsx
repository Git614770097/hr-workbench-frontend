import { useState, useEffect } from "react";
import {
  Modal, Form, Input, message,
} from "antd";
import { api } from "../api";
import type { Tag } from "../types";

const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];

interface Props {
  open: boolean;
  tag?: (Tag & { talent_count?: number }) | null;
  onClose: () => void;
  onSuccess: () => void;
}

export default function TagFormModal({ open, tag, onClose, onSuccess }: Props) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [color, setColor] = useState(COLORS[0]);
  const isEdit = !!tag;

  useEffect(() => {
    if (open) {
      if (tag) {
        form.setFieldsValue({ name: tag.name });
        setColor(tag.color);
      } else {
        form.resetFields();
        setColor(COLORS[0]);
      }
    }
  }, [open, tag]);

  const handleSubmit = async (values: { name: string }) => {
    setSaving(true);
    try {
      if (isEdit && tag) {
        await api.updateTag(tag.id, { name: values.name.trim(), color });
        message.success("已保存");
      } else {
        await api.createTag({ name: values.name.trim(), color });
        message.success("标签已创建");
      }
      form.resetFields();
      onSuccess();
      onClose();
    } catch (err) {
      message.error((err as Error).message);
    }
    setSaving(false);
  };

  return (
    <Modal
      title={isEdit ? "编辑标签" : "新增标签"}
      open={open}
      onCancel={onClose}
      destroyOnClose
      footer={null}
    >
      <Form form={form} layout="vertical" onFinish={handleSubmit}>
        <Form.Item name="name" label="标签名称" rules={[{ required: true, message: "请输入标签名称" }]}>
          <Input placeholder="请输入标签名称" />
        </Form.Item>
        <Form.Item label="颜色">
          <div style={{ display: "flex", gap: 8 }}>
            {COLORS.map((c) => (
              <div
                key={c}
                onClick={() => setColor(c)}
                style={{
                  width: 28, height: 28, borderRadius: "50%", background: c,
                  cursor: "pointer",
                  border: color === c ? "3px solid #333" : "3px solid transparent",
                  transition: "border 0.2s",
                }}
              />
            ))}
          </div>
        </Form.Item>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="ant-btn ant-btn-default" onClick={onClose}>取消</button>
          <button type="submit" className="ant-btn ant-btn-primary" disabled={saving}>
            {saving ? "保存中…" : isEdit ? "保存" : "创建"}
          </button>
        </div>
      </Form>
    </Modal>
  );
}
