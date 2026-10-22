import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert, Button, Card, Col, Empty, Input, Row, Select, Space, Table, Tabs, Tag, Typography, message,
} from "antd";
import {
  ArrowLeftOutlined, FileTextOutlined, RobotOutlined, SolutionOutlined,
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
// 平铺 9 个 Tab 要横向滚动才能找全，越加越难用。改成五个语义分组后，
// 用户先想「我要干什么」（写材料/看人/推进/诊断/人事），再选具体功能，认知负担恒定。
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

/** 候选人多选器（最多 3 个）：用于「候选人对比」。同样走后端 owner 隔离搜索。 */
function TalentMultiSelect({ value, onChange }: { value?: string[]; onChange: (v?: string[]) => void }) {
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
      mode="multiple" maxCount={3} showSearch allowClear value={value} onChange={onChange} onSearch={search}
      filterOption={false} loading={loading}
      placeholder="选择 2-3 个候选人进行对比"
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
  /** 该组对哪些权限可见：任一满足即显示整组（组内功能再逐个按细粒度权限过滤） */
  perm: string[];
}

export default function AiAssistant() {
  const user: User | null = useMemo(() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  }, []);
  const isAdmin = user?.role === "admin";
  const perms = user?.permissions || [];
  const can = (p: string) => isAdmin || perms.includes(p);
  const navigate = useNavigate();

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

  // ---- 诊断：招聘周报的三个旋钮（周期 / 语气 / 焦点），组合不同则缓存与产出都不同 ----
  const [wrRange, setWrRange] = useState<"this_week" | "last_week">("this_week");
  const [wrTone, setWrTone] = useState<"report" | "brief">("report");
  const [wrFocus, setWrFocus] = useState<"all" | "progress" | "risk">("all");

  // ---- 看人：候选人对比（多选 2-3 个 + 可选岗位） ----
  const [compareTalents, setCompareTalents] = useState<string[] | undefined>();
  const [compareJob, setCompareJob] = useState<string | undefined>();

  // ---- 推进：Offer 谈判话术（候选人 + 岗位 + 薪资/顾虑） ----
  const [negTalent, setNegTalent] = useState<string | undefined>();
  const [negJob, setNegJob] = useState<string | undefined>();
  const [negOffered, setNegOffered] = useState("");
  const [negExpected, setNegExpected] = useState("");
  const [negConcerns, setNegConcerns] = useState("");

  // ---- 推进：被动人才触达文案（候选人 + 岗位） ----
  const [sourcingTalent, setSourcingTalent] = useState<string | undefined>();
  const [sourcingJob, setSourcingJob] = useState<string | undefined>();

  // ---- 诊断：招聘渠道建议（岗位） ----
  const [channelJob, setChannelJob] = useState<string | undefined>();

  // ---- 人事：合同风险审查 / 社保增减员 / 个税筹划 / 试用期合规 ----
  const [contractTalent, setContractTalent] = useState<string | undefined>();
  const [contractText, setContractText] = useState<string>("");
  const [socialTalent, setSocialTalent] = useState<string | undefined>();
  const [socialEvent, setSocialEvent] = useState<string>("add");
  const [socialDate, setSocialDate] = useState<string>("");
  const [socialCity, setSocialCity] = useState<string>("");
  const [taxTalent, setTaxTalent] = useState<string | undefined>();
  const [taxBase, setTaxBase] = useState<string>("");
  const [taxBonus, setTaxBonus] = useState<string>("");
  const [taxCity, setTaxCity] = useState<string>("");
  const [probTalent, setProbTalent] = useState<string | undefined>();
  const [probStart, setProbStart] = useState<string>("");
  const [probMonths, setProbMonths] = useState<string>("6");

  const GROUPS: GroupDef[] = [
    { key: "write", label: "写材料", desc: "要产出一份文档给外部时用", icon: <FileTextOutlined />, color: "#4f46e5", perm: ["jobs"] },
    { key: "read", label: "看人", desc: "想搞懂一个候选人时用", icon: <SearchOutlined />, color: "#0ea5e9", perm: ["talents", "interviews"] },
    { key: "push", label: "推进", desc: "正在推候选人时用", icon: <TeamOutlined />, color: "#10b981", perm: ["talents", "pipeline"] },
    { key: "diag", label: "诊断", desc: "想知道哪里卡住了时用", icon: <WarningOutlined />, color: "#d97706", perm: ["talents", "jobs", "pipeline"] },
    { key: "hr", label: "人事", desc: "合同 / 社保 / 薪酬合规时用", icon: <SolutionOutlined />, color: "#db2777", perm: ["contracts", "social"] },
  ];
  // 分组 perm 是「任一满足即可见」：组内功能另有细粒度 perm（见下方 items 构造）
  const visibleGroups = GROUPS.filter((g) => g.perm.some(can));

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
    if (key === "read") return (can("talents") ? 3 : 0) + (can("interviews") ? 2 : 0);
    if (key === "push") return (can("talents") ? 3 : 0) + (can("pipeline") ? 1 : 0);
    if (key === "diag") return (can("jobs") ? 2 : 0) + (can("talents") ? 1 : 0) + (can("pipeline") ? 1 : 0);
    if (key === "hr") return (can("contracts") ? 2 : 0) + (can("social") ? 2 : 0);
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

  const weeklyPanel = (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
        由系统自查这一周的真实数据（人才入库 / 阶段流转 / 面试与结果 / Offer 与入职 / 岗位进展 / 逾期待办），
        讲成一份可直接发出去的周报。改下面任一旋钮即换一种写法，三个组合各自独立缓存。
      </Typography.Paragraph>
      <Space.Compact style={{ width: "100%" }}>
        <Select
          value={wrRange} onChange={setWrRange} style={{ width: "34%" }}
          options={[{ value: "this_week", label: "本周至今" }, { value: "last_week", label: "上周" }]}
        />
        <Select
          value={wrTone} onChange={setWrTone} style={{ width: "33%" }}
          options={[{ value: "report", label: "正式汇报稿" }, { value: "brief", label: "极简清单" }]}
        />
        <Select
          value={wrFocus} onChange={setWrFocus} style={{ width: "33%" }}
          options={[
            { value: "all", label: "进展+问题" },
            { value: "progress", label: "只看进展" },
            { value: "risk", label: "只看卡点" },
          ]}
        />
      </Space.Compact>
      <AiResultCard
        key={`weekly-${wrRange}-${wrTone}-${wrFocus}`}
        title="招聘周报"
        fetchOnMount={async () => {
          const r = await api.getAiWeeklyReport({ range: wrRange, tone: wrTone, focus: wrFocus });
          return r.data ? { ...r.data } : null;
        }}
        onGenerate={async () => ({ ...(await api.aiWeeklyReport({ range: wrRange, tone: wrTone, focus: wrFocus })) })}
        hint="点「生成」，AI 会把本周数据汇总成一份带标题、正文、亮点、卡点与下周计划的完整周报。"
        loadingTip="正在统计本周招聘数据并撰写周报…"
        toText={(d) => [
          d.headline ? `${d.headline}\n${d.period || ""}` : "",
          d.narrative ? `\n${d.narrative}` : "",
          d.highlights?.length ? `\n【本周亮点】\n${d.highlights.map((x: string) => `· ${x}`).join("\n")}` : "",
          d.concerns?.length ? `\n【风险与卡点】\n${d.concerns.map((x: string) => `· ${x}`).join("\n")}` : "",
          d.next_actions?.length ? `\n【下周计划】\n${d.next_actions.map((x: string, i: number) => `${i + 1}. ${x}`).join("\n")}` : "",
        ].filter(Boolean).join("\n")}
        render={(d) => (
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            <Space direction="vertical" size={2}>
              <Typography.Text strong style={{ fontSize: 15 }}>{d.headline || "本周招聘周报"}</Typography.Text>
              {d.period ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>{d.period}</Typography.Text> : null}
            </Space>
            {d.narrative ? (
              <Typography.Paragraph style={{ ...pre, margin: 0 }}>{d.narrative}</Typography.Paragraph>
            ) : null}
            {d.highlights?.length ? (
              <div>
                <Typography.Text strong>本周亮点</Typography.Text>
                {d.highlights.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
              </div>
            ) : null}
            {d.concerns?.length ? (
              <div>
                <Typography.Text strong type="warning">风险与卡点</Typography.Text>
                {d.concerns.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
              </div>
            ) : null}
            {d.next_actions?.length ? (
              <div>
                <Typography.Text strong>下周计划</Typography.Text>
                {d.next_actions.map((x: string, i: number) => <div key={i} style={line}>{i + 1}. {x}</div>)}
              </div>
            ) : null}
          </Space>
        )}
      />
    </Space>
  );

  // ================= 看人：候选人对比 =================
  const comparePanel = (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
        选 2-3 个候选人并排对比，AI 按维度给出谁更适合的判断。可选目标岗位做「谁更贴合岗位」的对比。
      </Typography.Paragraph>
      <TalentMultiSelect value={compareTalents} onChange={setCompareTalents} />
      <JobSelect value={compareJob} onChange={setCompareJob} />
      <AiResultCard
        key={`compare-${compareTalents?.join(",") || ""}-${compareJob || ""}`}
        title="候选人对比"
        fetchOnMount={async () => {
          if (!compareTalents || compareTalents.length < 2) return null;
          const r = await api.aiCandidateCompareGet(compareTalents);
          return r.data ? { ...r.data } : null;
        }}
        onGenerate={async () => {
          if (!compareTalents || compareTalents.length < 2) { message.warning("请至少选择 2 个候选人"); return null; }
          return { ...(await api.aiCandidateCompare({ talent_ids: compareTalents, job_id: compareJob ?? null })) };
        }}
        hint="点「生成」，AI 会按维度并排对比并给出推荐。"
        loadingTip="正在比对候选人信息…"
        toText={(d) => [
          `【推荐】${d.verdict}`,
          ...(d.aspects || []).map((a: { aspect: string; notes: string[] }) =>
            `【${a.aspect}】\n${(d.names || []).map((n: string, i: number) => `${n}：${a.notes[i] || "—"}`).join("\n")}`
          ),
          d.watchouts?.length ? `【警惕】\n${d.watchouts.map((x: string) => `· ${x}`).join("\n")}` : "",
        ].filter(Boolean).join("\n\n")}
        render={(d) => {
          const names: string[] = d.names || [];
          const columns = [
            { title: "维度", dataIndex: "aspect", key: "aspect", width: 120 },
            ...names.map((n, i) => ({ title: n, dataIndex: `v${i}`, key: `v${i}` })),
          ];
          const dataSource = (d.aspects || []).map((a: { aspect: string; notes: string[] }, idx: number) => ({
            key: idx,
            aspect: a.aspect,
            ...names.reduce((acc: Record<string, string>, _n, i) => { acc[`v${i}`] = a.notes[i] || "—"; return acc; }, {}),
          }));
          return (
            <Space direction="vertical" size={10} style={{ width: "100%" }}>
              {d.verdict ? <div style={line}><Typography.Text strong>推荐</Typography.Text> {d.verdict}</div> : null}
              <Table
                size="small" bordered pagination={false}
                columns={columns as any} dataSource={dataSource as any}
                scroll={{ x: "max-content" }}
              />
              {d.watchouts?.length ? (
                <div>
                  <Typography.Text strong type="warning">需警惕</Typography.Text>
                  {d.watchouts.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
                </div>
              ) : null}
            </Space>
          );
        }}
      />
    </Space>
  );

  // ================= 推进：Offer 谈判话术 =================
  const negPanel = (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
        基于候选人、岗位与双方薪资预期，生成谈判基调、筹码话术与注意事项。填写薪资与顾虑能让话术更贴合。
      </Typography.Paragraph>
      <TalentSelect value={negTalent} onChange={setNegTalent} />
      <JobSelect value={negJob} onChange={setNegJob} />
      <Space.Compact style={{ width: "100%" }}>
        <Input placeholder="我方 Offer 薪资（可选）" value={negOffered} onChange={(e) => setNegOffered(e.target.value)} allowClear />
        <Input placeholder="候选人期望薪资（可选）" value={negExpected} onChange={(e) => setNegExpected(e.target.value)} allowClear />
      </Space.Compact>
      <Input.TextArea
        placeholder="候选人的顾虑或背景（可选，如「有竞品 Offer 在比」「对加班有顾虑」）"
        value={negConcerns} onChange={(e) => setNegConcerns(e.target.value)} autoSize={{ minRows: 2, maxRows: 4 }} allowClear
      />
      <AiResultCard
        key={`neg-${negTalent || ""}-${negJob || ""}`}
        title="Offer 谈判话术"
        fetchOnMount={async () => {
          if (!negTalent) return null;
          const r = await api.aiOfferNegotiationGet(negTalent, negJob ?? null);
          return r.data ? { ...r.data } : null;
        }}
        onGenerate={async () => {
          if (!negTalent) { message.warning("请先选择候选人"); return null; }
          return { ...(await api.aiOfferNegotiation({
            talent_id: negTalent, job_id: negJob ?? null,
            offered_salary: negOffered.trim() || undefined,
            expected_salary: negExpected.trim() || undefined,
            concerns: negConcerns.trim() || undefined,
          })) };
        }}
        hint="点「生成」，AI 给出谈判基调、核心筹码与分场景话术。"
        loadingTip="正在生成谈判话术…"
        toText={(d) => [
          d.strategy ? `【基调】${d.strategy}` : "",
          d.points?.length ? `【核心筹码】\n${d.points.map((x: string) => `· ${x}`).join("\n")}` : "",
          d.scripts?.length ? `【场景话术】\n${d.scripts.map((s: { situation: string; script: string }) => `· ${s.situation}：${s.script}`).join("\n")}` : "",
          d.tips?.length ? `【注意】\n${d.tips.map((x: string) => `· ${x}`).join("\n")}` : "",
        ].filter(Boolean).join("\n\n")}
        render={(d) => (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            {d.strategy ? <div style={line}><Typography.Text strong>基调</Typography.Text> {d.strategy}</div> : null}
            {d.points?.length ? (
              <div>
                <Typography.Text strong>核心筹码</Typography.Text>
                {d.points.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
              </div>
            ) : null}
            {d.scripts?.length ? (
              <div>
                <Typography.Text strong>场景话术</Typography.Text>
                {d.scripts.map((s: { situation: string; script: string }, i: number) => (
                  <div key={i} style={{ marginBottom: 4 }}>
                    <Tag color="blue">{s.situation}</Tag>
                    <div style={pre}>{s.script}</div>
                  </div>
                ))}
              </div>
            ) : null}
            {d.tips?.length ? (
              <div>
                <Typography.Text strong>注意</Typography.Text>
                {d.tips.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
              </div>
            ) : null}
          </Space>
        )}
      />
    </Space>
  );

  // ================= 推进：被动人才触达文案 =================
  const sourcingPanel = (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
        面向在职/观望的被动候选人生成「一对一挖角」文案——引用其履历具体亮点、不群发、不甩 JD。文案需手动复制后发送。
      </Typography.Paragraph>
      <TalentSelect value={sourcingTalent} onChange={setSourcingTalent} />
      <JobSelect value={sourcingJob} onChange={setSourcingJob} />
      <AiResultCard
        key={`sourcing-${sourcingTalent || ""}-${sourcingJob || ""}`}
        title="被动人才触达"
        fetchOnMount={async () => {
          if (!sourcingTalent) return null;
          const r = await api.aiSourcingCopyGet(sourcingTalent, sourcingJob ?? null);
          return r.data ? { ...r.data } : null;
        }}
        onGenerate={async () => {
          if (!sourcingTalent) { message.warning("请先选择候选人"); return null; }
          return { ...(await api.aiSourcingCopy({ talent_id: sourcingTalent, job_id: sourcingJob ?? null })) };
        }}
        hint="点「生成」，AI 输出一段可发给被动候选人的触达文案。"
        loadingTip="正在结合候选人与岗位起草文案…"
        toText={(d) => `${d.title ? `${d.title}\n\n` : ""}${d.content}${d.tips?.length ? `\n\n【触达建议】\n${d.tips.map((t: string) => `· ${t}`).join("\n")}` : ""}`}
        render={(d) => (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            <pre style={pre}>{d.content || "—"}</pre>
            {d.tips?.length ? (
              <div>
                <Typography.Text strong>触达建议</Typography.Text>
                {d.tips.map((t: string, i: number) => <div key={i} style={line}>· {t}</div>)}
              </div>
            ) : null}
          </Space>
        )}
      />
    </Space>
  );

  // ================= 诊断：招聘渠道建议 =================
  const channelPanel = (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
        选一个岗位，AI 基于其职能、层级、城市与薪资推荐投放渠道与优先级，并给出渠道运营建议。
      </Typography.Paragraph>
      <JobSelect value={channelJob} onChange={setChannelJob} placeholder="选择岗位（必填）" />
      <AiResultCard
        key={`channel-${channelJob || ""}`}
        title="招聘渠道建议"
        fetchOnMount={async () => {
          if (!channelJob) return null;
          const r = await api.aiChannelAdviceGet(channelJob);
          return r.data ? { ...r.data } : null;
        }}
        onGenerate={async () => {
          if (!channelJob) { message.warning("请先选择岗位"); return null; }
          return { ...(await api.aiChannelAdvice({ job_id: channelJob })) };
        }}
        hint="点「生成」，AI 告诉你这个岗位该去哪招人、优先级怎么排。"
        loadingTip="正在分析岗位特征与渠道匹配…"
        toText={(d) => [
          d.verdict ? `【结论】${d.verdict}` : "",
          d.channels?.length ? `【渠道】\n${d.channels.map((c: { channel: string; priority: string; reason: string }) => `· ${c.channel}（${c.priority}）：${c.reason}`).join("\n")}` : "",
          d.tips?.length ? `【运营建议】\n${d.tips.map((x: string) => `· ${x}`).join("\n")}` : "",
        ].filter(Boolean).join("\n\n")}
        render={(d) => (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            {d.verdict ? <div style={{ fontWeight: 600 }}>{d.verdict}</div> : null}
            {d.channels?.length ? (
              <div>
                <Typography.Text strong>推荐渠道</Typography.Text>
                {d.channels.map((c: { channel: string; priority: string; reason: string }, i: number) => (
                  <div key={i} style={line}>
                    <Tag color={c.priority === "高" ? "green" : c.priority === "中" ? "gold" : "default"}>{c.priority}</Tag>
                    <b>{c.channel}</b> — {c.reason}
                  </div>
                ))}
              </div>
            ) : null}
            {d.tips?.length ? (
              <div>
                <Typography.Text strong>运营建议</Typography.Text>
                {d.tips.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
              </div>
            ) : null}
          </Space>
        )}
      />
    </Space>
  );

  // ================= 人事：合同风险审查 =================
  const contractPanel = (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
        粘贴劳动合同 / 聘用协议文本，AI 标出风险点、缺失的必备条款，并给出合规健康度评分。需关联候选人作为合同主体。
      </Typography.Paragraph>
      <TalentSelect value={contractTalent} onChange={setContractTalent} />
      <Input.TextArea
        placeholder="在此粘贴合同内容（至少 20 字）"
        value={contractText} onChange={(e) => setContractText(e.target.value)} autoSize={{ minRows: 4, maxRows: 10 }} allowClear
      />
      <AiResultCard
        key={`contract-${contractTalent || ""}`}
        title="合同风险审查"
        fetchOnMount={async () => {
          if (!contractTalent) return null;
          const r = await api.aiContractReviewGet(contractTalent);
          return r.data ? { ...r.data } : null;
        }}
        onGenerate={async () => {
          if (!contractTalent) { message.warning("请先选择候选人"); return null; }
          if (contractText.trim().length < 20) { message.warning("请粘贴至少 20 字的合同内容"); return null; }
          return { ...(await api.aiContractReview({ talent_id: contractTalent, text: contractText.trim() })) };
        }}
        hint="点「生成」，AI 会标出风险点与缺失条款并打分。"
        loadingTip="正在审查合同条款…"
        toText={(d) => [
          d.summary ? `【整体判断】${d.summary}` : "",
          d.score != null ? `【合规健康度】${d.score}/100` : "",
          d.risks?.length ? `【风险点】\n${d.risks.map((r: { clause: string; risk: string; suggestion: string }) => `· ${r.clause}：${r.risk}（建议：${r.suggestion}）`).join("\n")}` : "",
          d.missing?.length ? `【缺失条款】\n${d.missing.map((x: string) => `· ${x}`).join("\n")}` : "",
        ].filter(Boolean).join("\n\n")}
        render={(d) => (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            {d.summary ? <div style={line}><Typography.Text strong>整体判断</Typography.Text> {d.summary}</div> : null}
            {d.score != null ? (
              <div style={line}><Typography.Text strong>合规健康度</Typography.Text>{" "}
                <Tag color={d.score >= 80 ? "green" : d.score >= 60 ? "gold" : "red"}>{d.score}/100</Tag></div>
            ) : null}
            {d.risks?.length ? (
              <div>
                <Typography.Text strong>风险点</Typography.Text>
                {d.risks.map((r: { clause: string; risk: string; suggestion: string }, i: number) => (
                  <div key={i} style={{ marginBottom: 4 }}>
                    <Tag color="volcano">{r.clause}</Tag>
                    <div style={pre}><b>风险：</b>{r.risk}</div>
                    <div style={pre}><b>建议：</b>{r.suggestion}</div>
                  </div>
                ))}
              </div>
            ) : null}
            {d.missing?.length ? (
              <div>
                <Typography.Text strong>缺失条款</Typography.Text>
                {d.missing.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
              </div>
            ) : null}
          </Space>
        )}
      />
    </Space>
  );

  // ================= 人事：社保增减员提醒 =================
  const socialPanel = (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
        选择增员或减员事件、关键日期与参保城市，AI 生成截止节点、操作清单与合规注意。需关联候选人。
      </Typography.Paragraph>
      <TalentSelect value={socialTalent} onChange={setSocialTalent} />
      <Space.Compact style={{ width: "100%" }}>
        <Select value={socialEvent} onChange={setSocialEvent} style={{ width: "40%" }}
          options={[{ value: "add", label: "增员（入职）" }, { value: "remove", label: "减员（离职）" }]} />
        <Input placeholder="关键日期 YYYY-MM-DD（可选）" value={socialDate} onChange={(e) => setSocialDate(e.target.value)} allowClear />
      </Space.Compact>
      <Input placeholder="参保城市（可选，如 上海）" value={socialCity} onChange={(e) => setSocialCity(e.target.value)} allowClear />
      <AiResultCard
        key={`social-${socialTalent || ""}-${socialEvent}-${socialCity}`}
        title="社保增减员提醒"
        fetchOnMount={async () => {
          if (!socialTalent) return null;
          const r = await api.aiSocialReminderGet(socialTalent, socialEvent as "add" | "remove", socialCity.trim());
          return r.data ? { ...r.data } : null;
        }}
        onGenerate={async () => {
          if (!socialTalent) { message.warning("请先选择候选人"); return null; }
          return { ...(await api.aiSocialReminder({
            talent_id: socialTalent, event: socialEvent as "add" | "remove",
            date: socialDate.trim(), city: socialCity.trim(),
          })) };
        }}
        hint="点「生成」，AI 给出增减员时间节点与操作清单。"
        loadingTip="正在生成社保增减员提醒…"
        toText={(d) => [
          d.deadline ? `【关键节点】${d.deadline}` : "",
          d.steps?.length ? `【操作清单】\n${d.steps.map((x: string) => `· ${x}`).join("\n")}` : "",
          d.notes?.length ? `【合规注意】\n${d.notes.map((x: string) => `· ${x}`).join("\n")}` : "",
          d.tips?.length ? `【实操建议】\n${d.tips.map((x: string) => `· ${x}`).join("\n")}` : "",
        ].filter(Boolean).join("\n\n")}
        render={(d) => (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            {d.deadline ? <div style={line}><Typography.Text strong>关键节点</Typography.Text> {d.deadline}</div> : null}
            {d.steps?.length ? (
              <div>
                <Typography.Text strong>操作清单</Typography.Text>
                {d.steps.map((x: string, i: number) => <div key={i} style={line}>{i + 1}. {x}</div>)}
              </div>
            ) : null}
            {d.notes?.length ? (
              <div>
                <Typography.Text strong>合规注意</Typography.Text>
                {d.notes.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
              </div>
            ) : null}
            {d.tips?.length ? (
              <div>
                <Typography.Text strong>实操建议</Typography.Text>
                {d.tips.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
              </div>
            ) : null}
          </Space>
        )}
      />
    </Space>
  );

  // ================= 人事：个税筹划建议 =================
  const taxPanel = (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
        填写税前月薪、年终奖与城市，AI 估算到手并给出专项附加扣除与合规节税建议。需关联候选人。
      </Typography.Paragraph>
      <TalentSelect value={taxTalent} onChange={setTaxTalent} />
      <Space.Compact style={{ width: "100%" }}>
        <Input placeholder="税前月薪（元，可选）" value={taxBase} onChange={(e) => setTaxBase(e.target.value)} allowClear />
        <Input placeholder="年终奖/绩效（元，可选）" value={taxBonus} onChange={(e) => setTaxBonus(e.target.value)} allowClear />
      </Space.Compact>
      <Input placeholder="城市（可选，如 北京）" value={taxCity} onChange={(e) => setTaxCity(e.target.value)} allowClear />
      <AiResultCard
        key={`tax-${taxTalent || ""}-${taxCity}`}
        title="个税筹划建议"
        fetchOnMount={async () => {
          if (!taxTalent) return null;
          const r = await api.aiTaxPlanGet(taxTalent, taxCity.trim());
          return r.data ? { ...r.data } : null;
        }}
        onGenerate={async () => {
          if (!taxTalent) { message.warning("请先选择候选人"); return null; }
          return { ...(await api.aiTaxPlan({ talent_id: taxTalent, base: taxBase.trim(), bonus: taxBonus.trim(), city: taxCity.trim() })) };
        }}
        hint="点「生成」，AI 估算到手并给节税建议。"
        loadingTip="正在计算个税与筹划建议…"
        toText={(d) => [
          d.take_home_note ? `【到手估算】${d.take_home_note}` : "",
          d.optimizations?.length ? `【优化点】\n${d.optimizations.map((o: { item: string; detail: string }) => `· ${o.item}：${o.detail}`).join("\n")}` : "",
          d.tips?.length ? `【合规提醒】\n${d.tips.map((x: string) => `· ${x}`).join("\n")}` : "",
        ].filter(Boolean).join("\n\n")}
        render={(d) => (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            {d.take_home_note ? <div style={line}><Typography.Text strong>到手估算</Typography.Text> {d.take_home_note}</div> : null}
            {d.optimizations?.length ? (
              <div>
                <Typography.Text strong>优化点</Typography.Text>
                {d.optimizations.map((o: { item: string; detail: string }, i: number) => (
                  <div key={i} style={line}>· <b>{o.item}</b>：{o.detail}</div>
                ))}
              </div>
            ) : null}
            {d.tips?.length ? (
              <div>
                <Typography.Text strong>合规提醒</Typography.Text>
                {d.tips.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
              </div>
            ) : null}
          </Space>
        )}
      />
    </Space>
  );

  // ================= 人事：试用期合规提醒 =================
  const probPanel = (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
        填写合同起始日与试用期月数，AI 推算转正 / 解除节点、合规要点与沟通话术。需关联候选人。
      </Typography.Paragraph>
      <TalentSelect value={probTalent} onChange={setProbTalent} />
      <Space.Compact style={{ width: "100%" }}>
        <Input placeholder="合同起始日 YYYY-MM-DD（可选）" value={probStart} onChange={(e) => setProbStart(e.target.value)} allowClear />
        <Input placeholder="试用期月数（如 6）" value={probMonths} onChange={(e) => setProbMonths(e.target.value)} allowClear />
      </Space.Compact>
      <AiResultCard
        key={`prob-${probTalent || ""}-${probStart}-${probMonths}`}
        title="试用期合规提醒"
        fetchOnMount={async () => {
          if (!probTalent) return null;
          const r = await api.aiProbationComplianceGet(probTalent, probStart.trim(), probMonths.trim());
          return r.data ? { ...r.data } : null;
        }}
        onGenerate={async () => {
          if (!probTalent) { message.warning("请先选择候选人"); return null; }
          return { ...(await api.aiProbationCompliance({ talent_id: probTalent, start: probStart.trim(), months: probMonths.trim() })) };
        }}
        hint="点「生成」，AI 梳理试用期节点与话术。"
        loadingTip="正在梳理试用期合规节点…"
        toText={(d) => [
          d.timeline?.length ? `【节点】\n${d.timeline.map((t: { node: string; action: string }) => `· ${t.node}：${t.action}`).join("\n")}` : "",
          d.points?.length ? `【合规要点】\n${d.points.map((x: string) => `· ${x}`).join("\n")}` : "",
          d.scripts?.length ? `【沟通话术】\n${d.scripts.map((s: { situation: string; script: string }) => `· ${s.situation}：${s.script}`).join("\n")}` : "",
          d.tips?.length ? `【注意】\n${d.tips.map((x: string) => `· ${x}`).join("\n")}` : "",
        ].filter(Boolean).join("\n\n")}
        render={(d) => (
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            {d.timeline?.length ? (
              <div>
                <Typography.Text strong>关键节点</Typography.Text>
                {d.timeline.map((t: { node: string; action: string }, i: number) => (
                  <div key={i} style={line}>· <b>{t.node}</b>：{t.action}</div>
                ))}
              </div>
            ) : null}
            {d.points?.length ? (
              <div>
                <Typography.Text strong>合规要点</Typography.Text>
                {d.points.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
              </div>
            ) : null}
            {d.scripts?.length ? (
              <div>
                <Typography.Text strong>沟通话术</Typography.Text>
                {d.scripts.map((s: { situation: string; script: string }, i: number) => (
                  <div key={i} style={{ marginBottom: 4 }}>
                    <Tag color="blue">{s.situation}</Tag>
                    <div style={pre}>{s.script}</div>
                  </div>
                ))}
              </div>
            ) : null}
            {d.tips?.length ? (
              <div>
                <Typography.Text strong>注意</Typography.Text>
                {d.tips.map((x: string, i: number) => <div key={i} style={line}>· {x}</div>)}
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
        ...(can("talents") ? [{ key: "compare", label: "候选人对比", children: comparePanel }] : []),
        ...(can("interviews") ? [{ key: "summary", label: "综合评估", children: summaryPanel }] : []),
        ...(can("interviews") ? [{ key: "questions", label: "面试问题", children: questionsPanel }] : []),
      ]
      : group === "push"
        ? [
          ...(can("talents") ? [{ key: "outreach", label: "跟进话术", children: outreachPanel }] : []),
          ...(can("talents") ? [{ key: "offer", label: "Offer 谈判", children: negPanel }] : []),
          ...(can("talents") ? [{ key: "sourcing", label: "被动触达", children: sourcingPanel }] : []),
          ...(can("pipeline") ? [{ key: "checklist", label: "入职清单", children: checklistPanel }] : []),
        ]
        : group === "hr"
          ? [
            ...(can("contracts") ? [{ key: "contract", label: "合同审查", children: contractPanel }] : []),
            ...(can("contracts") ? [{ key: "probation", label: "试用期合规", children: probPanel }] : []),
            ...(can("social") ? [{ key: "social", label: "社保增减员", children: socialPanel }] : []),
            ...(can("social") ? [{ key: "tax", label: "个税筹划", children: taxPanel }] : []),
          ]
          : [
            ...(can("jobs") ? [{ key: "jobdiag", label: "岗位诊断", children: jobDiagPanel }] : []),
            ...(can("jobs") ? [{ key: "channel", label: "渠道建议", children: channelPanel }] : []),
            ...(can("talents") ? [{ key: "inventory", label: "人才盘点", children: inventoryPanel }] : []),
            ...(can("pipeline") ? [{ key: "weekly", label: "招聘周报", children: weeklyPanel }] : []),
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
          <>
            {/* 智能匹配入口卡：批量筛人场景（一个画像 × 多个候选人）不在本页内联能力里，
                用横幅指向 /match；按 profiles 权限显隐，避免指到无权页 */}
            {group === "read" && can("profiles") && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="想按岗位画像批量筛人？用「智能匹配」"
                description="选一个职位画像，从人才库挑几个候选人，AI 按匹配度排序并给出理由，合适的直接推进看板。"
                action={
                  <Button size="small" className="ai-btn" icon={<RobotOutlined />} onClick={() => navigate("/match", { state: { from: "ai" } })}>
                    打开
                  </Button>
                }
              />
            )}
            <Tabs items={items} />
          </>
        ) : (
          <Alert type="info" showIcon message="该分组下暂无可用功能" description="请联系管理员开通对应权限。" />
        )}
      </Card>
    </div>
  );
}