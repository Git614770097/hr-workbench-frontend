import { useState, useEffect } from "react";
import {
  Modal, Form, Input, InputNumber, Select, Spin, message, Upload, DatePicker, Divider,
} from "antd";
import { UploadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api";
import type { Talent, Tag } from "../types";
import { STATUS_LABELS, EDUCATION_OPTIONS } from "../types";

interface Props {
  open: boolean;
  talentId?: string | null;
  onClose: () => void;
  onSuccess: () => void;
}

export default function TalentFormModal({ open, talentId, onClose, onSuccess }: Props) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tags, setTags] = useState<Tag[]>([]);
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const isEdit = !!talentId;

  useEffect(() => {
    if (!open) return;
    const fetchData = async () => {
      setLoading(true);
      try {
        const tagRes = await api.getTags();
        setTags(tagRes);
        if (isEdit && talentId) {
          const t = await api.getTalent(talentId);
          form.setFieldsValue({
            ...t,
            skills: t.skills.join(", "),
            tag_ids: t.tags.map((tag) => tag.id),
            birth_date: t.birth_date ? dayjs(t.birth_date) : null,
            contract_end: t.contract_end ? dayjs(t.contract_end) : null,
            probation_end: t.probation_end ? dayjs(t.probation_end) : null,
            resignation_date: t.resignation_date ? dayjs(t.resignation_date) : null,
          });
        } else {
          form.resetFields();
        }
      } catch (err) {
        message.error((err as Error).message);
      }
      setLoading(false);
    };
    fetchData();
  }, [open, talentId]);

  const handleSubmit = async (values: any) => {
    setSaving(true);
    try {
      const data = {
        ...values,
        years_experience: values.years_experience ?? undefined,
        skills: values.skills ? values.skills.split(",").map((s: string) => s.trim()).filter(Boolean) : [],
        tag_ids: values.tag_ids || [],
        // 日期：dayjs → "YYYY-MM-DD"；清空传 "" 让后端置 NULL
        birth_date: values.birth_date ? values.birth_date.format("YYYY-MM-DD") : "",
        contract_end: values.contract_end ? values.contract_end.format("YYYY-MM-DD") : "",
        probation_end: values.probation_end ? values.probation_end.format("YYYY-MM-DD") : "",
        resignation_date: values.resignation_date ? values.resignation_date.format("YYYY-MM-DD") : "",
      };
      let result;
      if (isEdit && talentId) {
        result = await api.updateTalent(talentId, data);
        message.success("修改已保存");
      } else {
        result = await api.createTalent(data);
        message.success("人才已创建");
      }
      // 上传简历文件
      if (resumeFile && result?.id) {
        try {
          await api.uploadResume(result.id, resumeFile);
          message.success("简历已上传");
        } catch (e) {
          message.warning("简历上传失败，可稍后在详情页上传");
        }
      }
      form.resetFields();
      setResumeFile(null);
      onSuccess();
      onClose();
    } catch (err) {
      message.error((err as Error).message);
    }
    setSaving(false);
  };

  return (
    <Modal
      title={isEdit ? "编辑人才" : "新增人才"}
      open={open}
      onCancel={onClose}
      width={680}
      destroyOnClose
      footer={null}
    >
      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem" }}><Spin size="large" /></div>
      ) : (
        <Form form={form} layout="vertical" onFinish={handleSubmit} initialValues={{ status: "active" }}>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: "请输入姓名" }]}>
            <Input placeholder="请输入姓名" />
          </Form.Item>
          <Form.Item name="phone" label="电话" style={{ display: "inline-block", width: "calc(50% - 8px)", marginRight: 16 }}>
            <Input placeholder="请输入手机号" />
          </Form.Item>
          <Form.Item name="email" label="邮箱" style={{ display: "inline-block", width: "calc(50% - 8px)" }}>
            <Input placeholder="请输入邮箱" />
          </Form.Item>
          <Form.Item name="age" label="年龄" style={{ display: "inline-block", width: "calc(50% - 8px)", marginRight: 16 }}>
            <InputNumber style={{ width: "100%" }} min={16} max={80} placeholder="请输入年龄" />
          </Form.Item>
          <Form.Item name="education" label="学历" style={{ display: "inline-block", width: "calc(50% - 8px)" }}>
            <Select allowClear placeholder="请选择学历" options={EDUCATION_OPTIONS.map((e) => ({ label: e, value: e }))} />
          </Form.Item>
          <Form.Item name="school" label="毕业院校" style={{ display: "inline-block", width: "calc(50% - 8px)", marginRight: 16 }}>
            <Input placeholder="请输入毕业院校" />
          </Form.Item>
          <Form.Item name="current_company" label="当前公司" style={{ display: "inline-block", width: "calc(50% - 8px)" }}>
            <Input placeholder="请输入当前公司" />
          </Form.Item>
          <Form.Item name="current_title" label="当前职位" style={{ display: "inline-block", width: "calc(50% - 8px)", marginRight: 16 }}>
            <Input placeholder="请输入当前职位" />
          </Form.Item>
          <Form.Item name="years_experience" label="工作年限" style={{ display: "inline-block", width: "calc(50% - 8px)" }}>
            <InputNumber style={{ width: "100%" }} min={0} placeholder="请输入工作年限" />
          </Form.Item>
          <Form.Item name="city" label="所在城市" style={{ display: "inline-block", width: "calc(50% - 8px)", marginRight: 16 }}>
            <Input placeholder="请输入所在城市" />
          </Form.Item>
          <Form.Item name="industry" label="行业" style={{ display: "inline-block", width: "calc(50% - 8px)" }}>
            <Input placeholder="请输入行业" />
          </Form.Item>
          <Form.Item name="expected_salary" label="期望薪资" style={{ display: "inline-block", width: "calc(50% - 8px)", marginRight: 16 }}>
            <Input placeholder="如 30-40k" />
          </Form.Item>
          <Form.Item name="expected_city" label="期望城市" style={{ display: "inline-block", width: "calc(50% - 8px)" }}>
            <Input placeholder="请输入期望城市" />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select placeholder="请选择状态" options={Object.entries(STATUS_LABELS).map(([k, v]) => ({ label: v, value: k }))} />
          </Form.Item>
          <Form.Item name="skills" label="技能（逗号分隔）">
            <Input placeholder="如 Java, Spring, MySQL, 微服务" />
          </Form.Item>
          {tags.length > 0 && (
            <Form.Item name="tag_ids" label="自定义标签">
              <Select
                mode="multiple"
                allowClear
                placeholder="请选择标签"
                options={tags.map((t) => ({ label: t.name, value: t.id }))}
                tagRender={(props) => (
                  <span style={{ display: "inline-block", padding: "0 8px", fontSize: 12, borderRadius: 4, margin: 2, background: tags.find((t) => t.id === props.value)?.color + "20", color: tags.find((t) => t.id === props.value)?.color }}>
                    {props.label}
                  </span>
                )}
              />
            </Form.Item>
          )}
          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={3} placeholder="补充说明…" />
          </Form.Item>
          <Divider style={{ margin: "4px 0 16px" }}>关键日期（用于风险预警，选填）</Divider>
          <Form.Item name="birth_date" label="出生日期" style={{ display: "inline-block", width: "calc(50% - 8px)", marginRight: 16 }}>
            <DatePicker style={{ width: "100%" }} placeholder="请选择出生日期" />
          </Form.Item>
          <Form.Item name="contract_end" label="合同到期日" style={{ display: "inline-block", width: "calc(50% - 8px)" }}>
            <DatePicker style={{ width: "100%" }} placeholder="请选择合同到期日" />
          </Form.Item>
          <Form.Item name="probation_end" label="试用期结束日" style={{ display: "inline-block", width: "calc(50% - 8px)", marginRight: 16 }}>
            <DatePicker style={{ width: "100%" }} placeholder="请选择试用期结束日" />
          </Form.Item>
          <Form.Item name="resignation_date" label="预计离职日期" style={{ display: "inline-block", width: "calc(50% - 8px)" }}>
            <DatePicker style={{ width: "100%" }} placeholder="请选择预计离职日期" />
          </Form.Item>
          <Form.Item label="简历文件">
            <Upload
              accept=".pdf,.docx"
              maxCount={1}
              beforeUpload={(file) => { setResumeFile(file); return false; }}
              onRemove={() => { setResumeFile(null); }}
              fileList={resumeFile ? [{ uid: "-1", name: resumeFile.name, status: "done" }] : []}
            >
              <button type="button" className="ant-btn ant-btn-default">
                <UploadOutlined /> 选择简历文件
              </button>
            </Upload>
          </Form.Item>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="ant-btn ant-btn-default" onClick={onClose}>取消</button>
            <button type="submit" className="ant-btn ant-btn-primary" disabled={saving}>
              {saving ? "保存中…" : isEdit ? "保存修改" : "创建人才"}
            </button>
          </div>
        </Form>
      )}
    </Modal>
  );
}
