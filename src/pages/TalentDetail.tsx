import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  Card, Descriptions, Tag, Button, Space, Typography, Empty, Spin, Tooltip,
  message, Popconfirm, Upload, Checkbox, Timeline,
} from "antd";
import {
  EditOutlined, DeleteOutlined, ArrowLeftOutlined, FilePdfOutlined, UploadOutlined,
  CopyOutlined, CalendarOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import type { Task, TalentDetailData, TalentStageLog, User } from "../types";
import { STATUS_LABELS, STATUS_COLORS, STAGE_META, PRIORITY_LABELS, PRIORITY_COLORS } from "../types";
import TalentFormModal from "../components/TalentFormModal";
import ResumePreviewModal from "../components/ResumePreviewModal";

/** 后端 datetime('now') 是 UTC 且无时区后缀，解析时补 T+Z（全站统一做法） */
function fmtUtc(s: string): Date {
  return new Date(s.includes("T") || s.includes("Z") ? s : s.replace(" ", "T") + "Z");
}

function localYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 非 HTTPS / 旧浏览器降级：临时 textarea + execCommand
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
}

/** 电话 / 邮箱旁的复制小图标 */
function CopyBtn({ text, label }: { text: string; label: string }) {
  return (
    <Tooltip title={`复制${label}`}>
      <CopyOutlined
        style={{ color: "#8c8c8c", fontSize: 13, cursor: "pointer" }}
        onClick={async () => {
          const ok = await copyText(text);
          if (ok) message.success(`${label}已复制`);
          else message.error("复制失败，请手动选择复制");
        }}
      />
    </Tooltip>
  );
}

