import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  Card, Descriptions, Tag, Button, Space, Typography, Empty, Spin,
  Timeline, Rate, Form, Input, Select, DatePicker, message, Popconfirm,
  Upload,
} from "antd";
import { EditOutlined, DeleteOutlined, PlusOutlined, ArrowLeftOutlined, FilePdfOutlined, UploadOutlined } from "@ant-design/icons";
import { api } from "../api";
import type { Talent, Communication, User, RiskItem, RiskType } from "../types";
import { STATUS_LABELS, STATUS_COLORS, COMM_TYPES, RISK_LEVEL_META } from "../types";
import { countdownText } from "../utils/risk";
import TalentFormModal from "../components/TalentFormModal";
import ResumePreviewModal from "../components/ResumePreviewModal";

const { TextArea } = Input;

export default function TalentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [talent, setTalent] = useState<Talent | null>(null);
  const [comms, setComms] = useState<Communication[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCommForm, setShowCommForm] = useState(false);
  const [commForm] = Form.useForm();
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  // 该人才命中的预警（按类型索引），用于给关键日期标色
  const [risks, setRisks] = useState<Partial<Record<RiskType, RiskItem>>>({});

  const currentUser: User | null = (() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  })();
  const isAdmin = currentUser?.role === "admin";

  const fetchData = async () => {
    if (!id) return;
    try {
      const [t, c, r] = await Promise.all([
        api.getTalent(id),
        api.getCommunications(id),
        api.getRisks().catch(() => ({ items: [] as RiskItem[], summary: { red: 0, yellow: 0, green: 0 } })),
      ]);
      setTalent(t);
      setComms(c);
      const map: Partial<Record<RiskType, RiskItem>> = {};
      r.items.forEach((item) => { if (item.talent_id === id) map[item.type] = item; });
      setRisks(map);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, [id]);

  const handleAddComm = async (values: any) => {
    if (!id) return;
    try {
      await api.createCommunication({
        talent_id: id, type: values.type, content: values.content,
        rating: values.rating || undefined,
        follow_up_date: values.follow_up_date ? values.follow_up_date.format("YYYY-MM-DD") : undefined,
      });
      commForm.resetFields();
      setShowCommForm(false);
      message.success("沟通记录已添加");
      fetchData();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleDeleteComm = async (commId: string) => {
    try {
      await api.deleteCommunication(commId);
      message.success("已删除");
      fetchData();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleDeleteTalent = async () => {
    if (!talent) return;
    try {
      await api.deleteTalent(talent.id);
      message.success("已删除");
      navigate("/talents");
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleUploadResume = async (file: File) => {
    if (!talent) return false;
    setUploading(true);
    try {
      await api.uploadResume(talent.id, file);
      message.success("简历已上传");
      fetchData();
    } catch (err) {
      message.error((err as Error).message);
    }
    setUploading(false);
    return false;
  };

  const handleDeleteResume = async () => {
    if (!talent) return;
    try {
      await api.deleteResume(talent.id);
      message.success("简历已删除");
      fetchData();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  if (loading) return <div style={{ textAlign: "center", padding: "3rem" }}><Spin size="large" /></div>;
  if (!talent) return <Empty description="人才不存在" />;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <Space>
          <Link to="/talents"><Button type="text" icon={<ArrowLeftOutlined />}>返回</Button></Link>
          <Typography.Title level={4} style={{ margin: 0 }}>{talent.name}</Typography.Title>
          <Tag color={STATUS_COLORS[talent.status] || "default"}>{STATUS_LABELS[talent.status] || talent.status}</Tag>
        </Space>
        <Space>
          <Button icon={<EditOutlined />} onClick={() => setEditModalOpen(true)}>编辑</Button>
          <Popconfirm title="确认删除？所有关联数据将被清除。" onConfirm={handleDeleteTalent}>
            <Button danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      </div>

      <div className="detail-grid">
        <div>
          <Card title="基本信息" style={{ marginBottom: 16 }}>
            <Descriptions column={1} size="small">
              <Descriptions.Item label="年龄">{talent.age != null ? `${talent.age}岁` : "—"}</Descriptions.Item>
              <Descriptions.Item label="学历">{talent.education || "—"}</Descriptions.Item>
              <Descriptions.Item label="毕业院校">{talent.school || "—"}</Descriptions.Item>
              <Descriptions.Item label="当前公司">{talent.current_company || "—"}</Descriptions.Item>
              <Descriptions.Item label="当前职位">{talent.current_title || "—"}</Descriptions.Item>
              <Descriptions.Item label="工作年限">{talent.years_experience != null ? `${talent.years_experience}年` : "—"}</Descriptions.Item>
              <Descriptions.Item label="所在城市">{talent.city || "—"}</Descriptions.Item>
              <Descriptions.Item label="行业">{talent.industry || "—"}</Descriptions.Item>
              <Descriptions.Item label="电话">{talent.phone || "—"}</Descriptions.Item>
              <Descriptions.Item label="邮箱">{talent.email || "—"}</Descriptions.Item>
              <Descriptions.Item label="期望薪资">{talent.expected_salary || "—"}</Descriptions.Item>
              <Descriptions.Item label="期望城市">{talent.expected_city || "—"}</Descriptions.Item>
              {isAdmin && <Descriptions.Item label="创建人">{talent.owner_name || "—"}</Descriptions.Item>}
            </Descriptions>
          </Card>

          {(() => {
            const dateRows: { label: string; type: RiskType; value: string | null }[] = [
              { label: "合同到期日", type: "contract_end", value: talent.contract_end },
              { label: "试用期结束日", type: "probation_end", value: talent.probation_end },
              { label: "出生日期", type: "birthday", value: talent.birth_date },
              { label: "预计离职日期", type: "resignation", value: talent.resignation_date },
            ];
            const filled = dateRows.filter((r) => r.value);
            return (
              <Card
                title="关键日期"
                style={{ marginBottom: 16 }}
                extra={<Link to="/risks"><Button type="link" size="small">风险预警看板 →</Button></Link>}
              >
                {filled.length === 0 ? (
                  <Empty description="尚未录入关键日期，编辑人才可补充" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                ) : (
                  <Descriptions column={1} size="small">
                    {filled.map(({ label, type, value }) => {
                      const risk = risks[type];
                      const meta = risk ? RISK_LEVEL_META[risk.level] : null;
                      return (
                        <Descriptions.Item key={type} label={label}>
                          <span className="date-cell">
                            <span className="date-dot" style={{ background: meta ? meta.color : "#d9d9d9" }} />
                            <span>{value}</span>
                            {risk && meta && (
                              <span className="date-countdown" style={{ color: meta.color }}>
                                {countdownText(risk.days_left, type)} · {meta.label}
                              </span>
                            )}
                          </span>
                        </Descriptions.Item>
                      );
                    })}
                  </Descriptions>
                )}
              </Card>
            );
          })()}

          {talent.skills.length > 0 && (
            <Card title="技能标签" style={{ marginBottom: 16 }}>
              <Space wrap>{talent.skills.map((s, i) => <Tag key={i} color="blue">{s}</Tag>)}</Space>
            </Card>
          )}

          {talent.tags.length > 0 && (
            <Card title="自定义标签" style={{ marginBottom: 16 }}>
              <Space wrap>{talent.tags.map((t) => <Tag key={t.id} color={t.color}>{t.name}</Tag>)}</Space>
            </Card>
          )}

          {talent.notes && (
            <Card title="备注">
              <Typography.Paragraph style={{ whiteSpace: "pre-wrap" }}>{talent.notes}</Typography.Paragraph>
            </Card>
          )}
        </div>

        <div>
          {/* 简历预览卡片 */}
          <Card
            title="简历文件"
            style={{ marginBottom: 16 }}
            extra={
              <Upload accept=".pdf,.docx" showUploadList={false} beforeUpload={handleUploadResume} disabled={uploading}>
                <Button size="small" icon={<UploadOutlined />} loading={uploading}>上传简历</Button>
              </Upload>
            }
          >
            {talent.resume_url ? (
              <div>
                <Space style={{ marginBottom: 12 }}>
                  <FilePdfOutlined style={{ fontSize: 20, color: "#ff4d4f" }} />
                  <Typography.Text>{talent.resume_url.split("/").pop()}</Typography.Text>
                </Space>
                <Space>
                  <Button type="primary" onClick={() => setPreviewOpen(true)}>预览简历</Button>
                  <Popconfirm title="确认删除简历文件？人才记录会保留。" onConfirm={handleDeleteResume}>
                    <Button danger icon={<DeleteOutlined />}>删除简历</Button>
                  </Popconfirm>
                </Space>
              </div>
            ) : (
              <Empty description="暂无简历文件，请上传" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            )}
          </Card>

          <Card
            title="沟通记录"
            extra={
              <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setShowCommForm(!showCommForm)}>
                {showCommForm ? "取消" : "添加记录"}
              </Button>
            }
          >
            {showCommForm && (
              <Form form={commForm} layout="vertical" onFinish={handleAddComm} style={{ marginBottom: 16, padding: 16, background: "#fafafa", borderRadius: 8 }}>
                <Form.Item name="type" label="类型" rules={[{ required: true }]} initialValue="call">
                  <Select placeholder="请选择沟通类型" options={Object.entries(COMM_TYPES).map(([k, v]) => ({ label: v, value: k }))} />
                </Form.Item>
                <Form.Item name="rating" label="评分"><Rate /></Form.Item>
                <Form.Item name="follow_up_date" label="跟进提醒日期"><DatePicker style={{ width: "100%" }} placeholder="请选择跟进日期" /></Form.Item>
                <Form.Item name="content" label="沟通内容"><TextArea rows={3} placeholder="记录沟通要点…" /></Form.Item>
                <Button type="primary" htmlType="submit">保存记录</Button>
              </Form>
            )}

            {comms.length === 0 ? (
              <Empty description="暂无沟通记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Timeline
                items={comms.map((comm) => ({
                  color: "blue",
                  children: (
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                        <Tag color="blue">{COMM_TYPES[comm.type] || comm.type}</Tag>
                        {comm.rating != null && comm.rating > 0 && <Rate disabled value={comm.rating} style={{ fontSize: 12 }} />}
                        {isAdmin && comm.user_name && <Tag style={{ fontSize: 11 }}>{comm.user_name}</Tag>}
                        <span style={{ color: "#aaa", fontSize: "0.78rem", marginLeft: "auto" }}>{new Date(comm.created_at).toLocaleString("zh-CN")}</span>
                        <Popconfirm title="确认删除？" onConfirm={() => handleDeleteComm(comm.id)}>
                          <Button type="link" size="small" danger>删除</Button>
                        </Popconfirm>
                      </div>
                      {comm.content && <div style={{ marginTop: "0.4rem", fontSize: "0.88rem", color: "#444" }}>{comm.content}</div>}
                      {comm.follow_up_date && <Tag color="orange" style={{ marginTop: 4 }}>📅 跟进：{comm.follow_up_date}</Tag>}
                    </div>
                  ),
                }))}
              />
            )}
          </Card>
        </div>
      </div>

      {/* 简历预览弹窗（PDF 原生渲染；Word 在线查看，不下载） */}
      <ResumePreviewModal talent={previewOpen ? talent : null} onClose={() => setPreviewOpen(false)} />

      {/* 编辑人才弹窗 */}
      <TalentFormModal
        open={editModalOpen}
        talentId={talent.id}
        onClose={() => setEditModalOpen(false)}
        onSuccess={fetchData}
      />
    </div>
  );
}
