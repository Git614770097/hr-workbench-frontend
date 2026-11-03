import { useState, useMemo } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  Card, Descriptions, Tag, Button, Space, Typography, Empty, Spin, Tooltip, Select,
  message, Popconfirm, Upload, Checkbox, Timeline, Tabs, Collapse,
} from "antd";
import {
  EditOutlined, DeleteOutlined, ArrowLeftOutlined, FilePdfOutlined, UploadOutlined,
  CopyOutlined, CalendarOutlined, RobotOutlined, SolutionOutlined,
  FileImageOutlined, FileOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import { useAsyncData } from "../hooks/useAsyncData";
import type { Task, TalentDetailData, TalentStageLog, User, AiResumeInsight, TalentFile } from "../types";
import { STATUS_LABELS, STATUS_COLORS, STAGE_META, PRIORITY_LABELS, PRIORITY_COLORS } from "../types";
import TalentFormModal from "../components/TalentFormModal";
import ResumePreviewModal from "../components/ResumePreviewModal";
import AiResultCard from "../components/AiResultCard";
import AiInsightView, { insightToText } from "../components/AiInsightView";
import AiOutreachModal from "../components/AiOutreachModal";
import { copyText } from "../utils/clipboard";
import { parseResumeFile } from "../utils/resumeImport";

/** 后端 datetime('now') 是 UTC 且无时区后缀，解析时补 T+Z（全站统一做法） */
function fmtUtc(s: string): Date {
  return new Date(s.includes("T") || s.includes("Z") ? s : s.replace(" ", "T") + "Z");
}

/** 附件类型的中文名 */
const FILE_KIND_LABELS: Record<string, string> = {
  portfolio: "作品集",
  certificate: "证书",
  other: "其他",
};

/** 字节数 → 人读的大小。附件上限 10MB，所以不用处理 GB。 */
function fmtFileSize(n: number | null): string {
  const size = n || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** 附件图标按 MIME 分色：pdf 红、图片绿、其余蓝——比一律用同一个图标更容易扫 */
function fileIcon(mime: string | null) {
  if (mime === "application/pdf") return <FilePdfOutlined style={{ color: "#ff4d4f", fontSize: 18 }} />;
  if ((mime || "").startsWith("image/")) return <FileImageOutlined style={{ color: "#16a34a", fontSize: 18 }} />;
  return <FileOutlined style={{ color: "#2563eb", fontSize: 18 }} />;
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
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  // 附件上传：kind 由用户先选（作品集/证书/其他），默认「其他」
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadKind, setUploadKind] = useState<"portfolio" | "certificate" | "other">("other");
  const [outreachOpen, setOutreachOpen] = useState(false);

  const currentUser: User | null = (() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  })();
  const isAdmin = currentUser?.role === "admin";
  // 页内入口按菜单权限显示（与侧栏一致）：没有的权限不摆按钮，点了也是被 RequirePerm 拦
  const canP = (p: string) => isAdmin || (currentUser?.permissions || []).includes(p);

  // 详情页最容易撞上「陈旧响应」：从人才 A 快速切到 B 时，A 的响应若后到，
  // 会把 A 的数据写到 B 的页面上（地址是 B、内容是 A）。useAsyncData 只让最后一次
  // 发起的请求写 state，其余丢弃。fetchData 现在是稳定的 reload，可直接当回调传。
  const { data: talent, loading, reload: fetchData } = useAsyncData(
    () => api.getTalent(id!),
    [id],
    { enabled: !!id }
  );

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
      void fetchData();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleDeleteTalent = async () => {
    if (!talent) return;
    try {
      await api.deleteTalent(talent.id);
      message.success("已删除");
      void navigate("/talents");
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
      void fetchData();
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
      void fetchData();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  // ---- 附件（作品集 / 证书 / 其他）：与简历主文件分开，可多份 ----
  const { data: filesData, reload: reloadFiles } = useAsyncData(
    () => api.getTalentFiles(id!),
    [id],
    { enabled: !!id, keepOnError: true }
  );
  const files = filesData?.items || [];

  const handleUploadFile = async (file: File) => {
    if (!talent) return false;
    // 前端先拦一道：10MB 是后端硬限制，与其等上传完再报错，不如本地就挡住。
    // 弱网下传一个 30MB 的文件要几分钟，最后才告诉用户「太大」是不可接受的。
    if (file.size > 10 * 1024 * 1024) {
      message.error(`「${file.name}」有 ${(file.size / 1024 / 1024).toFixed(1)}MB，单个附件最大 10MB`);
      return false;
    }
    setUploadingFile(true);
    try {
      await api.uploadTalentFile(talent.id, file, uploadKind);
      message.success("附件已上传");
      await reloadFiles();
    } catch (err) {
      message.error((err as Error).message);
    }
    setUploadingFile(false);
    return false;
  };

  const handleDeleteFile = async (fileId: string, name: string) => {
    if (!talent) return;
    try {
      await api.deleteTalentFile(talent.id, fileId);
      message.success(`已删除「${name}」`);
      await reloadFiles();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  if (loading) return <div style={{ textAlign: "center", padding: "3rem" }}><Spin size="large" /></div>;
  if (!talent) return <Empty description={"人才不存在"} />;

  const tasks = talent.tasks || [];
  const pipeline = talent.pipeline || [];

  // 最近更新的那条投递：摘要条与「当前状态」卡都要用它。
  // 一个候选人可能投了多个岗位，「当前在哪」只能有一个答案——取最近动过的那个。
  const latestPipeline = pipeline.length
    ? pipeline.slice().sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))[0]
    : null;
  const latestStageMeta = latestPipeline ? STAGE_META[latestPipeline.stage] : null;
  // 下一步该做什么：未完成待办里最早到期的那条（没到期日的排最后）
  const openTasks = tasks.filter((t) => t.status !== "done");
  // 待办排序：未完成在前，已完成沉底；未完成的按到期日升序——
  // 这样列表最上面那条就是「下一步该做什么」，不用再单独标一次。
  const sortedTasks = tasks.slice().sort((a, b) => {
    const ad = a.status === "done" ? 1 : 0;
    const bd = b.status === "done" ? 1 : 0;
    if (ad !== bd) return ad - bd;
    return (a.due_date || "9999-99-99").localeCompare(b.due_date || "9999-99-99");
  });

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
          {/* 入职办理：带本人才预选跳转，不用到目标页再找一遍人 */}
          {canP("pipeline") && (
            <Link to={`/onboarding?talent_id=${talent.id}`}>
              <Button icon={<SolutionOutlined />}>入职办理</Button>
            </Link>
          )}
          <Popconfirm title="确认删除？所有关联数据将被清除。" onConfirm={handleDeleteTalent}>
            <Button danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      </div>

      {/* 摘要条：把「最该先看的几项」提到首屏。
          之前基本信息 17 项平铺在下面的卡里，手机号排到第 16 位、邮箱第 17 位——
          而 HR 打开详情页最先确认的就是「怎么联系他」和「现在什么情况」。
          这里只放 6 项，其余仍在下方卡片里。 */}
      <div className="talent-summary">
        <span className="talent-summary-item">
          <span className="talent-summary-label">电话</span>
          {talent.phone ? <CopyBtn text={talent.phone} label="电话" /> : <span className="talent-summary-empty">-</span>}
        </span>
        <span className="talent-summary-item">
          <span className="talent-summary-label">当前</span>
          {talent.current_company || talent.current_title
            ? [talent.current_company, talent.current_title].filter(Boolean).join(" · ")
            : <span className="talent-summary-empty">-</span>}
        </span>
        <span className="talent-summary-item">
          <span className="talent-summary-label">期望薪资</span>
          {talent.expected_salary || <span className="talent-summary-empty">-</span>}
        </span>
        <span className="talent-summary-item">
          <span className="talent-summary-label">期望城市</span>
          {talent.expected_city || <span className="talent-summary-empty">-</span>}
        </span>
        <span className="talent-summary-item">
          <span className="talent-summary-label">当前阶段</span>
          {latestPipeline
            ? <Tag color={latestStageMeta?.color} style={{ marginInlineEnd: 0 }}>{latestStageMeta?.label || latestPipeline.stage}</Tag>
            : <span className="talent-summary-empty">未进流程</span>}
        </span>
        <span className="talent-summary-item">
          <span className="talent-summary-label">评分</span>
          {latestPipeline?.rating
            ? <span style={{ color: "#faad14" }}>{"★".repeat(latestPipeline.rating)}</span>
            : <span className="talent-summary-empty">-</span>}
        </span>
      </div>

      <div className="detail-grid">
        <div>
          <Card title="基本信息" style={{ marginBottom: 16 }}>
            {/* 按语义分三组：身份 / 求职意向 / 履历。
                之前 17 项平铺在一个 Descriptions 里，手机号排到第 16 位、邮箱第 17 位，
                而这两个恰恰是筛选候选人时最先看的。分组后主次也清楚了。 */}
            <div className="info-group">
              <div className="info-group-title">身份</div>
              <Descriptions column={2} size="small">
                <Descriptions.Item label="电话">
                  {talent.phone ? (
                    <Space size={6}>{talent.phone}<CopyBtn text={talent.phone} label="电话" /></Space>
                  ) : "-"}
                </Descriptions.Item>
                <Descriptions.Item label="邮箱">
                  {talent.email ? (
                    <Space size={6}>{talent.email}<CopyBtn text={talent.email} label="邮箱" /></Space>
                  ) : "-"}
                </Descriptions.Item>
                <Descriptions.Item label="年龄">{talent.age != null ? `${talent.age}岁` : "-"}</Descriptions.Item>
                <Descriptions.Item label="出生年月">
                  {talent.birth_date ? (
                    <Space size={6}>
                      {/* 精度决定显示到月还是年：只写了年份的不能假装知道月份 */}
                      {talent.birth_date_precision === "exact" || talent.birth_date_precision === "month"
                        ? talent.birth_date.slice(0, 7)
                        : talent.birth_date.slice(0, 4)}
                      {talent.birth_date_precision === "estimated" && (
                        <Tooltip title="按录入时的年龄反推的出生年份，误差最多 1 岁。补上实际出生年月后会自动精确，年龄也会跟着实时算">
                          <Tag color="orange" style={{ marginInlineEnd: 0 }}>推算</Tag>
                        </Tooltip>
                      )}
                    </Space>
                  ) : "-"}
                </Descriptions.Item>
                <Descriptions.Item label="性别">{talent.gender || "-"}</Descriptions.Item>
              </Descriptions>
            </div>

            <div className="info-group">
              <div className="info-group-title">求职意向</div>
              <Descriptions column={2} size="small">
                <Descriptions.Item label="期望薪资">{talent.expected_salary || "-"}</Descriptions.Item>
                <Descriptions.Item label="期望城市">{talent.expected_city || "-"}</Descriptions.Item>
                <Descriptions.Item label="当前职位">{talent.current_title || "-"}</Descriptions.Item>
                <Descriptions.Item label="当前公司">{talent.current_company || "-"}</Descriptions.Item>
              </Descriptions>
            </div>

            <div className="info-group">
              <div className="info-group-title">履历</div>
              <Descriptions column={2} size="small">
                <Descriptions.Item label="学历">{talent.education || "-"}</Descriptions.Item>
                <Descriptions.Item label="毕业院校">{talent.school || "-"}</Descriptions.Item>
                <Descriptions.Item label="工作年限">{talent.years_experience != null ? `${talent.years_experience}年` : "-"}</Descriptions.Item>
                <Descriptions.Item label="所在城市">{talent.city || "-"}</Descriptions.Item>
                <Descriptions.Item label="行业">{talent.industry || "-"}</Descriptions.Item>
              </Descriptions>
            </div>

            {/* 低频字段收进折叠：来源/入职日期/创建人平时不看，但要看时不能找不到 */}
            <Collapse
              ghost
              size="small"
              items={[{
                key: "more",
                label: <span style={{ fontSize: 13, color: "#8c8c8c" }}>更多信息</span>,
                children: (
                  <Descriptions column={2} size="small">
                    <Descriptions.Item label="来源渠道">{talent.source || "-"}</Descriptions.Item>
                    <Descriptions.Item label="入职日期">{talent.hire_date || "-"}</Descriptions.Item>
                    {isAdmin && <Descriptions.Item label="创建人">{talent.owner_name || "-"}</Descriptions.Item>}
                  </Descriptions>
                ),
              }]}
            />
          </Card>

          {/* 简历原文与 AI 解读合并成一张卡、两个 Tab：
              它们本来就是同一份材料的两面，分成两张卡既多占版面，
              又逼着用户来回滚动对照。 */}
          <Card title="简历与 AI 解读" style={{ marginBottom: 16 }}>
            <Tabs
              defaultActiveKey="text"
              items={[
                {
                  key: "text",
                  label: "简历原文",
                  children: talent.resume_text ? (
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
                  ) : (
                    <Empty description="暂无简历原文（可上传简历文件，或手动粘贴）" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  ),
                },
                {
                  key: "ai",
                  label: "AI 解读",
                  children: (
                    /* bare：去掉 Card 外框，避免卡片套卡片 */
                    <AiResultCard
                      bare
                      title="AI 简历解读"
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
                  ),
                },
              ]}
            />
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
          {/* ④ 当前状态：详情页的核心价值是「推进这一个人」，不是「读档案」。
              之前「待办」「投递进程」排在右栏第 3、4 位，而右栏整体又在首屏之外——
              打开页面第一眼看到的只有年龄/性别。现在把它们提到最前面。 */}
          <Card
            title="当前状态"
            style={{ marginBottom: 16 }}
            extra={
              /* 不要 <Link><Button/></Link>：<a> 内嵌 <button> 是非法 HTML，点击易被外层吞掉。 */
              <Link to="/tasks" className="btn-as-link">
                <CalendarOutlined /> 去待办日历
              </Link>
            }
          >
            <Descriptions column={2} size="small">
              <Descriptions.Item label="当前阶段">
                {latestPipeline ? (
                  <Tag color={latestStageMeta?.color} style={{ marginInlineEnd: 0 }}>
                    {latestStageMeta?.label || latestPipeline.stage}
                  </Tag>
                ) : <span style={{ color: "#9ca3af" }}>尚未进入招聘看板</span>}
              </Descriptions.Item>
              <Descriptions.Item label="所在岗位">
                {latestPipeline ? latestPipeline.job_title : "-"}
              </Descriptions.Item>
              <Descriptions.Item label="评分">
                {latestPipeline?.rating
                  ? <span style={{ color: "#faad14" }}>{"★".repeat(latestPipeline.rating)}</span>
                  : "-"}
              </Descriptions.Item>
              <Descriptions.Item label="来源渠道">{talent.source || "-"}</Descriptions.Item>
            </Descriptions>

            {/* 待办合并进这张卡：之前「当前状态」里显示一条「下一步」、
                下面「相关待办」卡又显示一遍完整列表，同一条待办出现两次。
                现在只留这一处，排序上未完成在前、最早到期的在最上面——最上面那条就是下一步。 */}
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px dashed #f0f0f0" }}>
              <div style={{ fontSize: 12, color: "#8c8c8c", marginBottom: 6 }}>
                待办{openTasks.length > 0 ? `（${openTasks.length} 项未完成）` : ""}
              </div>
              {tasks.length === 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>暂无关联待办</Typography.Text>
              ) : (
                <div>
                  {sortedTasks.map((t) => {
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
            </div>
          </Card>

          {/* ⑤ 材料：简历文件与附件合并成一张卡、两个 Tab。
              两者都是「这个人的材料」，之前拆成两张卡，右栏就被撑长了。
              Tab 分开仍然保留了「上传附件不会覆盖简历」的语义（各自独立面板）。 */}
          <Card title="材料" style={{ marginBottom: 16 }}>
            <Tabs
              defaultActiveKey="resume"
              items={[
                {
                  key: "resume",
                  label: "简历文件",
                  children: (
                    <div>
                      {talent.resume_url ? (
                        <div>
                          <Space style={{ marginBottom: 12 }}>
                            <FilePdfOutlined style={{ fontSize: 20, color: "#ff4d4f" }} />
                            <Typography.Text>{talent.resume_url.split("/").pop()}</Typography.Text>
                          </Space>
                          <Space wrap>
                            <Button type="primary" onClick={() => setPreviewOpen(true)}>预览简历</Button>
                            <Popconfirm title="确认删除简历文件？人才记录会保留。" onConfirm={handleDeleteResume}>
                              <Button danger icon={<DeleteOutlined />}>删除简历</Button>
                            </Popconfirm>
                            {/* 上传放在已有文件旁边而不是最上面：否则会让人以为必须先上传 */}
                            <Upload accept=".pdf,.docx" showUploadList={false} beforeUpload={handleUploadResume} disabled={uploading}>
                              <Button icon={<UploadOutlined />} loading={uploading}>替换简历</Button>
                            </Upload>
                          </Space>
                        </div>
                      ) : (
                        <div>
                          <Empty description="暂无简历文件，请上传" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                          <Upload accept=".pdf,.docx" showUploadList={false} beforeUpload={handleUploadResume} disabled={uploading}>
                            <Button icon={<UploadOutlined />} loading={uploading}>上传简历</Button>
                          </Upload>
                        </div>
                      )}
                    </div>
                  ),
                },
                {
                  key: "files",
                  label: `附件${files.length > 0 ? `（${files.length}）` : ""}`,
                  children: (
                    <div>
                      {/* 附件类型（作品集/证书/其他）要先选再传，否则后端不知道归到哪一类 */}
                      <Space size={8} style={{ marginBottom: 12 }}>
                        <Select
                          size="small"
                          value={uploadKind}
                          onChange={setUploadKind}
                          style={{ width: 84 }}
                          options={[
                            { label: "作品集", value: "portfolio" },
                            { label: "证书", value: "certificate" },
                            { label: "其他", value: "other" },
                          ]}
                        />
                        <Upload showUploadList={false} beforeUpload={handleUploadFile} disabled={uploadingFile}>
                          <Button size="small" icon={<UploadOutlined />} loading={uploadingFile}>上传附件</Button>
                        </Upload>
                      </Space>
                      {files.length === 0 ? (
                        <Empty description="暂无附件（作品集、证书等，单个 10MB 以内）" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                      ) : (
                        <Space direction="vertical" style={{ width: "100%" }} size={10}>
                          {files.map((f) => (
                            <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              {fileIcon(f.mime)}
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <Typography.Link
                                  href={api.getTalentFileUrl(talent.id, f.id)}
                                  target="_blank"
                                  rel="noreferrer"
                                  style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                >
                                  {f.name}
                                </Typography.Link>
                                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                  {FILE_KIND_LABELS[f.kind] || "其他"} · {fmtFileSize(f.size)} · {(f.created_at || "").slice(0, 10)}
                                </Typography.Text>
                              </div>
                              <Space size={2}>
                                <Button
                                  size="small"
                                  type="link"
                                  href={api.getTalentFileUrl(talent.id, f.id, true)}
                                >
                                  下载
                                </Button>
                                <Popconfirm title={`确认删除「${f.name}」？`} onConfirm={() => handleDeleteFile(f.id, f.name)}>
                                  <Button size="small" type="link" danger>删除</Button>
                                </Popconfirm>
                              </Space>
                            </div>
                          ))}
                        </Space>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          </Card>

          {/* 投递进程：每个岗位一条，含当前阶段与流转时间线 */}
          <Card title={`投递进程${pipeline.length > 0 ? `（${pipeline.length}）` : ""}`}>
            {pipeline.length === 0 ? (
              <Empty description={"尚未进入招聘看板"} image={Empty.PRESENTED_IMAGE_SIMPLE} />
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
