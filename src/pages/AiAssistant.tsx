import { useEffect, useMemo, useState } from "react";
import { Alert, Card, Input, Select, Space, Tabs, Tag, Typography, message } from "antd";
import { RobotOutlined } from "@ant-design/icons";
import { api } from "../api";
import AiResultCard from "../components/AiResultCard";
import type { AiOutreachScene, User } from "../types";
import { AI_OUTREACH_SCENE_LABELS } from "../types";

// AI 助手：把系统里零散的 AI 能力集中成一个入口页（写 JD / 改简历 / 跟进话术）。
// 约定：
//   1) 页面本身受「工具中心」权限（tools）控制；页内每个 Tab 再按其领域权限
//      （jobs / talents）条件展示，管理员全见——避免「有页面没数据权限」的错配。
//   2) 所有产出都是草稿，必须用户手动复制后才使用，系统永不代发、永不写库。
//   3) AI 不可用时只提示、不阻塞，沿用全站统一护栏（配额/缓存/脱敏/降级）。

/** 候选人选择器：按关键词搜索人才库（仅返回有权限的人才），选中后回填 id */
function TalentSelect({ value, onChange }: { value?: string; onChange: (v?: string) => void }) {
  const [opts, setOpts] = useState<{ label: string; value: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const search = async (kw: string) => {
    setLoading(true);
    try {
      // 复用列表接口，后端已做 owner 隔离：只能搜到自己有权限的人才
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
      showSearch
      allowClear
      value={value}
      onChange={onChange}
      onSearch={search}
      filterOption={false}
      loading={loading}
      placeholder="搜索并选择候选人（姓名 / 公司 / 职位）"
      options={opts}
      style={{ width: "100%" }}
    />
  );
}

/** 目标岗位选择器（可选）：用于让 AI 突出与该岗位的匹配点 */
function JobSelect({ value, onChange }: { value?: string; onChange: (v?: string) => void }) {
  const [opts, setOpts] = useState<{ label: string; value: string }[]>([]);
  useEffect(() => {
    api.getJobOptions()
      .then((jobs) => setOpts(jobs.map((j) => ({ value: j.id, label: `${j.title}${j.department ? ` · ${j.department}` : ""}` }))))
      .catch(() => setOpts([]));
  }, []);
  return (
    <Select
      showSearch
      allowClear
      value={value}
      onChange={onChange}
      placeholder="目标岗位（可选，选中后 AI 会突出匹配点）"
      options={opts}
      style={{ width: "100%" }}
    />
  );
}

const SCENES = Object.keys(AI_OUTREACH_SCENE_LABELS) as AiOutreachScene[];

export default function AiAssistant() {
  const user: User | null = useMemo(() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  }, []);
  const isAdmin = user?.role === "admin";
  const perms = user?.permissions || [];
  const canJobs = isAdmin || perms.includes("jobs");
  const canTalents = isAdmin || perms.includes("talents");

  // ---- 写 JD ----
  const [title, setTitle] = useState("");
  const [department, setDepartment] = useState("");
  const [city, setCity] = useState("");

  // ---- 改简历 ----
  const [optTalent, setOptTalent] = useState<string | undefined>();
  const [optJob, setOptJob] = useState<string | undefined>();

  // ---- 跟进话术 ----
  const [outTalent, setOutTalent] = useState<string | undefined>();
  const [outJob, setOutJob] = useState<string | undefined>();
  const [scene, setScene] = useState<AiOutreachScene>("invite_wechat");

  const jdTab = (
    <Card size="small">
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        填岗位名称即可让 AI 起草职责与任职要求，并可给出学历 / 经验 / 薪资建议。生成的是草稿，请按实际修改后再使用。
      </Typography.Paragraph>
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
    </Card>
  );

  const resumeTab = (
    <Card size="small">
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        选择一位候选人（可再选目标岗位），AI 会把简历精简、结构化并突出与该岗位的匹配点。产出为草稿，HR 参考后手动使用，不会写回候选人记录。
      </Typography.Paragraph>
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        <TalentSelect value={optTalent} onChange={setOptTalent} />
        <JobSelect value={optJob} onChange={setOptJob} />
        <AiResultCard
          key={`optimize-${optTalent || ""}-${optJob || ""}`}
          title="AI 优化简历"
          onGenerate={async () => {
            if (!optTalent) { message.warning("请先选择候选人"); return null; }
            return { ...(await api.aiResumeOptimize({ talent_id: optTalent, job_id: optJob ?? null })) };
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
    </Card>
  );

  const outreachTab = (
    <Card size="small">
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        选择候选人与场景，AI 生成沟通文案草稿（电话邀约 / 微信邀约 / 婉拒 / 跟进）。文案需你手动复制后发送，系统不会代发。
      </Typography.Paragraph>
      <Space direction="vertical" size={10} style={{ width: "100%" }}>
        <TalentSelect value={outTalent} onChange={setOutTalent} />
        <Space.Compact style={{ width: "100%" }}>
          <Select
            value={scene}
            onChange={setScene}
            options={SCENES.map((k) => ({ value: k, label: AI_OUTREACH_SCENE_LABELS[k] }))}
            style={{ width: "50%" }}
          />
          <div style={{ width: "50%" }}><JobSelect value={outJob} onChange={setOutJob} /></div>
        </Space.Compact>
        <AiResultCard
          key={`outreach-${outTalent || ""}-${scene}`}
          title={`跟进话术 · ${AI_OUTREACH_SCENE_LABELS[scene]}`}
          onGenerate={async () => {
            if (!outTalent) { message.warning("请先选择候选人"); return null; }
            return { ...(await api.aiOutreach({ talent_id: outTalent, job_id: outJob ?? null, scene })) };
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
    </Card>
  );

  const items = [
    canJobs ? { key: "jd", label: "写 JD", children: jdTab } : null,
    canTalents ? { key: "resume", label: "改简历", children: resumeTab } : null,
    canTalents ? { key: "outreach", label: "跟进话术", children: outreachTab } : null,
  ].filter(Boolean) as { key: string; label: string; children: React.ReactNode }[];

  return (
    <div className="page-fill">
      <Card className="list-card" title={<Space size={6}><RobotOutlined /><span>AI 助手</span></Space>}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 16 }}>
          AI 能力集中入口。所有内容均为 AI 生成的草稿，请核对后使用；系统不会自动发送或写入任何数据。
        </Typography.Paragraph>
        {items.length > 0 ? (
          <Tabs items={items} />
        ) : (
          <Alert
            type="info"
            showIcon
            message="当前账号暂无可用 AI 功能"
            description="AI 助手内的功能按权限展示：写 JD 需要「岗位管理」权限，改简历 / 跟进话术需要「人才库管理」权限。请联系管理员开通。"
          />
        )}
      </Card>
    </div>
  );
}

const pre: React.CSSProperties = {
  whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.7, fontSize: 13,
  margin: "4px 0 0", fontFamily: "inherit",
};
const line: React.CSSProperties = { lineHeight: 1.7, fontSize: 13 };
