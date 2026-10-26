import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  Card, Button, Input, Select, Upload, Space, Tag, message, Modal, Alert,
  Progress, Typography, Popconfirm,
} from "antd";
import {
  InboxOutlined, ArrowLeftOutlined, ThunderboltOutlined, DatabaseOutlined,
  UserSwitchOutlined, TrophyOutlined, CloseOutlined, ClearOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import { VERDICT_COLORS, PALETTE } from "../types";
import type { MatchProfile, MatchProfileLite, MatchResult, Talent } from "../types";
import { parseResumeToTalent, parseResumeFile, recordToData } from "../utils/resumeImport";
import type { ParsedTalent } from "../utils/resumeImport";
import MatchResultCard from "../components/MatchResultCard";
import MatchCompareMatrix from "../components/MatchCompareMatrix";
import type { MatrixCol } from "../utils/matchMatrix";
import TalentPickerModal from "../components/TalentPickerModal";
import AddToPipelineModal from "../components/AddToPipelineModal";
const { Dragger } = Upload;

/** 评估阶段轮换文案：每位候选人的评估都包含这三步，按时间片旋转，
 *  让用户感知到等待时间花在了哪里（单次评分是一次 AI 调用，无法拿到真实子阶段） */
const MATCH_PHASES = [
  "正在比对硬性条件：学历 / 年限 / 城市",
  "正在分析必备技能命中情况",
  "AI 正在综合撰写推荐理由与风险",
];

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
    major: t.major || "",
    current_company: t.current_company || "",
    current_title: t.current_title || "",
    years_experience: t.years_experience,
    city: t.city || "",
    skills: (t.skills || []).join(", "),
    status: t.status || "active",
    notes: t.notes || "",
    expected_salary: t.expected_salary || "",
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
    t.major ? `专业：${t.major}` : "",
    t.skills?.length ? `技能：${t.skills.join("、")}` : "",
    t.industry ? `行业：${t.industry}` : "",
    t.expected_salary ? `期望薪资：${t.expected_salary}` : "",
    t.notes ? `备注：${t.notes}` : "",
  ].filter(Boolean);
  lines.push("");
  lines.push("（说明：该候选人来自人才库，未存简历原文，以上内容仅为系统中已录入的字段信息，信息量有限）");
  return lines.join("\n");
}

