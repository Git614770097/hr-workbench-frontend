import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Card, Button, Input, Select, Upload, Space, Tag, message, Modal, Alert,
  Progress, Typography, Popconfirm, Table,
} from "antd";
import {
  InboxOutlined, ArrowLeftOutlined, ThunderboltOutlined, DatabaseOutlined,
  UserSwitchOutlined, TrophyOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import { VERDICT_COLORS } from "../types";
import type { MatchProfile, MatchResult, Talent } from "../types";
import { parseResumeToTalent, parseResumeFile, recordToData } from "../utils/resumeImport";
import type { ParsedTalent } from "../utils/resumeImport";
import MatchResultCard from "../components/MatchResultCard";
import TalentPickerModal from "../components/TalentPickerModal";
import AddToPipelineModal from "../components/AddToPipelineModal";

const { Dragger } = Upload;

/** 一份待比选的候选人 */
interface Candidate {
  key: string;
  fileName: string;
  file: File | null;
  text: string;
  talent: ParsedTalent;
  source: "file" | "library";
  talentId?: string;
}

// 库内人才 → 候选人字段：用库里已核对过的字段
function talentToParsed(t: Talent, key: string): ParsedTalent {
  return {
    key,
    name: t.name || "",
    phone: t.phone || "",
    email: t.email || "",
    age: t.age,
    gender: t.gender || "",
    education: t.education || "",
    school: t.school || "",
    current_company: t.current_company || "",
    current_title: t.current_title || "",
    years_experience: t.years_experience,
    city: t.city || "",
    skills: (t.skills || []).join(", "),
    status: t.status || "active",
    notes: t.notes || "",
    fileName: "人才库记录",
    file: null,
  };
}

// 没存简历原文时，用已录入字段拼一份"简历"给 AI 评判
function talentToText(t: Talent): string {
  const lines = [
    `姓名：${t.name}`,
    t.current_title ? `当前职位：${t.current_title}` : "",
    t.current_company ? `当前公司：${t.current_company}` : "",
    t.years_experience != null ? `工作经验：${t.years_experience} 年` : "",
    t.city ? `所在城市：${t.city}` : "",
    t.education ? `学历：${t.education}` : "",
    t.school ? `毕业院校：${t.school}` : "",
    t.skills?.length ? `技能：${t.skills.join("、")}` : "",
    t.industry ? `行业：${t.industry}` : "",
    t.expected_salary ? `期望薪资：${t.expected_salary}` : "",
    t.notes ? `备注：${t.notes}` : "",
  ].filter(Boolean);
  lines.push("");
  lines.push("（说明：该候选人来自人才库，未存简历原文，以上内容仅为系统中已录入的字段信息，信息量有限）");
  return lines.join("\n");
}

// 智能匹配：选一个职位画像（含分级）+ 候选人 → 按匹配度排序 + 理由
export default function Match() {
  const navigate = useNavigate();
  const location = useLocation();

  // ---- 画像 ----
  const [profiles, setProfiles] = useState<MatchProfile[]>([]);
  // 从画像列表点「去匹配」跳过来时，直接用路由 state 初始化选中的画像 id
  const [profileId, setProfileId] = useState<string | undefined>(
    () => (location.state as { profileId?: string } | null)?.profileId
  );
  // ⚠️ profile 必须由 profiles 派生，不能另存一份 state：
  // 路由跳转进来时 profiles 还没加载完，find 不到就会把 profile 置为 null，
  // 而 Select 仍然显示「已选中」→ 用户以为选好了，点「开始匹配」却被拦下（表现为点了没反应）。
  const profile = useMemo(
    () => profiles.find((p) => p.id === profileId) ?? null,
    [profiles, profileId]
  );

  // ---- 候选人 ----
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [parsing, setParsing] = useState(false);
  const pendingFilesRef = useRef<File[]>([]);
  const keySeq = useRef(0);
  const nextKey = () => `cand-${keySeq.current++}`;
  const [pickerOpen, setPickerOpen] = useState(false);

  // ---- 匹配 ----
  const [results, setResults] = useState<Record<string, MatchResult>>({});
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: "" });
  const [stale, setStale] = useState(false);

  // ---- 落地 ----
  const [importingKey, setImportingKey] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Record<string, string>>({});
  const [pipelineTalentId, setPipelineTalentId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Candidate | null>(null);

  const loadProfiles = async () => {
    try {
      setProfiles(await api.getMatchProfiles());
    } catch {
      // 画像列表拉取失败不影响使用
    }
  };

  useEffect(() => {
    loadProfiles();
  }, []);

  const handleSelectProfile = (id?: string) => setProfileId(id);

  // ---- 上传并解析简历 ----
  const handleFiles = async (files: File[]) => {
    setParsing(true);
    const added: Candidate[] = [];
    try {
      for (const file of files) {
        const { talent, text } = await parseResumeToTalent(file, nextKey());
        added.push({ key: talent.key, fileName: file.name, file, text, talent, source: "file" });
      }
      setCandidates((prev) => [...prev, ...added]);
      const missing = added.filter((c) => !c.talent.name).length;
      if (missing > 0) {
        message.warning(`已解析 ${added.length} 份，其中 ${missing} 份未识别出姓名，可在结果卡片里查看原文确认`);
      } else {
        message.success(`已解析 ${added.length} 份简历`);
      }
      setStale(true);
    } catch (err) {
      message.error((err as Error).message);
    }
    setParsing(false);
  };

  const handleBeforeUpload = (file: File) => {
    // ⚠️ 不能用 Upload 的 accept 属性来过滤：拖拽时不符合 accept 的文件会被 rc-upload
    // 静默丢弃（不报错、不解析），用户以为上传成功了，但候选人列表始终为空，
    // 于是点「开始匹配」毫无反应。所以这里自己校验并给出明确提示。
    const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
    if (ext !== "pdf" && ext !== "docx") {
      message.error(`「${file.name}」格式不支持，请上传 .pdf 或 .docx（.doc 请先另存为 .docx）`);
      return false;
    }
    if (file.size > 20 * 1024 * 1024) {
      message.error(`「${file.name}」超过 20MB，请压缩后再上传`);
      return false;
    }
    pendingFilesRef.current.push(file);
    setTimeout(() => {
      if (pendingFilesRef.current.length === 0) return;
      const files = pendingFilesRef.current;
      pendingFilesRef.current = [];
      handleFiles(files);
    }, 0);
    return false;
  };

  const addFromLibrary = async (rows: Talent[]) => {
    setPickerOpen(false);
    setParsing(true);
    const added: Candidate[] = [];
    let weakCount = 0;
    try {
      for (const t of rows) {
        let text = "";
        try {
          const f = await api.fetchResumeFile(t.id);
          if (f?.blob) {
            const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] || (f.blob.type.includes("pdf") ? "pdf" : "docx")).toLowerCase();
            const file = new File([f.blob], `resume.${ext}`);
            text = await parseResumeFile(file);
          }
        } catch {
          // 读取或解析失败不中断：退化为字段文本
        }
        if (text.trim().length < 10) {
          text = talentToText(t);
          weakCount++;
        }
        const key = `lib-${t.id}`;
        added.push({
          key,
          fileName: t.name,
          file: null,
          text,
          talent: talentToParsed(t, key),
          source: "library",
          talentId: t.id,
        });
      }
      setCandidates((prev) => [...prev, ...added]);
      setSavedIds((prev) => {
        const next = { ...prev };
        for (const c of added) next[c.key] = c.talentId!;
        return next;
      });
      setStale(true);
      if (weakCount > 0) {
        message.warning(`已加入 ${added.length} 位，其中 ${weakCount} 位没存简历原文，只能按已录入字段比对，评分仅供参考`);
      } else {
        message.success(`已加入 ${added.length} 位人选`);
      }
    } catch (err) {
      message.error((err as Error).message);
    }
    setParsing(false);
  };

  const removeCandidate = (key: string) => {
    setCandidates((prev) => prev.filter((c) => c.key !== key));
    setResults((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setSavedIds((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  // ---- 逐份评分（串行 + 进度）----
  const handleMatch = async () => {
    if (!profile) {
      message.warning("请先选择一个画像（没有可在「人才画像」菜单里新建）");
      return;
    }
    if (candidates.length === 0) {
      message.warning("请先添加候选人：上传简历，或点「从人才库添加」");
      return;
    }

    setRunning(true);
    setResults({});
    setStale(false);
    const next: Record<string, MatchResult> = {};
    for (let i = 0; i < candidates.length; i++) {
      const cd = candidates[i];
      setProgress({ done: i, total: candidates.length, current: cd.talent.name || cd.fileName });
      try {
        next[cd.key] = await api.scoreCandidate(profile, {
          text: cd.text,
          parsed: {
            name: cd.talent.name,
            education: cd.talent.education,
            years_experience: cd.talent.years_experience,
            city: cd.talent.city,
            current_title: cd.talent.current_title,
            current_company: cd.talent.current_company,
            skills: cd.talent.skills ? cd.talent.skills.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [],
          },
        });
        setResults({ ...next });
      } catch (err) {
        message.error(`「${cd.talent.name || cd.fileName}」评估失败：${(err as Error).message}`);
      }
    }
    setProgress({ done: candidates.length, total: candidates.length, current: "" });
    setRunning(false);
    message.success(`匹配完成，共 ${Object.keys(next).length} 份`);
  };

  // ---- 录入人才库 ----
  const handleImport = async (cd: Candidate) => {
    if (!cd.talent.name.trim()) {
      message.error("这份简历没识别出姓名，请先到人才库「导入」里逐份核对后录入");
      return;
    }
    setImportingKey(cd.key);
    try {
      const res = await api.importTalents([recordToData(cd.talent)]);
      const created = res.items?.[0];
      if (!created) throw new Error("入库返回异常");
      if (cd.file) {
        try {
          await api.uploadResume(created.id, cd.file);
        } catch {
          message.warning("简历文件保存失败，可稍后在人才详情页重新上传");
        }
      }
      setSavedIds((prev) => ({ ...prev, [cd.key]: created.id }));
      message.success(`「${cd.talent.name}」已录入人才库`);
    } catch (err) {
      message.error(`录入失败：${(err as Error).message}`);
    }
    setImportingKey(null);
  };

  const handleAddToPipeline = (cd: Candidate) => {
    const id = savedIds[cd.key];
    if (!id) {
      message.info("请先「录入人才库」，再加入招聘流程");
      return;
    }
    setPipelineTalentId(id);
  };

  const ranked = candidates
    .filter((c) => results[c.key])
    .sort((a, b) => results[b.key].score - results[a.key].score);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate("/talents")}>返回人才库</Button>
        <Typography.Title level={4} style={{ margin: 0 }}>智能匹配</Typography.Title>
        <Typography.Text type="secondary">
          选一份职位画像 + 候选人 → 按匹配度排序并给出理由
        </Typography.Text>
      </div>

      {/* ① 选择画像 */}
      <Card title="① 选择画像" size="small" style={{ marginBottom: 12 }}>
        <Space wrap>
          <Select
            style={{ width: 360 }}
            placeholder="选用一个职位画像"
            value={profileId}
            onChange={handleSelectProfile}
            allowClear
            options={profiles.map((p) => ({ label: p.job_title || p.name, value: p.id! }))}
          />
          <Button icon={<UserSwitchOutlined />} onClick={() => navigate("/profiles")}>管理画像</Button>
        </Space>
        {profile && (
          <Typography.Paragraph type="secondary" style={{ margin: "8px 0 0", fontSize: 13 }}>
            {[
              profile.job_title && `职位 ${profile.job_title}`,
              profile.city && `城市 ${profile.city}`,
              profile.education && `学历 ${profile.education}`,
              profile.jd_raw ? "已填招聘需求" : "无招聘需求",
            ].filter(Boolean).join(" · ")}
          </Typography.Paragraph>
        )}
      </Card>

      {/* ② 候选人 */}
      <Card
        title={`② 候选人（${candidates.length} 位）`}
        size="small"
        style={{ marginBottom: 12 }}
        extra={
          <Button icon={<DatabaseOutlined />} onClick={() => setPickerOpen(true)}>
            从人才库添加
          </Button>
        }
      >
        <Dragger
          multiple
          showUploadList={false}
          disabled={parsing}
          beforeUpload={handleBeforeUpload}
        >
          <p className="ant-upload-drag-icon"><InboxOutlined /></p>
          <p className="ant-upload-text">点击或拖拽简历文件到此处</p>
          <p className="ant-upload-hint">
            支持 .pdf、.docx（单份 ≤ 20MB），可一次上传多份；已有的人选从右上角「从人才库添加」
          </p>
        </Dragger>

        {parsing && <Alert message="简历解析中…" type="info" showIcon style={{ marginTop: 12 }} />}

        {candidates.length > 0 && (
          <Table
            style={{ marginTop: 12 }}
            size="small"
            rowKey="key"
            pagination={false}
            dataSource={candidates}
            columns={[
              {
                title: "来源",
                dataIndex: "fileName",
                ellipsis: true,
                render: (v: string, r: Candidate) => (
                  <Space size={6}>
                    <span>{v}</span>
                    {r.source === "library" ? <Tag color="blue">人才库</Tag> : <Tag>新简历</Tag>}
                  </Space>
                ),
              },
              {
                title: "姓名",
                render: (_, r) => r.talent.name || <span style={{ color: "#c2410c" }}>未识别</span>,
                width: 100,
              },
              { title: "当前职位", render: (_, r) => r.talent.current_title || "-", width: 160, ellipsis: true },
              {
                title: "年限",
                render: (_, r) => (r.talent.years_experience != null ? `${r.talent.years_experience} 年` : "-"),
                width: 80,
              },
              { title: "城市", render: (_, r) => r.talent.city || "-", width: 90 },
              {
                title: "解析",
                render: (_, r: Candidate) =>
                  r.source === "library"
                    ? <Tag color="cyan">已录入</Tag>
                    : (r.talent._ai ? <Tag color="blue">AI</Tag> : <Tag>本地规则</Tag>),
                width: 90,
              },
              {
                title: "操作",
                render: (_, r) => (
                  <Popconfirm title="移除这份简历？" okText="移除" cancelText="取消" onConfirm={() => removeCandidate(r.key)}>
                    <Button type="link" size="small" danger>移除</Button>
                  </Popconfirm>
                ),
                width: 80,
              },
            ]}
          />
        )}
      </Card>

      {/* ③ 匹配结果 */}
      <Card
        title="③ 匹配结果"
        size="small"
        extra={
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={running}
            disabled={running}
            onClick={handleMatch}
          >
            开始匹配
          </Button>
        }
      >
        {/* 缺条件时把原因直接摆在页面上：原来按钮被 disabled（候选人为空时）且只在点击时弹 message，
            用户看不出问题，表现就是「点了没反应」 */}
        {!running && (!profile || candidates.length === 0) && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={
              !profile && candidates.length === 0
                ? "还差两步：先在「① 选择画像」里选一个职位画像，再在「② 候选人」里上传简历或从人才库添加"
                : !profile
                  ? "还没选画像：请先在「① 选择画像」里选中本次要比对的职位画像"
                  : "还没有候选人：请在「② 候选人」里上传简历，或点右上角「从人才库添加」"
            }
          />
        )}

        {running && (
          <Progress
            percent={progress.total ? Math.round((progress.done / progress.total) * 100) : 0}
            format={() => `正在评估 ${progress.done + 1}/${progress.total}${progress.current ? `：${progress.current}` : ""}`}
            style={{ marginBottom: 12 }}
          />
        )}

        {stale && Object.keys(results).length > 0 && (
          <Alert
            message="画像或候选人有变动，下面的结果是上一次匹配产生的，建议重新匹配"
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
          />
        )}

        {ranked.length === 0 && !running && profile && candidates.length > 0 && (
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            点右上角「开始匹配」开始评估，结果会按匹配度从高到低排列。
          </Typography.Paragraph>
        )}

        {/* 结果概览：整体结论一眼可见（各档人数 + 最佳人选） */}
        {ranked.length > 0 && (
          <div
            style={{
              display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
              padding: "10px 14px", marginBottom: 12,
              background: "linear-gradient(90deg,#fffbeb 0%,#fafafa 60%)",
              border: "1px solid #f0f0f0", borderRadius: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
              <span style={{ fontSize: 13, color: "#6b7280" }}>共评估</span>
              <span style={{ fontSize: 20, fontWeight: 700, color: "#111827" }}>{ranked.length}</span>
              <span style={{ fontSize: 13, color: "#6b7280" }}>位</span>
            </div>
            <div style={{ width: 1, height: 22, background: "#e5e7eb" }} />
            <Space size={[6, 6]} wrap>
              {["强烈推荐", "推荐", "可考虑", "不建议"].map((v) => {
                const n = ranked.filter((c) => results[c.key].verdict === v).length;
                if (!n) return null;
                return (
                  <Tag key={v} color={VERDICT_COLORS[v]} style={{ marginInlineEnd: 0 }}>
                    {v} {n}
                  </Tag>
                );
              })}
            </Space>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
              <TrophyOutlined style={{ color: "#f59e0b" }} />
              <span style={{ fontSize: 13, color: "#6b7280" }}>最佳人选</span>
              <span style={{ fontSize: 14, fontWeight: 600, color: "#111827" }}>
                {ranked[0].talent.name || ranked[0].fileName}
              </span>
              <span
                style={{
                  fontSize: 16, fontWeight: 700,
                  color: VERDICT_COLORS[results[ranked[0].key].verdict] || "#3b82f6",
                }}
              >
                {results[ranked[0].key].score} 分
              </span>
            </div>
          </div>
        )}

        {ranked.map((cd, i) => (
          <MatchResultCard
            key={cd.key}
            rank={i + 1}
            talent={cd.talent}
            result={results[cd.key]}
            savedId={savedIds[cd.key] || null}
            importing={importingKey === cd.key}
            fromLibrary={cd.source === "library"}
            onViewText={() => setViewing(cd)}
            onImport={() => handleImport(cd)}
            onAddToPipeline={() => handleAddToPipeline(cd)}
          />
        ))}
      </Card>

      {/* 比对依据 */}
      <Modal
        title={`${viewing?.source === "library" ? "比对依据" : "简历原文"} — ${viewing?.talent.name || viewing?.fileName || ""}`}
        open={!!viewing}
        onCancel={() => setViewing(null)}
        width={800}
        footer={null}
        getContainer={() => document.body}
        zIndex={1050}
      >
        <pre style={{ whiteSpace: "pre-wrap", maxHeight: "60vh", overflow: "auto", fontSize: 13, margin: 0 }}>
          {viewing?.text}
        </pre>
      </Modal>

      {pickerOpen && (
        <TalentPickerModal
          open
          excludeIds={candidates.filter((c) => c.talentId).map((c) => c.talentId!)}
          onCancel={() => setPickerOpen(false)}
          onOk={addFromLibrary}
        />
      )}

      <AddToPipelineModal
        open={!!pipelineTalentId}
        presetTalentId={pipelineTalentId}
        onClose={() => setPipelineTalentId(null)}
        onSuccess={() => message.success("已加入招聘流程")}
      />
    </div>
  );
}
