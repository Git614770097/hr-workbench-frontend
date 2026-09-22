import { useState, useEffect, useRef } from "react";
import {
  Modal, Upload, Button, Alert, message, Table, Input, Typography, Segmented, Tooltip, Tag,
} from "antd";
import { InboxOutlined, DeleteOutlined, UploadOutlined, EyeOutlined } from "@ant-design/icons";
import mammoth from "mammoth";
import { api } from "../api";
import { STATUS_LABELS } from "../types";
import ImportPreviewModal from "./ImportPreviewModal";
import {
  extractName, extractPhone, extractEmail, extractAge, extractGender,
  extractTitle, extractCompany, extractSchool, extractCity, extractSkills,
  extractYearsExperience, extractPdfLines, normalizeEducation,
} from "../utils/resumeParser";
import { sanitizeField, sanitizeSkills } from "../utils/fieldSanity";

const { Dragger } = Upload;

// PDF.js 本地打包 + 按需动态加载：
// 1) 不再依赖 CDN，避免国内网络下 jsdelivr 不稳定导致"PDF.js 加载失败"
// 2) 动态 import 让 pdfjs 单独分包，只在导入简历时才下载，不影响首屏速度
let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    });
  }
  return pdfjsPromise;
}

export interface ParsedTalent {
  key: string;
  name: string;
  phone: string;
  email: string;
  age: number | null;
  gender: string;
  education: string;
  school: string;
  current_company: string;
  current_title: string;
  years_experience: number | null;
  city: string;
  skills: string;
  status: string;
  notes: string;
  fileName: string;
  file: File | null;
  /** 解析来源：true=AI 解析，false=本地规则回退，undefined=JSON 手工导入 */
  _ai?: boolean;
}

// JSON 导入示例（点「填入示例」填充）
const JSON_SAMPLE = `[
  {
    "name": "张三",
    "phone": "13800138000",
    "email": "zhangsan@example.com",
    "age": 28,
    "gender": "男",
    "education": "本科",
    "school": "浙江大学",
    "current_company": "阿里巴巴",
    "current_title": "高级Java工程师",
    "years_experience": 6,
    "city": "杭州",
    "skills": ["Java", "Spring", "MySQL", "微服务"],
    "status": "active"
  }
]`;

// JSON 支持字段说明（与下方提示文案共用，避免两处不一致）
const JSON_FIELD_HINT =
  "name（必填）、phone、email、age、gender（男/女）、education、school、current_company、current_title、years_experience、city、skills（数组或逗号分隔）、status、notes";

const STATUS_KEYS = Object.keys(STATUS_LABELS);

// 解析单个文件为文本（PDF 用 pdfjs 按坐标还原行，Word 用 mammoth 提取）
async function parseFile(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) {
    const pdfjsLib = await loadPdfjs();
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += extractPdfLines(content).join("\n") + "\n";
    }
    return text;
  }
  if (name.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }
  throw new Error(`不支持的文件格式：${file.name}，请上传 PDF 或 Word（.docx）文件`);
}

// 从纯文本提取人才字段（本地规则引擎，作为兜底）
// 结果再过一遍 sanitizeField：规则引擎偶有误判（如把城市当姓名），
// 与 AI 通道用同一套校验，保证两条路径都不会产出"看起来有值"的脏数据。
function extractTalentLocal(text: string, key: string, fileName: string, file: File | null): ParsedTalent {
  return {
    key,
    name: sanitizeField("name", extractName(text)),
    phone: extractPhone(text),
    email: extractEmail(text),
    age: extractAge(text),
    gender: extractGender(text),
    education: normalizeEducation(text),
    school: sanitizeField("school", extractSchool(text)),
    current_company: sanitizeField("current_company", extractCompany(text)),
    current_title: sanitizeField("current_title", extractTitle(text)),
    years_experience: extractYearsExperience(text),
    city: sanitizeField("city", extractCity(text)),
    skills: sanitizeSkills(extractSkills(text).split(/[,，、/]+/)).join(", "),
    status: "active",
    notes: "",
    fileName,
    file,
  };
}