export default function TalentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [talent, setTalent] = useState<TalentDetailData | null>(null);
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

  // 阶段日志按投递分组：id → 该投递的流转历史（正序存，展示时倒序＝最新在上）
  const logGroups = useMemo(() => {
    const g: Record<string, TalentStageLog[]> = {};
    for (const l of talent?.stage_logs || []) {
      (g[l.talent_job_id] ||= []).push(l);
    }
    return g;
  }, [talent]);

  const today = localYmd();

  const toggleTask = async (t: Task) => {
    try {
      await api.updateTaskStatus(t.id, t.status === "done" ? "pending" : "done");
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

  const tasks = talent.tasks || [];
  const pipeline = talent.pipeline || [];

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
            <Descriptions column={2} size="small">
              <Descriptions.Item label="年龄">{talent.age != null ? `${talent.age}岁` : "—"}</Descriptions.Item>
              <Descriptions.Item label="性别">{talent.gender || "—"}</Descriptions.Item>
              <Descriptions.Item label="学历">{talent.education || "—"}</Descriptions.Item>
              <Descriptions.Item label="毕业院校">{talent.school || "—"}</Descriptions.Item>
              <Descriptions.Item label="当前公司">{talent.current_company || "—"}</Descriptions.Item>
              <Descriptions.Item label="当前职位">{talent.current_title || "—"}</Descriptions.Item>
              <Descriptions.Item label="工作年限">{talent.years_experience != null ? `${talent.years_experience}年` : "—"}</Descriptions.Item>
              <Descriptions.Item label="所在城市">{talent.city || "—"}</Descriptions.Item>
              <Descriptions.Item label="行业">{talent.industry || "—"}</Descriptions.Item>
              <Descriptions.Item label="期望薪资">{talent.expected_salary || "—"}</Descriptions.Item>
              <Descriptions.Item label="期望城市">{talent.expected_city || "—"}</Descriptions.Item>
              {isAdmin && <Descriptions.Item label="创建人">{talent.owner_name || "—"}</Descriptions.Item>}
              <Descriptions.Item label="电话" span={2}>
                {talent.phone ? (
                  <Space size={6}>{talent.phone}<CopyBtn text={talent.phone} label="电话" /></Space>
                ) : "—"}
              </Descriptions.Item>
              <Descriptions.Item label="邮箱" span={2}>
                {talent.email ? (
                  <Space size={6}>{talent.email}<CopyBtn text={talent.email} label="邮箱" /></Space>
                ) : "—"}
              </Descriptions.Item>
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

          {/* 相关待办：逾期红、今日橙，可直接打勾完成 */}
          <Card
            title={`相关待办${tasks.length > 0 ? `（${tasks.filter((t) => t.status !== "done").length}）` : ""}`}
            style={{ marginBottom: 16 }}
            extra={
              <Link to="/tasks">
                <Button size="small" icon={<CalendarOutlined />}>去跟进待办</Button>
              </Link>
            }
          >
            {tasks.length === 0 ? (
              <Empty description="暂无关联待办" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <div>
                {tasks.map((t) => {
                  const done = t.status === "done";
                  const overdue = !done && !!t.due_date && t.due_date < today;
                  const dueToday = !done && !!t.due_date && t.due_date === today;
                  return (
                    <div
                      key={t.id}
                      style={{
                        display: "flex", alignItems: "center", gap: 8,
                        padding: "7px 2px", borderBottom: "1px dashed #f0f0f0",
                      }}
                    >
                      <Checkbox checked={done} onChange={() => toggleTask(t)} />
                      <span
                        style={{
                          flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          fontSize: 13, color: done ? "#9ca3af" : "#374151",
                          textDecoration: done ? "line-through" : "none",
                        }}
                        title={t.content || t.title}
                      >
                        {t.title}
                      </span>
                      {t.priority === "high" && !done && (
                        <Tag color={PRIORITY_COLORS.high} style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: "18px" }}>
                          {PRIORITY_LABELS.high}
                        </Tag>
                      )}
                      {t.due_date && (
                        <Tag
                          color={overdue ? "red" : dueToday ? "orange" : "default"}
                          style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: "18px", flexShrink: 0 }}
                        >
                          {overdue ? "逾期 " : dueToday ? "今日 " : ""}
                          {t.due_date.slice(5).replace("-", "月")}日
                        </Tag>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* 投递进程：每个岗位一条，含当前阶段与流转时间线 */}
          <Card title={`投递进程${pipeline.length > 0 ? `（${pipeline.length}）` : ""}`}>
            {pipeline.length === 0 ? (
              <Empty description="尚未进入招聘流程" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              pipeline.map((p, idx) => {
                const meta = STAGE_META[p.stage];
                const logs = (logGroups[p.id] || []).slice().reverse();
                return (
                  <div
                    key={p.id}
                    style={{
                      paddingBottom: idx === pipeline.length - 1 ? 0 : 14,
                      marginBottom: idx === pipeline.length - 1 ? 0 : 14,
                      borderBottom: idx === pipeline.length - 1 ? "none" : "1px dashed #f0f0f0",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <Typography.Text strong style={{ fontSize: 13 }}>{p.job_title}</Typography.Text>
                      <Tag color={meta?.color} style={{ marginInlineEnd: 0 }}>{meta?.label || p.stage}</Tag>
                      {p.rating != null && p.rating > 0 && (
                        <span style={{ color: "#faad14", fontSize: 12 }} title={`评分 ${p.rating}`}>{"★".repeat(p.rating)}</span>
                      )}
                      <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: "auto" }}>
                        更新于 {fmtUtc(p.updated_at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}
                      </Typography.Text>
                    </div>
                    {logs.length > 0 && (
                      <Timeline
                        style={{ marginTop: 10, marginBottom: 0 }}
                        items={logs.map((l) => {
                          const m = STAGE_META[l.to_stage];
                          const d = fmtUtc(l.created_at);
                          const dateStr = `${d.getMonth() + 1}月${d.getDate()}日`;
                          return {
                            color: m?.color || "#d9d9d9",
                            children: (
                              <span style={{ fontSize: 12, color: "#4b5563" }}>
                                {dateStr} 进入「{m?.label || l.to_stage}」
                                {l.user_name ? <span style={{ color: "#9ca3af" }}> · {l.user_name}</span> : null}
                                {l.remark ? <span style={{ color: "#6b7280" }}> · {l.remark}</span> : null}
                              </span>
                            ),
                          };
                        })}
                      />
                    )}
                  </div>
                );
              })
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
