import { useState, useEffect } from "react";
import {
  Modal, Form, Input, InputNumber, Select, Spin, message, Upload, Button, DatePicker,
} from "antd";
import { UploadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api";
import { STATUS_LABELS } from "../types";
import { useDict } from "../dict";

import { notifyOnbSaved } from "./onboardingAutoFill";
import BirthMonthPicker from "./BirthMonthPicker";

interface Props {
  open: boolean;
  talentId?: string | null;
  /** 新手指引代填：非空时（且仅新增态）打开即写入这些字段 */
  prefill?: Record<string, any>;
  /** 新手指引：填充计数变化（表单已打开）时把示例写进当前表单 */
  fillToken?: number;
  onClose: () => void;
  onSuccess: () => void;
}

export default function TalentFormModal({ open, talentId, prefill, fillToken, onClose, onSuccess }: Props) {
  const { sources, education: educationOptions } = useDict();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const isEdit = !!talentId;
  // 出生年月改动时实时算年龄：让用户看到「选完年月就知道几岁」，不用自己减
  const birthWatch = Form.useWatch("birth_date", form) as ReturnType<typeof dayjs> | undefined;
  const ageInputWatch = Form.useWatch("age_input", form) as number | null | undefined;
  const ageHint = birthWatch
    ? `当前 ${dayjs().diff(birthWatch, "year")} 岁 · 自动计算`
    : ageInputWatch != null
      ? `按 ${ageInputWatch} 岁反推出生年（${dayjs().year() - ageInputWatch} 年），详情页标记「推算」`
      : "可选年月，或直接输年龄反推出生年";

  // 选了年月就清掉年龄输入：两个入口写同一个 birth_date，
  // 精确选择优先，避免保存时「年月 + 过期年龄」互相打架
  useEffect(() => {
    if (birthWatch) form.setFieldsValue({ age_input: null });
  }, [birthWatch, form]);

  useEffect(() => {
    if (!open) return;
    const fetchData = async () => {
      setLoading(true);
      try {
        if (isEdit && talentId) {
          const t = await api.getTalent(talentId);
          // estimated（按年龄反推）的生日不回填到年月选择器——那会冒充精确生日。
          // 换算回年龄放进 age_input，用户看到的和自己当初录的一致。
          const isEstimated = t.birth_date_precision === "estimated";
          form.setFieldsValue({
            ...t,
            skills: t.skills.join(", "),
            // 出生日期回填成 dayjs 对象（DatePicker 只认 dayjs，直接塞字符串会显示空白）
            birth_date: t.birth_date && !isEstimated ? dayjs(t.birth_date) : null,
            age_input: t.birth_date && isEstimated ? dayjs().diff(dayjs(t.birth_date), "year") : null,
            hire_date: t.hire_date ? dayjs(t.hire_date) : null,
            next_follow_at: t.next_follow_at ? dayjs(t.next_follow_at) : null,
          });
        } else {
          form.resetFields();
          // 新手指引：打开即写入示例数据（prefill 非空时），用户只须点「保存」
          if (prefill) form.setFieldsValue(prefill);
        }
      } catch (err) {
        message.error((err as Error).message);
      }
      setLoading(false);
    };
    fetchData();
  }, [open, talentId]);

  // 新手指引：弹窗已打开后，点「帮我填好表单」触发 fillToken 变化 → 写入示例数据
  useEffect(() => {
    if (open && !isEdit && prefill) form.setFieldsValue(prefill);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillToken]);

  const handleSubmit = async (values: any) => {
    setSaving(true);
    try {
      // 手机号去重：按手机号查是否已存在（编辑时排除自己），撞到则拦截提交
      const phone = (values.phone || "").trim();
      if (phone) {
        const dup = await api.getTalents({ phone, limit: 50 });
        const hit = (dup.items || []).find((t) => t.id !== (talentId || ""));
        if (hit) {
          message.error(`手机号 ${phone} 已存在于「${hit.name}」档案中，请勿重复录入`);
          setSaving(false);
          return;
        }
      }

      const data = {
        ...values,
        years_experience: values.years_experience ?? undefined,
        // 技能输入框是多行的：逗号、中文逗号、换行都当分隔符
        skills: values.skills
          ? values.skills.split(/[,，\n]/).map((s: string) => s.trim()).filter(Boolean)
          : [],
        // 出生年月只选到月，统一存当月 1 号 + precision=month：
        // 这样 UI 不会把「1996-03-01」当成用户确认过的具体生日。
        // 三态语义：有值→写入；显式清空（null）→清掉；没动过（undefined）→不传，保持原值。
        // age_input：没选年月但输了年龄时，按年龄反推出生年存 1 月 1 日 + estimated 精度，
        // 详情页打「推算」标签（误差最多 1 岁），读取时年龄仍按 birth_date 实时算。
        birth_date: values.birth_date
          ? values.birth_date.format("YYYY-MM-01")
          : values.age_input != null
            ? `${dayjs().year() - values.age_input}-01-01`
            : (values.birth_date === null ? null : undefined),
        birth_date_precision: values.birth_date
          ? "month"
          : values.age_input != null
            ? "estimated"
            : (values.birth_date === null ? null : undefined),
        // 清空出生年月时把年龄一起清掉，否则会留下一个没有来源的孤儿年龄
        age: values.birth_date === null && values.age_input == null ? null : undefined,
        hire_date: values.hire_date ? values.hire_date.format("YYYY-MM-DD") : (values.hire_date === null ? null : undefined),
        next_follow_at: values.next_follow_at
          ? values.next_follow_at.format("YYYY-MM-DD HH:mm")
          : (values.next_follow_at === null ? null : undefined),
      };
      let result;
      if (isEdit && talentId) {
        result = await api.updateTalent(talentId, data);
        message.success("修改已保存");
      } else {
        result = await api.createTalent(data);
        message.success("人才已创建");
        notifyOnbSaved();
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
      width={1080}
      destroyOnClose
      footer={null}
    >
      {loading ? (
        <div style={{ textAlign: "center", padding: "3rem" }}><Spin size="large" /></div>
      ) : (
        <Form form={form} layout="horizontal" className="form-horizontal" labelCol={{ flex: "88px" }} onFinish={handleSubmit} initialValues={{ status: "active" }}>
          <div className="form-grid cols-3">
            <Form.Item name="name" label="姓名" rules={[{ required: true, message: "请输入姓名" }]}>
              <Input placeholder="请输入姓名" />
            </Form.Item>
            <Form.Item name="phone" label="电话" rules={[{ pattern: /^1[3-9]\d{9}$/, message: "手机号格式不正确" }]}>
              <Input placeholder="请输入手机号" maxLength={11} />
            </Form.Item>
            <Form.Item name="email" label="邮箱" rules={[{ type: "email", message: "邮箱格式不正确" }]}>
              <Input placeholder="请输入邮箱" />
            </Form.Item>
            <Form.Item label="出生年月" extra={ageHint}>
              <div style={{ display: "flex", gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Form.Item name="birth_date" noStyle>
                    {/* 不用 DatePicker picker="month"：那个面板点 ‹ 一次只退一年，
                        选 1994 年要连点 30 多次。换成「年 + 月」两个下拉后一次到位。 */}
                    <BirthMonthPicker />
                  </Form.Item>
                </div>
                <Form.Item name="age_input" noStyle>
                  {/* 只知道年龄时的入口：反推出生年存 estimated 精度（见 handleSubmit）。
                      已选年月时禁用——年龄是派生值，防止手改覆盖真实生日 */}
                  <InputNumber
                    min={14}
                    max={80}
                    style={{ width: 104 }}
                    placeholder="或输年龄"
                    addonAfter="岁"
                    disabled={!!birthWatch}
                  />
                </Form.Item>
              </div>
            </Form.Item>
            <Form.Item name="gender" label="性别">
              <Select allowClear placeholder="请选择性别" options={[{ label: "男", value: "男" }, { label: "女", value: "女" }]} />
            </Form.Item>
            <Form.Item name="education" label="学历">
              <Select allowClear placeholder="请选择学历" options={educationOptions.map((e) => ({ label: e, value: e }))} />
            </Form.Item>
            <Form.Item name="school" label="毕业院校">
              <Input placeholder="请输入毕业院校" />
            </Form.Item>
            <Form.Item name="major" label="专业">
              <Input placeholder="请输入所学专业" />
            </Form.Item>
            <Form.Item name="current_company" label="当前公司">
              <Input placeholder="请输入当前公司" />
            </Form.Item>
            <Form.Item name="current_title" label="当前职位">
              <Input placeholder="请输入当前职位" />
            </Form.Item>
            <Form.Item name="years_experience" label="工作年限">
              <InputNumber style={{ width: "100%" }} min={0} placeholder="请输入工作年限" />
            </Form.Item>
            <Form.Item name="city" label="所在城市">
              <Input placeholder="请输入所在城市" />
            </Form.Item>
            <Form.Item name="industry" label="行业">
              <Input placeholder="请输入行业" />
            </Form.Item>
            <Form.Item name="expected_salary" label="期望薪资">
              <Input placeholder="如 30-40k" />
            </Form.Item>
            <Form.Item name="expected_city" label="期望城市">
              <Input placeholder="请输入期望城市" />
            </Form.Item>
            <Form.Item name="status" label="状态">
              <Select placeholder="请选择状态" options={Object.entries(STATUS_LABELS).map(([k, v]) => ({ label: v, value: k }))} />
            </Form.Item>
            <Form.Item name="hire_date" label="入职日期" extra="标记「已入职」或填写此日期后，自动生成社保增员待办">
              <DatePicker style={{ width: "100%" }} placeholder="选择入职日期" allowClear />
            </Form.Item>
            <Form.Item name="next_follow_at" label="下次跟进时间" extra="到期当天自动生成跟进待办并推送提醒（提醒自己）">
              <DatePicker style={{ width: "100%" }} placeholder="选择下次跟进时间" allowClear showTime={{ format: "HH:mm" }} format="YYYY-MM-DD HH:mm" />
            </Form.Item>
            <Form.Item name="source" label="来源渠道">
              <Select allowClear showSearch placeholder="请选择来源渠道" options={sources.map((s) => ({ label: s, value: s }))} />
            </Form.Item>
            <Form.Item name="skills" label="技能" className="span-all">
              {/* 多行输入：技术栈动辄十几个词，单行框要一直横向拖滚动条。
                  提交时逗号、中文逗号、换行都当分隔符（见 handleSubmit）。 */}
              <Input.TextArea
                rows={4}
                placeholder={"每行一个技能，或用逗号分隔\n如 Java / Spring Boot / MySQL / Redis"}
                style={{ resize: "vertical" }}
              />
            </Form.Item>
          </div>
          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={3} placeholder="补充说明…" />
          </Form.Item>
          <Form.Item label="简历文件">
            <Upload
              accept=".pdf,.docx"
              maxCount={1}
              beforeUpload={(file) => { setResumeFile(file); return false; }}
              onRemove={() => { setResumeFile(null); }}
              fileList={resumeFile ? [{ uid: "-1", name: resumeFile.name, status: "done" }] : []}
            >
              <Button icon={<UploadOutlined />}>选择简历文件</Button>
            </Upload>
          </Form.Item>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" htmlType="submit" loading={saving}>
              {isEdit ? "保存修改" : "创建人才"}
            </Button>
          </div>
        </Form>
      )}
    </Modal>
  );
}