// 人才AI匹配：选一个职位画像（含分级）+ 候选人 → 按匹配度排序 + 理由
export default function Match() {
  const navigate = useNavigate();
  const location = useLocation();
  // 身份档案（用于文案）；本页另有 `profile` = 选中的职位画像，别混用  // ---- 画像 ----
  // 下拉只存轻量画像（id/名称/城市/学历/有无 JD），不含 JD 原文——见 loadProfiles
  const [profiles, setProfiles] = useState<MatchProfileLite[]>([]);
  // 从画像列表点「去匹配」跳过来时，直接用路由 state 初始化选中的画像 id
  const [profileId, setProfileId] = useState<string | undefined>(
    () => (location.state as { profileId?: string } | null)?.profileId
  );
  // 入口来源判定：菜单进入（无路由 state）不显示返回按钮；从其他页面跳进来
  // （人才详情/人才库/画像/岗位/AI 助手/推进管道）一律显示返回，用 history 回退
  // 实现「从哪来回哪去」，不写死目标路由
  const navState = location.state as { talentId?: string; from?: string; profileId?: string } | null;
  const hasSource = !!navState;
  const backToTalents = !!navState?.talentId || navState?.from === "talents";
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

  // ---- 等待态增强（解析清单 / 评估骨架 / 耗时预估）----
  /** 解析进度清单：逐份状态，黑盒变白盒 */
  interface ParseJob { name: string; status: "pending" | "parsing" | "done" | "failed" }
  const [parseJobs, setParseJobs] = useState<ParseJob[]>([]);
  const [parseEta, setParseEta] = useState<number | null>(null);
  /** 正在评估的候选人 key（骨架卡标「评估中」用） */
  // 并发评估时可能同时有多位在进行，用数组记录：骨架卡据此分别显示「评估中」
  const [activeKeys, setActiveKeys] = useState<string[]>([]);
  /** 预计剩余秒数（按已完成条目的平均耗时外推） */
  const [eta, setEta] = useState<number | null>(null);
  /** 评估阶段轮换文案（每份评估都含这三步，按时间片旋转提示当前在做什么） */
  const [phase, setPhase] = useState(0);
  /** 候选人刚就绪时给「开始匹配」一次脉冲提示，提醒下一步点它 */
  const [justReady, setJustReady] = useState(false);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setPhase((p) => (p + 1) % 3), 5000);
    return () => window.clearInterval(id);
  }, [running]);

  // ---- 落地 ----
  const [importingKey, setImportingKey] = useState<string | null>(null);
  const [savedIds, setSavedIds] = useState<Record<string, string>>({});
  const [pipelineTalentId, setPipelineTalentId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Candidate | null>(null);

  // 完整画像（含 JD 原文）：/match/score 要用 jd_raw 拼 AI prompt，但下拉不需要。
  // 只在真正点「开始匹配」时按 id 取一份，避免每次进页面都传几百 KB。
  const [profileFull, setProfileFull] = useState<MatchProfile | null>(null);
  const [fullLoading, setFullLoading] = useState(false);

  const loadProfiles = async () => {
    try {
      setProfiles(await api.getMatchProfilesLite());
    } catch {
      // 画像列表拉取失败不影响使用
    }
  };

  /** 取选中画像的完整数据（已取过则复用；换画像会按 id 重新取） */
  const ensureFullProfile = async (): Promise<MatchProfile | null> => {
    if (!profileId) return null;
    if (profileFull && profileFull.id === profileId) return profileFull;
    setFullLoading(true);
    try {
      const full = await api.getMatchProfile(profileId);
      setProfileFull(full);
      return full;
    } catch (err) {
      message.error(`画像加载失败：${(err as Error).message}`);
      return null;
    } finally {
      setFullLoading(false);
    }
  };

  useEffect(() => {
    loadProfiles();
  }, []);

  const handleSelectProfile = (id?: string) => {
    setProfileId(id);
    // 换画像（或清空选择）后，旧结果自动标记过期：支持「匹配完一个岗位再匹配另一个」
    // 的连续操作——结果先留着可对比，也可用右上方「清除结果」一键清空
    if (Object.keys(results).length > 0) setStale(true);
  };

  // ---- 上传并解析简历 ----
  // 逐份串行解析：每完成一份立即加入候选列表（用户看着候选人在变多，不用干等最后一份），
  // 单份失败不影响其余；parseJobs 驱动左侧「正在解析 X/N」清单。
  const handleFiles = async (files: File[]) => {
    setParsing(true);
    setParseJobs(files.map((f) => ({ name: f.name, status: "pending" as const })));
    setParseEta(null);
    const t0 = Date.now();
    const added: Candidate[] = [];
    let missing = 0;
    let failed = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setParseJobs((prev) => prev.map((j, idx) => (idx === i ? { ...j, status: "parsing" } : j)));
      let cand: Candidate;
      try {
        const { talent, text } = await parseResumeToTalent(file, nextKey());
        cand = { key: talent.key, fileName: file.name, file, text, talent, source: "file" };
      } catch (err) {
        failed++;
        setParseJobs((prev) => prev.map((j, idx) => (idx === i ? { ...j, status: "failed" } : j)));
        message.error(`「${file.name}」解析失败：${(err as Error).message}`);
        continue;
      }
      added.push(cand);
      if (!cand.talent.name) missing++;
      setParseJobs((prev) => prev.map((j, idx) => (idx === i ? { ...j, status: "done" } : j)));
      setCandidates((prev) => [...prev, cand]);
      // 预估：已用时长 / 已完成数 × 剩余数
      const done = added.length + failed;
      const remain = files.length - done;
      if (remain > 0) setParseEta(Math.max(1, Math.round(((Date.now() - t0) / done) * remain / 1000)));
    }
    if (added.length > 0) {
      if (missing > 0) {
        message.warning(`已解析 ${added.length} 份，其中 ${missing} 份未识别出姓名，可在结果卡片里查看原文确认`);
      } else {
        message.success(`已解析 ${added.length} 份简历`);
      }
      setStale(true);
    }
    setParsing(false);
    // 候选人刚就绪：脉冲提醒点「开始匹配」（条件不满足就不打扰）
    if (profile && added.length > 0) {
      setJustReady(true);
      window.setTimeout(() => setJustReady(false), 4000);
    }
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
    setParseJobs(rows.map((t) => ({ name: t.name, status: "pending" as const })));
    setParseEta(null);
    const t0 = Date.now();
    let weakCount = 0;
    let done = 0;
    for (let i = 0; i < rows.length; i++) {
      const t = rows[i];
      setParseJobs((prev) => prev.map((j, idx) => (idx === i ? { ...j, status: "parsing" } : j)));
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
      const cand: Candidate = {
        key,
        fileName: t.name,
        file: null,
        text,
        talent: talentToParsed(t, key),
        source: "library",
        talentId: t.id,
      };
      done++;
      setParseJobs((prev) => prev.map((j, idx) => (idx === i ? { ...j, status: "done" } : j)));
      setCandidates((prev) => [...prev, cand]);
      setSavedIds((prev) => ({ ...prev, [key]: t.id }));
      const remain = rows.length - done;
      if (remain > 0) setParseEta(Math.max(1, Math.round(((Date.now() - t0) / done) * remain / 1000)));
    }
    setStale(true);
    if (weakCount > 0) {
      message.warning(`已加入 ${rows.length} 位，其中 ${weakCount} 位没存简历原文，只能按已录入字段比对，评分仅供参考`);
    } else {
      message.success(`已加入 ${rows.length} 位人选`);
    }
    setParsing(false);
    if (profile && rows.length > 0) {
      setJustReady(true);
      window.setTimeout(() => setJustReady(false), 4000);
    }
  };

  // 从人才详情「人才AI匹配」跳过来：路由 state 带 talentId，直接把该人才加进候选人
  // （否则用户到了本页还要手动点「从人才库添加」再找一遍，入口等于白加）
  const consumedTalentRef = useRef(false);
  useEffect(() => {
    const st = location.state as { talentId?: string } | null;
    if (!st?.talentId || consumedTalentRef.current) return;
    consumedTalentRef.current = true; // StrictMode 双跑 effect 时防重复加入
    (async () => {
      try {
        const t = await api.getTalent(st.talentId!);
        await addFromLibrary([t]);
      } catch {
        message.error("读取该候选人信息失败，请手动点「从人才库添加」");
      }
    })();
    // 只在进入页面那一刻消费一次 state；addFromLibrary 只用 setState，闭包捕获首帧即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // 清除上一次匹配结果：换岗位/换画像重来时，不用刷新页面就能清空右列
  // （只清结果，不动画像与候选人——换岗位只需另选画像，候选人通常还要复用）
  const clearResults = () => {
    setResults({});
    setEta(null);
    setActiveKeys([]);
    setProgress({ done: 0, total: 0, current: "" });
    setStale(false);
    message.success("已清除上次匹配结果，选好画像后重新开始");
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
    // 完整画像在这里才取：下拉用的是轻量列表，JD 原文只在评分时才需要
    const full = await ensureFullProfile();
    if (!full) return;

    setRunning(true);
    setResults({});
    setStale(false);
    setEta(null);
    setActiveKeys([]);
    const next: Record<string, MatchResult> = {};
    const failed: string[] = [];
    const t0 = Date.now();
    let done = 0;
    let cursor = 0;

    // 并发池：单次评分 1~2s，10 位串行要 15~20s，3 路并发能压到 5s 左右。
    // 仍是「完成一位立即写入结果」，界面保持逐条出分的观感。
    // ⚠️ 智谱免费档只有 1 并发，超出的请求会 429 并自动回落 DeepSeek（多花一点
    // token 换速度）；若想优先省钱，把 CONCURRENCY 调回 1 即可恢复串行。
    const CONCURRENCY = Math.min(3, candidates.length);

    const worker = async () => {
      while (cursor < candidates.length) {
        const cd = candidates[cursor++];
        setActiveKeys((prev) => [...prev, cd.key]);
        try {
          next[cd.key] = await api.scoreCandidate(full, {
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
          // 失败不打断其余：并发下逐条弹窗会刷屏，先收集、结束时统一提示
          failed.push(`${cd.talent.name || cd.fileName}：${(err as Error).message}`);
        } finally {
          setActiveKeys((prev) => prev.filter((k) => k !== cd.key));
        }
        done++;
        setProgress({ done, total: candidates.length, current: cd.talent.name || cd.fileName });
        // 预估：已用时长 / 已完成数 × 剩余数（并发下按完成数算，从第 2 位起才显示）
        const remain = candidates.length - done;
        if (done >= 2 && remain > 0) {
          setEta(Math.max(1, Math.round(((Date.now() - t0) / done) * remain / 1000)));
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    setProgress({ done: candidates.length, total: candidates.length, current: "" });
    setActiveKeys([]);
    setRunning(false);
    const okCount = Object.keys(next).length;
    if (failed.length > 0) {
      message.warning(`完成 ${okCount} 份，${failed.length} 份评估失败：${failed.join("；")}`, 6);
    } else {
      message.success(`匹配完成，共 ${okCount} 份`);
    }
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
      message.info("请先「录入人才库」，再加入招聘看板");
      return;
    }
    setPipelineTalentId(id);
  };

  // 一键生成面试跟进待办：预填该人才 + 匹配结论/建议追问，3 天后到期
  const handleCreateTask = async (cd: Candidate) => {
    const talentId = savedIds[cd.key];
    if (!talentId) {
      message.info("请先「录入人才库」，再生成面试待办");
      return;
    }
    const r = results[cd.key];
    const name = cd.talent.name || "候选人";
    const parts: string[] = [];
    if (r) {
      parts.push(`匹配结论：${r.score} 分（${r.verdict}）`);
      if (r.summary) parts.push(r.summary);
      if (r.questions?.length) parts.push(`建议追问：\n- ${r.questions.join("\n- ")}`);
    }
    const d = new Date(Date.now() + 3 * 86400000);
    const p = (n: number) => String(n).padStart(2, "0");
    const due = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    try {
      await api.createTask({
        talent_id: talentId,
        title: `面试跟进：${name}`,
        content: parts.join("\n") || null,
        due_date: due,
        priority: "normal",
        source: "system",
      });
      message.success(`已生成「${name}」的面试待办（${due} 到期），可在「待办日历」查看`);
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const ranked = candidates
    .filter((c) => results[c.key])
    .sort((a, b) => results[b.key].score - results[a.key].score);

  // 对比矩阵数据：与 ranked 同序（分数从高到低），评估进行中也实时增长。
  // 硬性条件的「实际值」优先取人才档案里的字段（那是候选人自己填的），
  // 档案没填才回落到 AI 判定时带回来的 actual。
  const matrixCols: MatrixCol[] = ranked.map((cd) => {
    const r = results[cd.key];
    const mustHit = r.hard?.must_skills?.hit ?? [];
    const mustMiss = r.hard?.must_skills?.miss ?? [];
    return {
      key: cd.key,
      name: cd.talent.name || cd.fileName || "未识别",
      sub: [cd.talent.current_company, cd.talent.current_title].filter(Boolean).join(" · ") || "—",
      score: r.score,
      verdict: r.verdict,
      skillHit: mustHit.length,
      skillTotal: mustHit.length + mustMiss.length,
      mustHit,
      mustMiss,
      niceHit: r.hard?.nice_skills?.hit ?? [],
      edu: { ok: r.hard?.education?.ok ?? null, actual: cd.talent.education || r.hard?.education?.actual || "" },
      years: {
        ok: r.hard?.years?.ok ?? null,
        actual: cd.talent.years_experience ?? r.hard?.years?.actual ?? null,
        over: r.hard?.years?.over,
      },
      city: { ok: r.hard?.city?.ok ?? null, actual: cd.talent.city || r.hard?.city?.actual || "" },
      salary: cd.talent.expected_salary || "",
      reasons: r.reasons ?? [],
      gaps: r.gaps ?? [],
      risks: r.risks ?? [],
      questions: r.questions ?? [],
    };
  });

  // 动态步骤引导：全页只保留这一条引导（落地场景、缺条件场景都收进这一条），
  // 避免多条 Alert 叠加让用户分不清重点
  const stepHint: string | null = !profile
    ? "第 1 步：在左侧「① 选择画像」里选中一个职位画像"
    : candidates.length === 0
      ? `第 2 步：添加候选人 —— 点「② 候选人」右上角的「从${"人才库"}添加」一键加入，或直接拖拽简历文件上传（就绪后点左下角「开始匹配」）`
      : running
        ? "正在评估中，请稍候…"
        : ranked.length === 0
          ? "第 3 步：就绪！点左下角「开始匹配」"
          : null;

  // 并发评估中的人名（最多 CONCURRENCY 位），用于进度条文案
  const activeNames = activeKeys.map((k) => {
    const c = candidates.find((x) => x.key === k);
    return c?.talent.name || c?.fileName || "未识别";
  });

  return (
    <div className="page-fill">
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 12 }}>
        {hasSource && (
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>
            {backToTalents ? "返回人才库" : "返回上一步"}
          </Button>
        )}
        <Typography.Title level={4} style={{ margin: 0 }}>人才AI匹配</Typography.Title>
        <Typography.Text type="secondary">
          选一份职位画像 + 候选人 → 按匹配度排序并给出理由
        </Typography.Text>
      </div>

      {/* 动态步骤引导：全页唯一引导条——当前卡在哪一步、下一步点哪 */}
      {stepHint && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={<span><b>当前该做什么：</b>{stepHint}</span>}
        />
      )}

      {/* 左右分栏：左侧「操作台」常驻（选画像 / 加人 / 开始匹配），右侧结果区随内容增长 */}
      <div className="match-layout">
        <div className="match-side">
          {/* ① 选择画像 */}
          <Card
            title={<Space size={6}>① 选择画像 {!profile ? <Tag color="orange">待选</Tag> : <Tag color="green">已选 ✓</Tag>}</Space>}
            size="small"
            style={{ marginBottom: 12 }}
          >
            <Select
              style={{ width: "100%" }}
              placeholder="选用一个职位画像（可输入职位名搜索）"
              value={profileId}
              onChange={handleSelectProfile}
              allowClear
              showSearch
              /* 职位名、画像名都能搜：下拉显示职位名，但用户可能只记得画像（配置）时的名字 */
              filterOption={(input, option) => {
                const p = profiles.find((x) => x.id === option?.value);
                if (!p) return false;
                return `${p.job_title || ""} ${p.name || ""}`.toLowerCase().includes(input.toLowerCase());
              }}
              options={profiles.map((p) => ({ label: p.job_title || p.name, value: p.id! }))}
            />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 6 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {profile
                  ? [
                      profile.job_title && `职位 ${profile.job_title}`,
                      profile.city && `城市 ${profile.city}`,
                      profile.education && `学历 ${profile.education}`,
                      profile.has_jd ? "已填招聘需求" : "无招聘需求",
                    ].filter(Boolean).join(" · ")
                  : "从下拉列表选一个画像开始"}
              </Typography.Text>
              <Button type="link" size="small" style={{ paddingInline: 0, flexShrink: 0 }} icon={<UserSwitchOutlined />} onClick={() => navigate("/profiles")}>管理画像</Button>
            </div>
          </Card>

          {/* ② 候选人 */}
          <Card
            title={<Space size={6}>② 候选人（{candidates.length} 位）{candidates.length === 0 ? <Tag color="orange">待添加</Tag> : <Tag color="green">已就绪 ✓</Tag>}</Space>}
            size="small"
            style={{ marginBottom: 12 }}
            extra={
              <Button size="small" icon={<DatabaseOutlined />} onClick={() => setPickerOpen(true)}>
                从{"人才库"}添加
              </Button>
            }
          >
            <Dragger
              multiple
              showUploadList={false}
              disabled={parsing}
              beforeUpload={handleBeforeUpload}
              className="match-drop"
            >
              <p className="ant-upload-drag-icon"><InboxOutlined /></p>
              <p className="ant-upload-text">点击或拖拽简历到此处</p>
              <p className="ant-upload-hint">支持 .pdf、.docx，可一次多份</p>
            </Dragger>

            {parsing && parseJobs.length > 0 && (
              <div className="match-parse">
                <div className="match-parse-head">
                  <span>正在解析 {parseJobs.filter((j) => j.status === "done" || j.status === "failed").length} / {parseJobs.length}</span>
                  {parseEta != null && <span>约还需 {parseEta} 秒</span>}
                </div>
                <div className="match-parse-list">
                  {parseJobs.map((j, i) => (
                    <div className="match-parse-item" key={i}>
                      <span className={`match-parse-icon is-${j.status}`}>
                        {j.status === "done" ? "✓" : j.status === "failed" ? "✕" : j.status === "parsing" ? <span className="match-spin" /> : "○"}
                      </span>
                      <span className="match-parse-name">{j.name}</span>
                      {j.status === "parsing" && <span className="match-parse-tag">解析中</span>}
                      {j.status === "failed" && <span className="match-parse-tag is-fail">失败</span>}
                    </div>
                  ))}
                </div>
                <div className="match-parse-bar">
                  <div style={{ width: `${Math.round((parseJobs.filter((j) => j.status === "done" || j.status === "failed").length / parseJobs.length) * 100)}%` }} />
                </div>
              </div>
            )}

            {candidates.length > 0 && (
              <div className="match-cand-list">
                {candidates.map((r) => (
                  <div className="match-cand" key={r.key} title={r.fileName}>
                    <span className="match-cand-name">{r.talent.name || "未识别"}</span>
                    <span className="match-cand-meta">
                      {[r.talent.years_experience != null ? `${r.talent.years_experience} 年` : "", r.talent.city].filter(Boolean).join(" · ")}
                    </span>
                    {r.source === "library"
                      ? <Tag color="blue" style={{ marginInlineEnd: 0 }}>{"库"}</Tag>
                      : <Tag style={{ marginInlineEnd: 0 }}>新</Tag>}
                    <Popconfirm title="移除这份简历？" okText="移除" cancelText="取消" onConfirm={() => removeCandidate(r.key)}>
                      <Button type="text" size="small" danger icon={<CloseOutlined />} />
                    </Popconfirm>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* 开始匹配：紧邻条件区，禁用原因就地说明（不再依赖顶部引导条猜缺什么））；
              候选人刚就绪时脉冲提示一次 */}
          <div className={`match-run${justReady ? " is-pulse" : ""}`}>
            <Button
              type="primary"
              block
              size="large"
              icon={<ThunderboltOutlined />}
              loading={running || fullLoading}
              disabled={running || fullLoading || !profile || candidates.length === 0}
              onClick={handleMatch}
            >
              开始匹配
            </Button>
            <div className="match-run-hint">
              {running
                ? "正在评估中，请稍候…"
                : !profile
                  ? "先选择职位画像"
                  : candidates.length === 0
                    ? "再添加至少 1 位候选人"
                    : `将评估 ${candidates.length} 位候选人`}
            </div>
          </div>
        </div>

        {/* ③ 匹配结果 */}
        <div className="match-main">
          <Card
            title={
              <Space size={6}>
                ③ 匹配结果
                {running ? <Tag color="blue">进行中</Tag> : ranked.length > 0 ? <Tag color="green">已完成 ✓</Tag> : <Tag color="orange">待开始</Tag>}
              </Space>
            }
            size="small"
            extra={
              Object.keys(results).length > 0 ? (
                <Button size="small" icon={<ClearOutlined />} disabled={running} onClick={clearResults}>
                  清除结果
                </Button>
              ) : null
            }
          >
        {/* 缺条件的原因由顶部唯一的「当前该做什么」引导条承担，这里只留一行浅色说明，不再重复 Alert */}
            {running && (
              <>
                <Progress
                  percent={progress.total ? Math.round((progress.done / progress.total) * 100) : 0}
                  format={() => `已完成 ${progress.done}/${progress.total}`}
                  style={{ marginBottom: 4 }}
                />
                <div className="match-run-meta">
                  <span>
                    {activeNames.length > 0
                      ? `正在评估：${activeNames.join("、")}`
                      : progress.done >= progress.total
                        ? "正在汇总结果…"
                        : "准备中"}
                  </span>
                  {eta != null && <span>预计还需约 {eta} 秒</span>}
                </div>
                <div className="match-phase">{MATCH_PHASES[phase]}</div>
              </>
            )}

        {stale && Object.keys(results).length > 0 && (
          <Alert
            message="画像或候选人有变动，下面的结果是上一次匹配产生的，建议重新匹配"
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
          />
        )}

        {ranked.length === 0 && !running && (
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            {!profile || candidates.length === 0
              ? "先按左侧操作台补齐画像和候选人，这里就能开始匹配了"
              : "点左侧「开始匹配」开始评估，结果会按匹配度从高到低排列。"}
          </Typography.Paragraph>
        )}

        {/* 结果概览：整体结论一眼可见（各档人数 + 最佳人选）；评估进行中只显示部分结果，不展示概览 */}
        {!running && ranked.length > 0 && (() => {
          const top = results[ranked[0].key];
          // 「不建议」不配皇冠：全员不达标时给「暂无达标人选」，不硬捧最佳
          const hasPick = top.verdict !== "不建议";
          return (
            <div className="match-overview-bar">
              <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>共评估</Typography.Text>
                <span style={{ fontSize: 20, fontWeight: 700 }}>{ranked.length}</span>
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>位</Typography.Text>
              </div>
              <div className="ov-divider" />
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
              {hasPick ? (
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                  <TrophyOutlined style={{ color: "#f59e0b" }} />
                  <Typography.Text type="secondary" style={{ fontSize: 13 }}>最佳人选</Typography.Text>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>
                    {ranked[0].talent.name || ranked[0].fileName}
                  </span>
                  <span
                    style={{
                      fontSize: 16, fontWeight: 700,
                      color: VERDICT_COLORS[top.verdict] || PALETTE.blue,
                    }}
                  >
                    {top.score} 分
                  </span>
                </div>
              ) : (
                <Typography.Text type="secondary" style={{ marginLeft: "auto", fontSize: 13 }}>
                  暂无达标人选
                </Typography.Text>
              )}
            </div>
          );
        })()}

        {/* 对比矩阵：维度做行、候选人做列（≥2 位才有对比意义）；评估进行中也实时增长 */}
        {matrixCols.length >= 2 && (
          <MatchCompareMatrix
            cols={matrixCols}
            title={profile?.job_title || profile?.name || "未命名画像"}
          />
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
            onCreateTask={() => handleCreateTask(cd)}
          />
        ))}

        {/* 等待位：未出分的候选人渲染骨架卡——总共几位、完成几位、正在评谁、还剩谁，一目了然 */}
        {running && candidates.filter((c) => !results[c.key]).map((cd) => (
          <div className="match-skel" key={cd.key}>
            <div className="match-skel-head">
              <span>{cd.talent.name || cd.fileName || "未识别"}</span>
              {activeKeys.includes(cd.key)
                ? <span className="match-skel-status">评估中…</span>
                : <span className="match-skel-status is-queue">排队中</span>}
            </div>
            <div className="match-skel-bars">
              <div />
              <div />
            </div>
          </div>
        ))}
          </Card>
        </div>
      </div>

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
        onSuccess={() => message.success("已加入招聘看板")}
      />
    </div>
  );
}