// AI 解析结果 → ParsedTalent（AI 优先，缺失字段用本地规则兜底）
function extractTalentWithAI(
  text: string,
  ai: Awaited<ReturnType<typeof api.parseResume>>,
  local: ParsedTalent,
  key: string,
  fileName: string,
  file: File | null
): ParsedTalent {
  const skills = ai.skills?.length
    ? ai.skills.join(", ")
    : local.skills;
  return {
    key,
    name: ai.name || local.name,
    phone: ai.phone || local.phone,
    email: ai.email || local.email,
    age: ai.age ?? local.age,
    gender: ai.gender || local.gender,
    education: ai.education || local.education,
    school: ai.school || local.school,
    current_company: ai.current_company || local.current_company,
    current_title: ai.current_title || local.current_title,
    years_experience: ai.years_experience ?? local.years_experience,
    city: ai.city || local.city,
    skills,
    status: "active",
    notes: "",
    fileName,
    file,
  };
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function ImportModal({ open, onClose, onSuccess }: Props) {
  const [mode, setMode] = useState<"resume" | "json">("resume");
  const [parsing, setParsing] = useState(false);
  const [records, setRecords] = useState<ParsedTalent[]>([]);
  const [error, setError] = useState("");
  const [jsonText, setJsonText] = useState("");
  const parsingRef = useRef(false);
  // 多文件选择的缓冲：beforeUpload 对每个文件同步调用一次，先用队列收齐，再统一解析
  const pendingFilesRef = useRef<File[]>([]);
  // 行 key 全局递增：此前用批次内下标，分两次上传会生成重复 key，
  // 导致按 key 编辑/删除时同时命中多行。
  const keySeq = useRef(0);
  const nextKey = () => `row-${keySeq.current++}`;

  // 逐份核对：reviewKey 指向当前正在核对的记录（null 表示未打开）
  const [reviewKey, setReviewKey] = useState<string | null>(null);
  const [savingOne, setSavingOne] = useState(false);

  // 组件常驻（父级只切换 open），每次打开都从干净状态开始，
  // 避免上次没处理完的解析记录/核对弹窗残留到下一次导入。
  useEffect(() => {
    if (!open) return;
    setMode("resume");
    setParsing(false);
    setRecords([]);
    setError("");
    setJsonText("");
    setReviewKey(null);
    setSavingOne(false);
    pendingFilesRef.current = [];
  }, [open]);

  const handleFiles = async (files: File[]) => {
    if (parsingRef.current) return;
    parsingRef.current = true;
    setError("");
    setParsing(true);
    try {
      const parsed: ParsedTalent[] = [];
      for (const file of files) {
        const text = await parseFile(file);
        const local = extractTalentLocal(text, nextKey(), file.name, file);
        // AI 优先解析，失败或超时自动回退到本地规则
        let result = local;
        let aiUsed = false;
        try {
          const ai = await Promise.race([
            api.parseResume(text),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("AI 解析超时")), 20000)
            ),
          ]);
          result = extractTalentWithAI(text, ai, local, local.key, file.name, file);
          aiUsed = true;
        } catch (err) {
          // AI 失败（无 key/超时/网络/解析异常）静默回退本地规则
          console.warn(`AI 解析失败，回退本地规则：${file.name}`, err);
        }
        // 标记是否用 AI 解析（用于列表/核对弹窗提示）
        result._ai = aiUsed;
        parsed.push(result);
      }
      setRecords((prev) => [...prev, ...parsed]);
      // 简历模式下解析完自动进入逐份核对（从第一份开始）
      if (parsed.length > 0 && parsed[0].file) {
        setReviewKey((cur) => cur ?? parsed[0].key);
      }
      // 兜底提示：关键字段（姓名/手机号）未识别出来时提醒用户手动确认
      const missingName = parsed.filter((r) => !r.name).length;
      const missingPhone = parsed.filter((r) => !r.phone).length;
      const aiCount = parsed.filter((r) => r._ai).length;
      const localCount = parsed.length - aiCount;
      const missing: string[] = [];
      if (missingName > 0) missing.push(`${missingName} 条缺少姓名`);
      if (missingPhone > 0) missing.push(`${missingPhone} 条缺少手机号`);
      const srcNote = `AI ${aiCount} 份 / 本地规则 ${localCount} 份`;
      if (missing.length > 0) {
        message.warning(`已解析 ${parsed.length} 份简历（${srcNote}），其中 ${missing.join("、")}（已置空并标黄），请逐份核对补充后再录入`, 6);
      } else {
        message.success(`已解析 ${parsed.length} 份简历（${srcNote}），请逐份核对后录入`);
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setParsing(false);
    parsingRef.current = false;
  };

  const handleBeforeUpload = (file: File) => {
    pendingFilesRef.current.push(file);
    // beforeUpload 对同一批选择的多个文件是同步依次调用的，
    // 用 setTimeout(0) 把"统一解析"推迟到本轮同步调用全部结束后，一次性处理所有文件
    setTimeout(() => {
      if (pendingFilesRef.current.length === 0) return;
      const files = pendingFilesRef.current;
      pendingFilesRef.current = [];
      handleFiles(files);
    }, 0);
    return false;
  };

  // JSON 记录 → 统一的待核对行（与简历解析结果共用同一张表格和导入逻辑）
  const jsonToRecords = (text: string): ParsedTalent[] => {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("JSON 格式有误，请检查括号、引号是否成对完整");
    }
    const arr = Array.isArray(data) ? data : [data];
    if (arr.length === 0) throw new Error("JSON 里没有可导入的记录");

    const str = (v: unknown) =>
      typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
    const num = (v: unknown) => {
      const n = typeof v === "number" ? v : parseInt(str(v), 10);
      return Number.isFinite(n) ? n : null;
    };

    return arr.map((raw) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      const skillsRaw = o.skills;
      return {
        key: nextKey(),
        name: str(o.name),
        phone: str(o.phone),
        email: str(o.email),
        age: num(o.age),
        gender: str(o.gender),
        education: str(o.education),
        school: str(o.school),
        current_company: str(o.current_company),
        current_title: str(o.current_title),
        years_experience: num(o.years_experience),
        city: str(o.city),
        skills: Array.isArray(skillsRaw)
          ? skillsRaw.map(str).filter(Boolean).join(", ")
          : str(skillsRaw),
        status: STATUS_KEYS.includes(str(o.status)) ? str(o.status) : "active",
        notes: str(o.notes),
        fileName: "",
        file: null,
      };
    });
  };

  const handleJsonParse = () => {
    setError("");
    if (!jsonText.trim()) {
      setError("请先粘贴 JSON 内容，或上传 .json 文件");
      return;
    }
    try {
      const parsed = jsonToRecords(jsonText);
      setRecords((prev) => [...prev, ...parsed]);
      const missingName = parsed.filter((r) => !r.name).length;
      if (missingName > 0) {
        message.warning(`已读取 ${parsed.length} 条记录，其中 ${missingName} 条缺少姓名（必填，已标黄），请补全后导入`, 6);
      } else {
        message.success(`已读取 ${parsed.length} 条记录，请核对后导入`);
      }
      // 读完即清空，避免重复点击造成重复记录
      setJsonText("");
      // 与简历模式一致：读进来直接进入逐份核对，只有一条录入路径
      if (parsed.length > 0) setReviewKey((cur) => cur ?? parsed[0].key);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleJsonFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (ev) => setJsonText(String(ev.target?.result ?? ""));
    reader.readAsText(file);
    return false;
  };

  const updateRecord = (key: string, field: keyof ParsedTalent, value: any) => {
    setRecords((prev) => prev.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  };

  const removeRecord = (key: string) => {
    setRecords((prev) => prev.filter((r) => r.key !== key));
  };

  // 记录 → 导入接口入参（批量导入与逐份核对共用，避免两处不一致）
  const recordToData = (r: ParsedTalent) => ({
    name: r.name,
    phone: r.phone || undefined,
    email: r.email || undefined,
    age: r.age ?? undefined,
    gender: r.gender || undefined,
    education: r.education || undefined,
    school: r.school || undefined,
    current_company: r.current_company || undefined,
    current_title: r.current_title || undefined,
    years_experience: r.years_experience ?? undefined,
    city: r.city || undefined,
    skills: r.skills ? r.skills.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [],
    status: r.status || "active",
    notes: r.notes || undefined,
  });

  // 当前正在核对的记录
  const reviewRecord = records.find((r) => r.key === reviewKey) || null;
  const reviewIndex = reviewRecord ? records.findIndex((r) => r.key === reviewRecord.key) : 0;

  // 逐份核对：保存单条（写入人才库 + 保存原始简历）
  const saveRecord = async (rec: ParsedTalent) => {
    const res = await api.importTalents([recordToData(rec)]);
    const created = ((res as any).items as { id: string }[] | undefined)?.[0];
    if (created && rec.file) {
      try {
        await api.uploadResume(created.id, rec.file);
      } catch (e) {
        console.error(`上传简历失败: ${rec.fileName}`, e);
        message.warning("简历文件保存失败，可稍后在人才详情页重新上传");
      }
    }
  };

  // 处理完当前记录后从队列移除并切到下一份；若全部处理完，关闭整个导入弹窗
  const advanceReview = (key: string) => {
    const idx = records.findIndex((r) => r.key === key);
    const remaining = records.filter((r) => r.key !== key);
    if (remaining.length === 0) {
      setRecords([]);
      setReviewKey(null);
      message.success("已处理完全部简历");
      onClose();
      return;
    }
    const next = remaining[Math.min(Math.max(idx, 0), remaining.length - 1)];
    setRecords(remaining);
    setReviewKey(next.key);
  };

  const handleSaveOne = async () => {
    const rec = reviewRecord;
    if (!rec) return;
    if (!rec.name.trim()) {
      message.error("请先填写姓名再录入");
      return;
    }
    // 手机号查重：命中已有记录时先让用户确认，避免同一个人重复入库
    if (rec.phone.trim()) {
      try {
        const dup = await api.getTalents({ phone: rec.phone.trim(), page: 1, limit: 5 });
        const hit = dup.items.find((t) => (t.phone || "") === rec.phone.trim());
        if (hit) {
          const ok = await new Promise<boolean>((resolve) => {
            Modal.confirm({
              title: "可能重复录入",
              content: `手机号 ${rec.phone} 已存在人才「${hit.name}」，仍要再录一条吗？`,
              okText: "仍然录入",
              cancelText: "返回修改",
              onOk: () => resolve(true),
              onCancel: () => resolve(false),
            });
          });
          if (!ok) return;
        }
      } catch {
        // 查重尽力而为，接口异常不阻断正常录入
      }
    }
    setSavingOne(true);
    setError("");
    try {
      await saveRecord(rec);
      message.success(`已录入「${rec.name || rec.fileName || "未命名"}」（第 ${reviewIndex + 1}/${records.length} 份）`);
      onSuccess();
      advanceReview(rec.key);
    } catch (err) {
      setError((err as Error).message);
    }
    setSavingOne(false);
  };

  const handleSkipOne = () => {
    const rec = reviewRecord;
    if (!rec) return;
    message.info(`已移除「${rec.name || rec.fileName || "未命名"}」`);
    advanceReview(rec.key);
  };

  // 关闭核对弹窗：回到批量列表时明确告知还有几份没核对，
  // 否则用户面对的只有「全部导入」这一个主按钮，会误以为必须先点它。
  const handleCloseReview = () => {
    setReviewKey(null);
    if (records.length > 0) {
      message.info(`还有 ${records.length} 份未核对，点右下角「继续核对」回到核对界面逐份确认后再录入`, 5);
    }
  };

  // 继续核对：从第一份未处理的开始
  const continueReview = () => {
    if (records.length === 0) return;
    setReviewKey(records[0].key);
  };

  // 列表只做进度展示：字段一律在核对弹窗里改，
  // 避免「表格和弹窗两处都能改、不知道哪个算数」的割裂。
  const dash = <Typography.Text type="secondary">—</Typography.Text>;

  const columns = [
    {
      title: "姓名", dataIndex: "name", width: 110,
      render: (v: string) => (v ? v : <Typography.Text type="danger">待填写</Typography.Text>),
    },
    { title: "手机号", dataIndex: "phone", width: 130, render: (v: string) => v || dash },
    { title: "当前公司", dataIndex: "current_company", width: 200, render: (v: string) => v || dash },
    { title: "当前职位", dataIndex: "current_title", width: 170, render: (v: string) => v || dash },
    { title: "状态", dataIndex: "status", width: 90, render: (v: string) => STATUS_LABELS[v] || v },
    { title: "来源", key: "parseSource", width: 80, render: (_: any, r: ParsedTalent) => (
      <Tooltip title={r._ai === true ? "AI 解析" : r._ai === false ? "本地规则解析（AI 失败回退，建议重点核对）" : "JSON 手工导入"}>
        {r._ai === true
          ? <Tag color="green" style={{ marginInlineEnd: 0 }}>AI</Tag>
          : r._ai === false
            ? <Tag color="orange" style={{ marginInlineEnd: 0 }}>本地</Tag>
            : <Tag style={{ marginInlineEnd: 0 }}>手工</Tag>}
      </Tooltip>
    ) },
    { title: "", key: "action", width: 150, render: (_: any, r: ParsedTalent) => (
      <span style={{ display: "inline-flex", gap: 2 }}>
        <Tooltip title="打开核对">
          <Button type="text" size="small" icon={<EyeOutlined />} onClick={() => setReviewKey(r.key)}>核对</Button>
        </Tooltip>
        <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => removeRecord(r.key)}>移除</Button>
      </span>
    ) },
  ];

  const scrollX = 930;

  return (
    <Modal title="批量导入人才" open={open} onCancel={onClose} width={1100} destroyOnClose footer={null}>
      <Segmented
        value={mode}
        onChange={(v) => { setMode(v as "resume" | "json"); setError(""); }}
        options={[
          { label: "📄 简历文件", value: "resume" },
          { label: "{ } JSON 粘贴", value: "json" },
        ]}
        style={{ marginBottom: 16 }}
      />

      {mode === "resume" ? (
        <>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            上传 PDF 或 Word（.docx）简历，系统自动提取姓名、电话、公司、职位等信息，然后<b>逐份核对</b>：
            左边看简历原文，右边改字段。点「保存并录入」立刻写入人才库并保存原始简历，不想要的点「移除」。
            全部处理完自动结束——<b>这是唯一的录入方式</b>，不再有一键批量导入。
          </Typography.Paragraph>

          <Dragger accept=".pdf,.docx" multiple showUploadList={false} disabled={parsing} beforeUpload={handleBeforeUpload} style={{ marginBottom: 16 }}>
            <p className="ant-upload-drag-icon"><InboxOutlined /></p>
            <p className="ant-upload-text">点击或拖拽简历文件到此处</p>
            <p className="ant-upload-hint">支持 .pdf、.docx 格式，可一次上传多份</p>
          </Dragger>
        </>
      ) : (
        <>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            粘贴 JSON 数组，或上传 <code>.json</code> 文件，适合从其他系统导出后批量迁移。读取后同样进入逐份核对。
          </Typography.Paragraph>

          <Upload accept=".json" showUploadList={false} beforeUpload={handleJsonFile}>
            <Button icon={<UploadOutlined />} style={{ marginBottom: 12 }}>上传 JSON 文件</Button>
          </Upload>

          <Input.TextArea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder={`在此粘贴 JSON 数组，例如：\n\n${JSON_SAMPLE}`}
            style={{ fontFamily: "monospace", fontSize: 12 }}
          />

          <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Button type="primary" onClick={handleJsonParse} disabled={!jsonText.trim()}>
              读取到下方列表
            </Button>
            <Button onClick={() => setJsonText(JSON_SAMPLE)}>填入示例</Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              支持字段：{JSON_FIELD_HINT}
            </Typography.Text>
          </div>
        </>
      )}

      {parsing && <Alert message="AI 识别中…" type="info" showIcon style={{ marginTop: 16, marginBottom: 16 }} />}
      {error && <Alert message={error} type="error" showIcon style={{ marginTop: 16, marginBottom: 16 }} />}

      {records.length > 0 && (
        <>
          <Typography.Text strong style={{ display: "block", marginBottom: 8 }}>
            待导入记录（{records.length} 条，可直接修改后导入）
          </Typography.Text>
          <Table columns={columns} dataSource={records} rowKey="key" size="small" pagination={false} scroll={{ x: scrollX }} />
        </>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <Button onClick={onClose}>取消</Button>
        <Button type="primary" onClick={continueReview} disabled={records.length === 0}>
          继续核对（还有 {records.length} 份）
        </Button>
      </div>

      {/* 逐份核对弹窗：左侧简历原文，右侧可改字段，保存才录入 */}
      <ImportPreviewModal
        record={reviewRecord}
        index={reviewIndex}
        total={records.length}
        saving={savingOne}
        onChange={(field, value) => { if (reviewRecord) updateRecord(reviewRecord.key, field, value); }}
        onSave={handleSaveOne}
        onSkip={handleSkipOne}
        onClose={handleCloseReview}
      />
    </Modal>
  );
}
