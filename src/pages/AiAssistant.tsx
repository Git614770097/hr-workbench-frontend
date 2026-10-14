import { useEffect, useMemo, useState } from "react";
import {
  Alert, Button, Card, Col, Empty, Input, Row, Select, Space, Tabs, Tag, Typography, message,
} from "antd";
import {
  ArrowLeftOutlined, FileTextOutlined, RobotOutlined,
  SearchOutlined, TeamOutlined, WarningOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import AiResultCard from "../components/AiResultCard";
import type { AiOutreachScene, User } from "../types";
import { AI_OUTREACH_SCENE_LABELS } from "../types";
import { buildJobDiagnosisReport } from "../utils/jobReport";

// AI 助手：把系统里零散的 AI 能力集中成一个入口页。
//
// 为什么按「分组卡片 → 二级功能」两层，而不是一排平铺 Tab：
// 早期版本只有 3 个 Tab，看起来正好；把散在各业务页的 AI 能力聚合进来后会变成 9 个，
// 平铺 9 个 Tab 要横向滚动才能找全，越加越难用。改成四个语义分组后，
// 用户先想「我要干什么」（写材料/看人/推进/诊断），再选具体功能，认知负担恒定。
//
// 三条约定：
//   1) 页面本身受「工具中心」权限（tools）控制；页内每个功能再按其领域权限条件展示
//      —— 权限必须与后端 /api/ai/* 中间件的分流一致，否则用户会点到 403。
//   2) 所有产出都是草稿，必须用户手动复制后才使用，系统永不代发、永不写库。
//   3) AI 不可用时只提示、不阻塞，沿用全站统一护栏（配额/缓存/脱敏/降级）。
//
// ⚠️ 四个「依赖页面上下文」的能力故意不在这里：招聘复盘（要漏斗聚合数据）、
//    看板下一步建议（要某张卡片）、今日重点（要待办清单）、审批读卡（要具体审批单）。
//    硬搬过来要用户手动喂一堆参数，体验反而更差——它们留在各自业务页里。

/** 候选人选择器：按关键词搜索人才库（后端已做 owner 隔离，只能搜到有权限的人） */
function TalentSelect({ value, onChange }: { value?: string; onChange: (v?: string) => void }) {
  const [opts, setOpts] = useState<{ label: string; value: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const search = async (kw: string) => {
    setLoading(true);
    try {
      const res = await api.getTalents({ q: kw, page: 1, limit: 20 });
      setOpts(res.items.map((t) => ({
        value: t.id,
        label: `${t.name}${t.current_title ? ` · ${t.current_title}` : ""}${t.city ? ` · ${t.city}` : ""}`,
      })));
    } catch {
      setOpts([]);
    }
    setLoading(false);
  };
  useEffect(() => { search(""); }, []);
  return (
    <Select
      showSearch allowClear value={value} onChange={onChange} onSearch={search}
      filterOption={false} loading={loading}
      placeholder="搜索并选择候选人（姓名 / 公司 / 职位）"
      options={opts} style={{ width: "100%" }}
    />
  );
}

/** 目标岗位选择器（可选）：选中后 AI 会突出与该岗位的匹配点 / 按该岗位诊断 */
function JobSelect({
  value, onChange, placeholder = "目标岗位（可选，选中后 AI 会突出匹配点）",
}: { value?: string; onChange: (v?: string) => void; placeholder?: string }) {
  const [opts, setOpts] = useState<{ label: string; value: string }[]>([]);
  useEffect(() => {
    api.getJobOptions()
      .then((jobs) => setOpts(jobs.map((j) => ({ value: j.id, label: `${j.title}${j.department ? ` · ${j.department}` : ""}` }))))
      .catch(() => setOpts([]));
  }, []);
  return (
    <Select
      showSearch allowClear value={value} onChange={onChange} placeholder={placeholder}
      options={opts} style={{ width: "100%" }}
    />
  );
}

const SCENES = Object.keys(AI_OUTREACH_SCENE_LABELS) as AiOutreachScene[];

const pre: React.CSSProperties = {
  whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.7, fontSize: 13,
  margin: "4px 0 0", fontFamily: "inherit",
};
const line: React.CSSProperties = { lineHeight: 1.7, fontSize: 13 };

/** 分组定义：key/名称/说明/图标/配色。perm 决定整个分组对当前账号是否可见。 */
interface GroupDef {
  key: string;
  label: string;
  desc: string;
  icon: React.ReactNode;
  color: string;
  perm: string;
}

export default function AiAssistant() {
  const user: User | null = useMemo(() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  }, []);
  const isAdmin = user?.role === "admin";
  const perms = user?.permissions || [];
  const can = (p: string) => isAdmin || perms.includes(p);

  /** 进入某个分组（二级页）；null = 停在卡片总览 */
  const [group, setGroup] = useState<string | null>(null);

  // ---- 写材料 ----
  const [title, setTitle] = useState("");
  const [department, setDepartment] = useState("");
  const [city, setCity] = useState("");

  // ---- 看人：简历解读 / 简历优化 / 候选人评估 / 面试问题 共用候选人+岗位选择 ----
  const [pTalent, setPTalent] = useState<string | undefined>();
  const [pJob, setPJob] = useState<string | undefined>();

  // ---- 推进：跟进话术 ----
  const [oTalent, setOTalent] = useState<string | undefined>();
  const [oJob, setOJob] = useState<string | undefined>();
  const [scene, setScene] = useState<AiOutreachScene>("invite_wechat");

  // ---- 诊断：岗位诊断需选岗位 ----
  const [diagJob, setDiagJob] = useState<string | undefined>();

  const GROUPS: GroupDef[] = [
    { key: "write", label: "写材料", desc: "要产出一份文档给外部时用", icon: <FileTextOutlined />, color: "#4f46e5", perm: "jobs" },
    { key: "read", label: "看人", desc: "想搞懂一个候选人时用", icon: <SearchOutlined />, color: "#0ea5e9", perm: "talents" },
    { key: "push", label: "推进", desc: "正在推候选人时用", icon: <TeamOutlined />, color: "#10b981", perm: "talents" },
    { key: "diag", label: "诊断", desc: "想知道哪里卡住了时用", icon: <WarningOutlined />, color: "#d97706", perm: "talents" },
  ];
  // 分组 perm 只决定「组」是否出现；组内每个功能另有细粒度 perm（见下方 items 构造）
  const visibleGroups = GROUPS.filter((g) => can(g.perm));

  // ================= 一级：分组卡片总览 =================
  if (!group) {
    return (
      <div className="page-fill">
        <Card className="list-card" title={<Space size={6}><RobotOutlined /><span>AI 助手</span></Space>}>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 16 }}>
            按「你要做什么」选一类能力。所有产出均为 AI 生成的草稿，请核对后使用；系统不会自动发送或写入任何数据。
          </Typography.Paragraph>
          {visibleGroups.length > 0 ? (
            <Row gutter={[12, 12]}>
              {visibleGroups.map((g) => {
                const n = capabilityCount(g.key);
                return (
                  <Col xs={24} sm={12} xl={6} key={g.key}>
                    <button
                      type="button"
                      className="ai-group-card"
                      onClick={() => setGroup(g.key)}
                      data-onb-group={g.key}
                    >
                      <span className="ai-group-icon" style={{ background: `${g.color}14`, color: g.color }}>
                        {g.icon}
                      </span>
                      <span className="ai-group-name">
                        {g.label}
                        {n > 0 && <span className="ai-group-count">{n}</span>}
                      </span>
                      <span className="ai-group-desc">{g.desc}</span>
                    </button>
                  </Col>
                );
              })}
            </Row>
          ) : (
            <Alert
              type="info" showIcon
              message="当前账号暂无可用 AI 功能"
              description="AI 助手内的功能按权限展示：写材料需要「岗位管理」权限，看人 / 推进 / 诊断需要「人才库管理」权限。请联系管理员开通。"
            />
          )}
        </Card>
      </div>
    );
  }

  const current = visibleGroups.find((g) => g.key === group)!;

  /** 该分组下当前账号有权使用的功能条数（用于卡片上的角标） */
  function capabilityCount(key: string): number {
    if (key === "write") return can("jobs") ? 1 : 0;
    if (key === "read") return (can("talents") ? 2 : 0) + (can("interviews") ? 2 : 0);
    if (key === "push") return (can("talents") ? 1 : 0) + (can("pipeline") ? 1 : 0);
    if (key === "diag") return (can("jobs") ? 1 : 0) + (can("talents") ? 1 : 0);
    return 0;
  }

  // ================= 写材料 =================
  const jdPanel = (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Input placeholder="岗位名称（必填），如：高级前端工程师" value={title} onChange={(e) => setTitle(e.target.value)} allowClear />
      <Space.Compact style={{ width: "100%" }}>
        <Input placeholder="用人部门（可选）" value={department} onChange={(e) => setDepartment(e.target.value)} allowClear />
        <Input placeholder="工作城市（可选）" value={city} onChange={(e) => setCity(e.target.value)} allowClear />
      </Space.Compact>
      <AiResultCard
        title="岗位 JD 起草"
        onGenerate={async () => {
          if (!title.trim()) { message.warning("请先填写岗位名称"); return null; }
          return { ...(await api.aiJobDraft({ title: title.trim(), department: department.trim() || null, city: city.trim() || null })) };
        }}
        hint="点「生成」，AI 会基于岗位名称给出职责、要求与薪资建议草稿。"
        toText={(d) => [
          `【岗位职责】\n${d.description}`,
          `【任职要求】\n${d.requirements}`,
          d.salary_range ? `【薪资建议】${d.salary_range}` : "",
          d.education ? `【学历】${d.education}` : "",
          d.experience ? `【经验】${d.experience}` : "",
        ].filter(Boolean).join("\n\n")}
        render={(d) => (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            <div><Typography.Text strong>岗位职责</Typography.Text><pre style={pre}>{d.description || "—"}</pre></div>
            <div><Typography.Text strong>任职要求</Typography.Text><pre style={pre}>{d.requirements || "—"}</pre></div>
            <Space wrap size={8}>
              {d.salary_range ? <Tag color="blue">薪资建议：{d.salary_range}</Tag> : null}
              {d.education ? <Tag>学历：{d.education}</Tag> : null}
              {d.experience ? <Tag>经验：{d.experience}</Tag> : null}
            </Space>
          </Space>
        )}
      />
    </Space>
  );

  // ================= 看人 =================
  const insightPanel = (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
        AI 读完简历后给出亮点、风险点与岗位匹配度评分——用于快速判断「要不要约」。
      </Typography.Paragraph>
      <TalentSelect value={pTalent} onChange={setPTalent} />
      <JobSelect value={pJob} onChange={setPJob} />
      <AiResultCard
        key={`insight-${pTalent || ""}-${pJob || ""}`}
        title="简历解读"
        onGenerate={async () => {
          if (!pTalent) { message.warning("请先选择候选人"); return null; }
          return { ...(await api.aiResumeInsight({ talent_id: pTalent, job_id: pJob ?? null })) };
        }}
        hint="点「生成」，AI 输出亮点、风险与匹配度评分。"
        loadingTip="正在读取候选人信息与岗位要求…"
        toText={(d) => [
          d.highlights?.length ? `【亮点】\n${d.highlights.map((x: string) => `· ${x}`).join("\n")}` : "",
          d.risks?.length ? `【风险】\n${d.risks.map((x: string) => `· ${x}`).join("\n")}` : "",
          d.jd_fit ? `【岗位匹配度】${d.jd_fit.score}\n${d.jd_fit.reasons.map((x: string) => `· ${x}`).join("\n")}` : "",
          d.suggestion ? `【建议】${d.suggestion}` : "",
        ].filter(Boolean).join("\n\n")}
        render={(d) => (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            {d.jd_fit ? (
              <div>
                <Typography.Text strong>岗位匹配度</Typography.Text>
                <Tag color={d.jd_fit.score >= 70 ? "green" : d.jd_fit.score >= 40 ? "gold" : "red"} style={{ marginLeft: 8 }}>
                  {d.jd_fit.score}
                </Tag>
              </div>
            ) : null}
            {d.highlights?.length ? (
              <div>
                <Typography.Text strong>亮点</Typography.Text>
                {d.highlights.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
              </div>
            ) : null}
            {d.risks?.length ? (
              <div>
                <Typography.Text strong>风险点</Typography.Text>
                {d.risks.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
              </div>
            ) : null}
            {d.jd_fit?.reasons?.length ? (
              <div>
                <Typography.Text strong>匹配理由</Typography.Text>
                {d.jd_fit.reasons.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
              </div>
            ) : null}
            {d.suggestion ? <div style={line}><Typography.Text strong>建议</Typography.Text> {d.suggestion}</div> : null}
          </Space>
        )}
      />
    </Space>
  );

  const optimizePanel = (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
        把简历精简并结构化，突出与目标岗位的匹配点。产出为草稿，不会写回候选人记录。
      </Typography.Paragraph>
      <TalentSelect value={pTalent} onChange={setPTalent} />
      <JobSelect value={pJob} onChange={setPJob} />
      <AiResultCard
        key={`optimize-${pTalent || ""}-${pJob || ""}`}
        title="AI 优化简历"
        onGenerate={async () => {
          if (!pTalent) { message.warning("请先选择候选人"); return null; }
          return { ...(await api.aiResumeOptimize({ talent_id: pTalent, job_id: pJob ?? null })) };
        }}
        hint="点「生成」，AI 会输出一句亮点定位、优化后的简历正文与改动说明。"
        loadingTip="正在读取候选人信息与岗位要求…"
        toText={(d) => [
          d.headline ? `【亮点】${d.headline}` : "",
          `【优化稿】\n${d.optimized}`,
          d.changes?.length ? `【改动说明】\n${d.changes.map((c: string) => `· ${c}`).join("\n")}` : "",
          d.tips?.length ? `【进一步建议】\n${d.tips.map((c: string) => `· ${c}`).join("\n")}` : "",
        ].filter(Boolean).join("\n\n")}
        render={(d) => (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            {d.headline ? <div style={{ fontWeight: 600 }}>{d.headline}</div> : null}
            <pre style={pre}>{d.optimized || "—"}</pre>
            {d.changes?.length ? (
              <div>
                <Typography.Text strong>改动说明</Typography.Text>
                {d.changes.map((c: string, i: number) => <div key={i} style={line}>· {c}</div>)}
              </div>
            ) : null}
            {d.tips?.length ? (
              <div>
                <Typography.Text strong>进一步建议</Typography.Text>
                {d.tips.map((c: string, i: number) => <div key={i} style={line}>· {c}</div>)}
              </div>
            ) : null}
          </Space>
        )}
      />
    </Space>
  );

  const summaryPanel = (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
        汇总该候选人的优劣势、风险与录用建议，适合面试前快速过一遍或面试后一起看。
      </Typography.Paragraph>
      <TalentSelect value={pTalent} onChange={setPTalent} />
      <JobSelect value={pJob} onChange={setPJob} />
      <AiResultCard
        key={`summary-${pTalent || ""}-${pJob || ""}`}
        title="候选人综合评估"
        onGenerate={async () => {
          if (!pTalent) { message.warning("请先选择候选人"); return null; }
          return { ...(await api.aiCandidateSummary(pTalent, pJob ?? null)) };
        }}
        hint="点「生成」，AI 给出优势、风险、面试轮次参考与建议结论。"
        loadingTip="正在汇总候选人信息…"
        toText={(d) => [
          `【总体评价】${d.summary}`,
          d.strengths?.length ? `【优势】\n${d.strengths.map((x: string) => `· ${x}`).join("\n")}` : "",
          d.risks?.length ? `【风险】\n${d.risks.map((x: string) => `· ${x}`).join("\n")}` : "",
          d.recommendation ? `【建议】${d.recommendation}` : "",
          d.suggested_result ? `【建议结论】${d.suggested_result}` : "",
        ].filter(Boolean).join("\n\n")}
        render={(d) => (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            <div style={line}>{d.summary || "—"}</div>
            {d.strengths?.length ? (
              <div>
                <Typography.Text strong>优势</Typography.Text>
                {d.strengths.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
              </div>
            ) : null}
            {d.risks?.length ? (
              <div>
                <Typography.Text strong>风险</Typography.Text>
                {d.risks.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
              </div>
            ) : null}
            {d.suggested_result ? <Tag color="blue">建议结论：{d.suggested_result}</Tag> : null}
            {d.recommendation ? <div style={line}><Typography.Text strong>建议</Typography.Text> {d.recommendation}</div> : null}
          </Space>
        )}
      />
    </Space>
  );

  const questionsPanel = (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
        按该候选人与岗位生成面试问题，每题标注考察点——可直接带进面试现场。
      </Typography.Paragraph>
      <TalentSelect value={pTalent} onChange={setPTalent} />
      <JobSelect value={pJob} onChange={setPJob} />
      <AiResultCard
        key={`questions-${pTalent || ""}-${pJob || ""}`}
        title="生成面试问题"
        onGenerate={async () => {
          if (!pTalent) { message.warning("请先选择候选人"); return null; }
          return { ...(await api.aiInterviewQuestions(pTalent, pJob ?? null)) };
        }}
        hint="点「生成」，AI 输出结构化面试题与考察重点。"
        loadingTip="正在结合简历与岗位生成问题…"
        toText={(d) => (d.questions || []).map((q: { q: string; focus: string }, i: number) => `${i + 1}. ${q.q}\n   考察：${q.focus}`).join("\n\n")}
        render={(d) => (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            {(d.questions || []).map((q: { q: string; focus: string }, i: number) => (
              <div key={i} style={line}>
                <b>{i + 1}. {q.q}</b>
                {q.focus ? <div style={{ color: "var(--color-text-secondary)" }}>考察：{q.focus}</div> : null}
              </div>
            ))}
            {!(d.questions || []).length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有生成内容" /> : null}
          </Space>
        )}
      />
    </Space>
  );

  // ================= 推进 =================
  const outreachPanel = (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
        生成沟通文案草稿（电话邀约 / 微信邀约 / 婉拒 / 跟进）。文案需你手动复制后发送，系统不会代发。
      </Typography.Paragraph>
      <TalentSelect value={oTalent} onChange={setOTalent} />
      <Space.Compact style={{ width: "100%" }}>
        <Select
          value={scene} onChange={setScene}
          options={SCENES.map((k) => ({ value: k, label: AI_OUTREACH_SCENE_LABELS[k] }))}
          style={{ width: "50%" }}
        />
        <div style={{ width: "50%" }}><JobSelect value={oJob} onChange={setOJob} /></div>
      </Space.Compact>
      <AiResultCard
        key={`outreach-${oTalent || ""}-${scene}`}
        title={`跟进话术 · ${AI_OUTREACH_SCENE_LABELS[scene]}`}
        onGenerate={async () => {
          if (!oTalent) { message.warning("请先选择候选人"); return null; }
          return { ...(await api.aiOutreach({ talent_id: oTalent, job_id: oJob ?? null, scene })) };
        }}
        hint="点「生成」，AI 会基于候选人与岗位信息输出可直接改用的沟通文案。"
        loadingTip="正在结合候选人与岗位信息起草文案…"
        toText={(d) => `${d.title ? `${d.title}\n\n` : ""}${d.content}${d.tips?.length ? `\n\n【使用建议】\n${d.tips.map((t: string) => `· ${t}`).join("\n")}` : ""}`}
        render={(d) => (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            <pre style={pre}>{d.content || "—"}</pre>
            {d.tips?.length ? (
              <div>
                <Typography.Text strong>使用建议</Typography.Text>
                {d.tips.map((t: string, i: number) => <div key={i} style={line}>· {t}</div>)}
              </div>
            ) : null}
          </Space>
        )}
      />
    </Space>
  );

  const checklistPanel = (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
        为已录用的候选人生成入职材料清单初稿，逐项确认后可在「入职办理」入库。
      </Typography.Paragraph>
      <TalentSelect value={pTalent} onChange={setPTalent} />
      <AiResultCard
        key={`checklist-${pTalent || ""}`}
        title="入职材料清单"
        onGenerate={async () => {
          if (!pTalent) { message.warning("请先选择候选人"); return null; }
          return { ...(await api.aiOnboardChecklist(pTalent)) };
        }}
        hint="点「生成」，AI 按该候选人的情况列出要收的材料。"
        loadingTip="正在整理入职材料…"
        toText={(d) => (d.items || []).map((it: { name: string; category: string; required: boolean }) => `${it.required ? "[必]" : "[选]"} ${it.name}（${it.category}）`).join("\n")}
        render={(d) => (
          <Space direction="vertical" size={6} style={{ width: "100%" }}>
            {(d.items || []).map((it: { name: string; category: string; required: boolean }, i: number) => (
              <div key={i} style={line}>
                <Tag color={it.required ? "red" : "default"}>{it.required ? "必需" : "可选"}</Tag>
                {it.name}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}> · {it.category}</Typography.Text>
              </div>
            ))}
            {!(d.items || []).length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有生成内容" /> : null}
          </Space>
        )}
      />
    </Space>
  );

  // ================= 诊断 =================
  const jobDiagPanel = (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
        选一个岗位，AI 结合漏斗人数、阶段停留与终态分布判断「卡在哪一步」，并给出可执行建议。
      </Typography.Paragraph>
      <JobSelect value={diagJob} onChange={setDiagJob} placeholder="选择岗位（必填）" />
      <AiResultCard
        key={`jobdiag-${diagJob || ""}`}
        title="岗位诊断"
        onGenerate={async () => {
          if (!diagJob) { message.warning("请先选择岗位"); return null; }
          const detail = await api.getJob(diagJob);
          return { ...(await api.aiJobDiagnosis({ scope: detail.id, report: buildJobDiagnosisReport(detail) })) };
        }}
        hint="点「生成」，AI 告诉你这个岗位慢在哪、该先动哪一步。"
        loadingTip="正在汇总该岗位的漏斗与停留数据…"
        toText={(d) => [
          `【判断】${d.verdict}`,
          d.reasons?.length ? `【依据】\n${d.reasons.map((x: string) => `· ${x}`).join("\n")}` : "",
          d.actions?.length ? `【建议】\n${d.actions.map((x: string) => `· ${x}`).join("\n")}` : "",
        ].filter(Boolean).join("\n\n")}
        render={(d) => (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            <div style={{ fontWeight: 600 }}>{d.verdict || "—"}</div>
            {d.reasons?.length ? (
              <div>
                <Typography.Text strong>依据</Typography.Text>
                {d.reasons.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
              </div>
            ) : null}
            {d.actions?.length ? (
              <div>
                <Typography.Text strong>建议动作</Typography.Text>
                {d.actions.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
              </div>
            ) : null}
          </Space>
        )}
      />
    </Space>
  );

  const inventoryPanel = (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
        对全库做一次盘点：总量与结构如何、缺哪类人、接下来怎么运营。只统计你有权查看的人才。
      </Typography.Paragraph>
      <AiResultCard
        title="人才储备盘点"
        onGenerate={async () => ({ ...(await api.aiTalentInventory({})) })}
        hint="点「生成」，AI 讲清库里有什么、缺什么、怎么补。"
        loadingTip="正在统计人才结构…"
        toText={(d) => [
          `【储备画像】${d.profile}`,
          d.gaps?.length ? `【缺口】\n${d.gaps.map((x: string) => `· ${x}`).join("\n")}` : "",
          d.actions?.length ? `【运营建议】\n${d.actions.map((x: string) => `· ${x}`).join("\n")}` : "",
        ].filter(Boolean).join("\n\n")}
        render={(d) => (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            <div style={line}>{d.profile || "—"}</div>
            {d.gaps?.length ? (
              <div>
                <Typography.Text strong>储备缺口</Typography.Text>
                {d.gaps.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
              </div>
            ) : null}
            {d.actions?.length ? (
              <div>
                <Typography.Text strong>运营建议</Typography.Text>
                {d.actions.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
              </div>
            ) : null}
          </Space>
        )}
      />
    </Space>
  );

  // ---- 组内功能列表：逐项按后端 /api/ai/* 的权限分流过滤 ----
  const items = group === "write"
    ? (can("jobs") ? [{ key: "jd", label: "写 JD", children: jdPanel }] : [])
    : group === "read"
      ? [
        ...(can("talents") ? [{ key: "insight", label: "简历解读", children: insightPanel }] : []),
        ...(can("talents") ? [{ key: "optimize", label: "优化简历", children: optimizePanel }] : []),
        ...(can("interviews") ? [{ key: "summary", label: "综合评估", children: summaryPanel }] : []),
        ...(can("interviews") ? [{ key: "questions", label: "面试问题", children: questionsPanel }] : []),
      ]
      : group === "push"
        ? [
          ...(can("talents") ? [{ key: "outreach", label: "跟进话术", children: outreachPanel }] : []),
          ...(can("pipeline") ? [{ key: "checklist", label: "入职清单", children: checklistPanel }] : []),
        ]
        : [
          ...(can("jobs") ? [{ key: "jobdiag", label: "岗位诊断", children: jobDiagPanel }] : []),
          ...(can("talents") ? [{ key: "inventory", label: "人才盘点", children: inventoryPanel }] : []),
        ];

  // ================= 二级：分组内功能页 =================
  return (
    <div className="page-fill">
      <Card
        className="list-card"
        title={
          <Space size={8}>
            <Button type="text" size="small" icon={<ArrowLeftOutlined />} onClick={() => setGroup(null)}>
              返回
            </Button>
            <span style={{ color: current.color }}>{current.icon}</span>
            <span>{current.label}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>{current.desc}</Typography.Text>
          </Space>
        }
      >
        {items.length > 0 ? (
          <Tabs items={items} />
        ) : (
          <Alert type="info" showIcon message="该分组下暂无可用功能" description="请联系管理员开通对应权限。" />
        )}
      </Card>
    </div>
  );
}