import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  Card, Descriptions, Tag, Button, Space, Typography, Empty, Spin,
  message, Popconfirm, Upload,
} from "antd";
import { EditOutlined, DeleteOutlined, ArrowLeftOutlined, FilePdfOutlined, UploadOutlined } from "@ant-design/icons";
import { api } from "../api";
import type { Talent, User } from "../types";
import { STATUS_LABELS, STATUS_COLORS } from "../types";
import TalentFormModal from "../components/TalentFormModal";
import ResumePreviewModal from "../components/ResumePreviewModal";

export default function TalentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [talent, setTalent] = useState<Talent | null>(null);
  const [loading, setLoading] = useState(true);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  const currentUser: User | null = (() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  })();
  const isAdmin = currentUser?.role === "admin";

  const fetchData = async () => {
    if (!id) return;
    try {
      setTalent(await api.getTalent(id));
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, [id]);

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
              <Descriptions.Item label="性别">{talent.gender || "—"}</Descriptions.Item>
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

          {talent.skills.length > 0 && (
            <Card title="技能标签" style={{ marginBottom: 16 }}>
              <Space wrap>{talent.skills.map((s, i) => <Tag key={i} color="blue">{s}</Tag>)}</Space>
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
