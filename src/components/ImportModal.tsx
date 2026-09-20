import { useState, useRef } from "react";
import {
  Modal, Upload, Button, Alert, message, Table, Input, InputNumber, Select, Typography, Segmented, DatePicker,
} from "antd";
import { InboxOutlined, DeleteOutlined, UploadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import mammoth from "mammoth";
import { api } from "../api";
import { EDUCATION_OPTIONS, STATUS_LABELS } from "../types";
import {
  extractName, extractPhone, extractEmail, extractAge, extractBirthDate,
  extractTitle, extractCompany, extractSchool, extractCity, extractSkills,
  extractYearsExperience, extractPdfLines, normalizeEducation,
} from "../utils/resumeParser";

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

interface ParsedTalent {
  key: string;
  name: string;
  phone: string;
  email: string;
  age: number | null;
  education: string;
  school: string;
  current_company: string;
  current_title: string;
  years_experience: number | null;
  city: string;
  skills: string;
  status: string;
  notes: string;
  birth_date: string;
  contract_end: string;
  probation_end: string;
  resignation_date: string;
  fileName: string;
  file: File | null;
}

// JSON 导入示例（点「填入示例」填充）
const JSON_SAMPLE = `[
  {
    "name": "张三",
    "phone": "13800138000",
    "email": "zhangsan@example.com",
    "age": 28,
    "education": "本科",
    "school": "浙江大学",
    "current_company": "阿里巴巴",
    "current_title": "高级Java工程师",
    "years_experience": 6,
    "city": "杭州",
    "skills": ["Java", "Spring", "MySQL", "微服务"],
    "status": "active",
    "contract_end": "2026-12-31",
    "birth_date": "1996-05-12"
  }
]`;

// JSON 支持字段说明（与下方提示文案共用，避免两处不一致）
const JSON_FIELD_HINT =
  "name（必填）、phone、email、age、education、school、current_company、current_title、years_experience、city、skills（数组或逗号分隔）、status、notes、birth_date / contract_end / probation_end / resignation_date（YYYY-MM-DD，用于风险预警）";

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

// 从纯文本提取人才字段（全部委托给 resumeParser 模块）
function extractTalent(text: string, key: string, fileName: string, file: File | null): ParsedTalent {
  return {
    key,
    name: extractName(text, fileName),
    phone: extractPhone(text),
    email: extractEmail(text),
    age: extractAge(text),
    education: normalizeEducation(text),
    school: extractSchool(text),
    current_company: extractCompany(text),
    current_title: extractTitle(text),
    years_experience: extractYearsExperience(text),
    city: extractCity(text),
    skills: extractSkills(text),
    status: "active",
    notes: "",
    birth_date: extractBirthDate(text),
    contract_end: "",
    probation_end: "",
    resignation_date: "",
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
  const [importing, setImporting] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const parsingRef = useRef(false);
  // 行 key 全局递增：此前用批次内下标，分两次上传会生成重复 key，
  // 导致按 key 编辑/删除时同时命中多行。
  const keySeq = useRef(0);
  const nextKey = () => `row-${keySeq.current++}`;

  const handleFiles = async (files: File[]) => {
    if (parsingRef.current) return;
    parsingRef.current = true;
    setError("");
    setParsing(true);
    try {
      const parsed: ParsedTalent[] = [];
      for (const file of files) {
        const text = await parseFile(file);
        parsed.push(extractTalent(text, nextKey(), file.name, file));
      }
      setRecords((prev) => [...prev, ...parsed]);
      // 兜底提示：关键字段（姓名/手机号）未识别出来时提醒用户手动确认
      const missingName = parsed.filter((r) => !r.name).length;
      const missingPhone = parsed.filter((r) => !r.phone).length;
      const missing: string[] = [];
      if (missingName > 0) missing.push(`${missingName} 条缺少姓名`);
      if (missingPhone > 0) missing.push(`${missingPhone} 条缺少手机号`);
      if (missing.length > 0) {
        message.warning(`已解析 ${parsed.length} 份简历，其中 ${missing.join("、")}（已置空并标黄），请手动补充后再导入`, 6);
      } else {
        message.success(`已解析 ${parsed.length} 份简历，请核对信息后导入`);
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setParsing(false);
    parsingRef.current = false;
  };

  const handleBeforeUpload = (file: File) => {
    handleFiles([file]);
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
    // 日期统一规整成 YYYY-MM-DD，非法的置空由用户重新选
    const dateStr = (v: unknown) => {
      const s = str(v);
      const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : "";
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
        birth_date: dateStr(o.birth_date),
        contract_end: dateStr(o.contract_end),
        probation_end: dateStr(o.probation_end),
        resignation_date: dateStr(o.resignation_date),
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

  const handleImport = async () => {
    if (records.length === 0) return;
    setImporting(true);
    setError("");
    try {
      const data = records.map((r) => ({
        name: r.name,
        phone: r.phone || undefined,
        email: r.email || undefined,
        age: r.age ?? undefined,
        education: r.education || undefined,
        school: r.school || undefined,
        current_company: r.current_company || undefined,
        current_title: r.current_title || undefined,
        years_experience: r.years_experience ?? undefined,
        city: r.city || undefined,
        skills: r.skills ? r.skills.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [],
        status: r.status || "active",
        notes: r.notes || undefined,
        birth_date: r.birth_date || undefined,
        contract_end: r.contract_end || undefined,
        probation_end: r.probation_end || undefined,
        resignation_date: r.resignation_date || undefined,
      }));
      const res = await api.importTalents(data);
      message.success(`成功导入 ${res.imported} 条人才记录`);

      // 上传原始简历文件到 R2
      const createdItems = (res as any).items as { id: string; name: string }[] | undefined;
      if (createdItems && createdItems.length === records.length) {
        let uploaded = 0;
        for (let i = 0; i < createdItems.length; i++) {
          const rec = records[i];
          if (rec.file) {
            try {
              await api.uploadResume(createdItems[i].id, rec.file);
              uploaded++;
            } catch (e) {
              console.error(`上传简历失败: ${rec.fileName}`, e);
            }
          }
        }
        if (uploaded > 0) message.success(`${uploaded} 份简历已保存`);
      }

      setRecords([]);
      onSuccess();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
    setImporting(false);
  };

  // 关键字段（姓名/手机号）缺失时标黄提醒手动填写
  const missingStyle = (v: string) => (v ? {} : { status: "warning" as const });

  // 只有记录里真的带了日期才显示这 4 列（简历导入路径不会显示，保持表格不过宽）
  const hasDates = records.some(
    (r) => r.birth_date || r.contract_end || r.probation_end || r.resignation_date
  );

  const dateColumn = (title: string, field: keyof ParsedTalent, width = 130) => ({
    title,
    dataIndex: field,
    width,
    render: (v: string, r: ParsedTalent) => (
      <DatePicker
        size="small"
        value={v ? dayjs(v) : null}
        placeholder="选择日期"
        style={{ width: "100%" }}
        onChange={(d) => updateRecord(r.key, field, d ? d.format("YYYY-MM-DD") : "")}
      />
    ),
  });

  const baseWidth = 1520;

  const columns = [
    { title: "姓名", dataIndex: "name", width: 100, render: (v: string, r: ParsedTalent) => <Input size="small" value={v} placeholder="请输入姓名" {...missingStyle(v)} onChange={(e) => updateRecord(r.key, "name", e.target.value)} /> },
    { title: "手机号", dataIndex: "phone", width: 125, render: (v: string, r: ParsedTalent) => <Input size="small" value={v} placeholder="请输入手机号" {...missingStyle(v)} onChange={(e) => updateRecord(r.key, "phone", e.target.value)} /> },
    { title: "邮箱", dataIndex: "email", width: 175, render: (v: string, r: ParsedTalent) => <Input size="small" value={v} placeholder="请输入邮箱" onChange={(e) => updateRecord(r.key, "email", e.target.value)} /> },
    { title: "年龄", dataIndex: "age", width: 75, render: (v: number | null, r: ParsedTalent) => <InputNumber size="small" min={16} max={80} value={v ?? undefined} placeholder="年龄" onChange={(val) => updateRecord(r.key, "age", val ?? null)} style={{ width: "100%" }} /> },
    { title: "学历", dataIndex: "education", width: 110, render: (v: string, r: ParsedTalent) => <Select size="small" value={v || undefined} allowClear placeholder="请选择学历" onChange={(val) => updateRecord(r.key, "education", val || "")} options={EDUCATION_OPTIONS.map((e) => ({ label: e, value: e }))} style={{ width: "100%" }} /> },
    { title: "院校", dataIndex: "school", width: 140, render: (v: string, r: ParsedTalent) => <Input size="small" value={v} placeholder="请输入院校" onChange={(e) => updateRecord(r.key, "school", e.target.value)} /> },
    { title: "当前公司", dataIndex: "current_company", width: 140, render: (v: string, r: ParsedTalent) => <Input size="small" value={v} placeholder="请输入当前公司" onChange={(e) => updateRecord(r.key, "current_company", e.target.value)} /> },
    { title: "当前职位", dataIndex: "current_title", width: 130, render: (v: string, r: ParsedTalent) => <Input size="small" value={v} placeholder="请输入当前职位" onChange={(e) => updateRecord(r.key, "current_title", e.target.value)} /> },
    { title: "年限", dataIndex: "years_experience", width: 75, render: (v: number | null, r: ParsedTalent) => <InputNumber size="small" min={0} value={v ?? undefined} placeholder="年限" onChange={(val) => updateRecord(r.key, "years_experience", val ?? null)} style={{ width: "100%" }} /> },
    { title: "城市", dataIndex: "city", width: 90, render: (v: string, r: ParsedTalent) => <Input size="small" value={v} placeholder="请输入城市" onChange={(e) => updateRecord(r.key, "city", e.target.value)} /> },
    { title: "技能", dataIndex: "skills", width: 180, render: (v: string, r: ParsedTalent) => <Input size="small" value={v} onChange={(e) => updateRecord(r.key, "skills", e.target.value)} placeholder="技能，逗号分隔" /> },
    { title: "状态", dataIndex: "status", width: 130, render: (v: string, r: ParsedTalent) => <Select size="small" value={v} onChange={(val) => updateRecord(r.key, "status", val)} options={Object.entries(STATUS_LABELS).map(([k, label]) => ({ label, value: k }))} style={{ width: "100%" }} /> },
    ...(hasDates ? [
      dateColumn("合同到期", "contract_end"),
      dateColumn("试用期结束", "probation_end"),
      dateColumn("出生日期", "birth_date"),
      dateColumn("预计离职", "resignation_date"),
    ] : []),
    { title: "", key: "action", width: 50, fixed: "right" as const, render: (_: any, r: ParsedTalent) => <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => removeRecord(r.key)} /> },
  ];

  const scrollX = baseWidth + (hasDates ? 520 : 0);

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
            上传 PDF 或 Word（.docx）简历文件，系统会自动提取姓名、电话、邮箱、学历、院校、公司、职位、技能、出生日期等信息，核对无误后一键导入。原始简历文件会同时保存，可在人才详情页预览。
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
            粘贴 JSON 数组，或上传 <code>.json</code> 文件，适合从其他系统导出后批量迁移。读取后会进入下方表格，同样可以逐条修改再导入。
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

      {parsing && <Alert message="正在解析简历…" type="info" showIcon style={{ marginTop: 16, marginBottom: 16 }} />}
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
        <Button type="primary" onClick={handleImport} loading={importing} disabled={records.length === 0}>确认导入</Button>
      </div>
    </Modal>
  );
}
