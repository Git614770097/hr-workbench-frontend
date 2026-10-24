import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  Card, Descriptions, Tag, Button, Space, Typography, Empty, Spin, Tooltip,
  message, Popconfirm, Upload, Checkbox, Timeline,
} from "antd";
import {
  EditOutlined, DeleteOutlined, ArrowLeftOutlined, FilePdfOutlined, UploadOutlined,
  CopyOutlined, CalendarOutlined, RobotOutlined, SolutionOutlined, SafetyOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import type { Task, TalentDetailData, TalentStageLog, User, AiResumeInsight } from "../types";
import { STATUS_LABELS, STATUS_COLORS, STAGE_META, PRIORITY_LABELS, PRIORITY_COLORS } from "../types";
import TalentFormModal from "../components/TalentFormModal";
import ResumePreviewModal from "../components/ResumePreviewModal";
import AiResultCard from "../components/AiResultCard";
import AiInsightView, { insightToText } from "../components/AiInsightView";
import AiOutreachModal from "../components/AiOutreachModal";
import { copyText } from "../utils/clipboard";
import { parseResumeFile } from "../utils/resumeImport";
import { useIdentityProfile } from "../useIdentity";
import { termFor } from "../identityProfiles";

/** 后端 datetime('now') 是 UTC 且无时区后缀，解析时补 T+Z（全站统一做法） */
function fmtUtc(s: string): Date {
  return new Date(s.includes("T") || s.includes("Z") ? s : s.replace(" ", "T") + "Z");
}

function localYmd(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

/**
 * 读取已上传简历的原文（AI 解读用）。
 * 走一次性票据 URL 拉文件 → File → 复用导入链路的 pdfjs/mammoth 抽取。
 * 任何一步失败都返回 null：后端会退化为「仅按字段解读」，不让解读功能被文件问题卡死。
 */
async function readResumeText(t: TalentDetailData): Promise<string | null> {
  // 平台同步来的简历原文优先：已经躺在库里，不需要再拉文件解析一次
  if (t.resume_text && t.resume_text.trim()) return t.resume_text;
  if (!t.resume_url) return null;
  try {
    const url = await api.getResumeUrl(t.id);
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const name = t.resume_url.split("/").pop() || "resume.pdf";
    const file = new File([blob], name, { type: blob.type || "application/pdf" });
    return await parseResumeFile(file);
  } catch {
    return null;
  }
}

export default function TalentDetail() {
  const profile = useIdentityProfile();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [talent, setTalent] = useState<TalentDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [outreachOpen, setOutreachOpen] = useState(false);

  const currentUser: User | null = (() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  })();
  const isAdmin = currentUser?.role === "admin";
  // 页内入口按菜单权限显示（与侧栏一致）：没有的权限不摆按钮，点了也是被 RequirePerm 拦
  const canP = (p: string) => isAdmin || (currentUser?.permissions || []).includes(p);

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
  if (!talent) return <Empty description={termFor(profile, "人才不存在")} />;

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
        <Space wrap>
          <Button icon={<EditOutlined />} onClick={() => setEditModalOpen(true)}>编辑</Button>
          <Tooltip title="按场景生成邀约 / 婉拒 / 跟进话术，复制后由你自行发送">
            <Button className="ai-btn" icon={<RobotOutlined />} onClick={() => setOutreachOpen(true)}>AI 沟通文案</Button>
          </Tooltip>
          {/* 人才AI匹配：带本人才跳到匹配页，AI 按画像评分（/match 原本全站无入口）。
              用站内统一 ai-btn 标识 AI 能力 */}
          {canP("profiles") && (
            <Tooltip title="选一个职位画像，AI 按匹配度给该候选人评分并给出理由">
              <Button className="ai-btn" icon={<RobotOutlined />} onClick={() => navigate("/match", { state: { talentId: talent.id } })}>
                人才AI匹配
              </Button>
            </Tooltip>
          )}
          {/* 入职办理 / 背调中心：带本人才预选跳转，不用到目标页再找一遍人 */}
          {canP("pipeline") && (
            <Link to={`/onboarding?talent_id=${talent.id}`}>
              <Button icon={<SolutionOutlined />}>入职办理</Button>
            </Link>
          )}
          {canP("background") && (
            <Link to={`/background?talent_id=${talent.id}`}>
              <Button icon={<SafetyOutlined />}>背调中心</Button>
            </Link>
          )}
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
              <Descriptions.Item label="来源渠道">{talent.source || "—"}</Descriptions.Item>
              <Descriptions.Item label="入职日期">{talent.hire_date || "—"}</Descriptions.Item>
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

          {/* 简历原文：平台同步/粘贴录入的全文。与 resume_url 文件并存——
              文件用于原始排版预览，文本用于全文检索与 AI 解读 */}
          {talent.resume_text && (
            <Card
              title="简历原文"
              style={{ marginBottom: 16 }}
              extra={
                <Tag color="blue">
                  {talent.entry_type === "sync" ? "招聘平台同步" : "已录入"}
                </Tag>
              }
            >
              <div
                style={{
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontSize: 13,
                  lineHeight: 1.9,
                  color: "#334155",
                  maxHeight: 520,
                  overflowY: "auto",
                  paddingRight: 4,
                }}
              >
                {talent.resume_text}
              </div>
            </Card>
          )}

          {/* AI 简历解读：亮点/风险/与岗位匹配度。有简历文件时先抽取原文，失败则仅按字段 */}
          <AiResultCard
            title="AI 简历解读"
            style={{ marginBottom: 16 }}
            loadingTip={talent.resume_url ? "正在读取简历原文并生成解读…" : "AI 正在生成解读，约需 5-15 秒…"}
            hint="点击「生成」，AI 会基于档案字段与简历原文给出亮点、风险点和录用建议，供你筛选时参考。"
            fetchOnMount={async () => {
              const r = await api.aiResumeInsightGet(talent.id);
              return (r?.data ? { ...r.data, _persisted: true } : null) as Record<string, unknown> | null;
            }}
            onGenerate={async () => {
              const text = await readResumeText(talent);
              return (await api.aiResumeInsight({
                talent_id: talent.id,
                text,
              })) as unknown as Record<string, unknown>;
            }}
            toText={(d) => insightToText(d as AiResumeInsight)}
            render={(d) => <AiInsightView data={d as AiResumeInsight} />}
          />

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
              /* 不要 <Link><Button/></Link>：<a> 内嵌 <button> 是非法 HTML，点击易被外层吞掉。 */
              <Link to="/tasks" className="btn-as-link">
                <CalendarOutlined /> 去待办日历
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
              <Empty description={termFor(profile, "尚未进入招聘看板")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
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

      {/* AI 沟通文案：邀约 / 婉拒 / 跟进，生成后由用户自行复制发送 */}
      <AiOutreachModal
        open={outreachOpen}
        talent={talent}
        pipelines={pipeline}
        onClose={() => setOutreachOpen(false)}
      />
    </div>
  );
}
