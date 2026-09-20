import { useState, useRef } from "react";
import {
  Modal, Upload, Button, Alert, message, Table, Input, InputNumber, Select, Typography, Segmented, DatePicker,
} from "antd";
import { InboxOutlined, DeleteOutlined, UploadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import mammoth from "mammoth";
import { api } from "../api";
import { EDUCATION_OPTIONS, STATUS_LABELS } from "../types";

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

// 学历关键词（按优先级从高到低匹配），值映射到 EDUCATION_OPTIONS
const EDUCATION_KEYWORDS: [string, string][] = [
  ["博士后", "博士"],
  ["博士", "博士"],
  ["MBA", "MBA/EMBA"],
  ["EMBA", "MBA/EMBA"],
  ["硕士", "硕士"],
  ["研究生", "硕士"],
  ["本科", "本科"],
  ["大专", "大专"],
  ["专科", "大专"],
  ["中专", "中专"],
  ["高中", "高中及以下"],
];

const SKILL_KEYWORDS = [
  "Java", "Spring", "Spring Boot", "MySQL", "Redis", "Kafka", "RabbitMQ",
  "微服务", "Docker", "Kubernetes", "K8s", "Linux", "Python", "Go", "Golang",
  "React", "Vue", "Angular", "TypeScript", "JavaScript", "Node.js", "HTML",
  "CSS", "Flutter", "iOS", "Android", "Swift", "Kotlin", "C++", "C#", ".NET",
  "PHP", "Ruby", "Rust", "机器学习", "深度学习", "AI", "大数据", "Hadoop",
  "Spark", "Flink", "Hive", "SQL", "Oracle", "PostgreSQL", "MongoDB",
  "Elasticsearch", "Nginx", "Tomcat", "Git", "Jenkins", "CI/CD", "AWS",
  "阿里云", "腾讯云", "项目管理", "数据分析", "自动化测试", "Selenium",
  "JMeter", "Figma", "Photoshop", "Excel", "PPT", "Word",
];

const CITIES = [
  "北京", "上海", "广州", "深圳", "杭州", "成都", "武汉", "南京", "西安", "苏州",
  "天津", "重庆", "长沙", "青岛", "厦门", "郑州", "合肥", "福州", "济南", "大连",
  "宁波", "无锡", "佛山", "东莞", "昆明", "沈阳", "哈尔滨", "长春", "石家庄",
  "南昌", "贵阳", "南宁", "兰州", "太原", "乌鲁木齐", "呼和浩特", "银川", "西宁",
  "海口", "三亚", "珠海", "惠州", "中山", "泉州", "温州", "嘉兴", "绍兴", "台州",
  "金华", "常州", "南通", "徐州", "扬州", "烟台", "潍坊", "淄博",
];

// PDF 文本提取：pdfjs 按绘制顺序返回文字块，直接拼接会丢失换行，
// 导致"姓名：张三 男 28岁"这类行被整体抓走。按 y 坐标把文字块聚合回真实文本行。
function extractPdfLines(content: any): string[] {
  const lines: { y: number; items: { x: number; w: number; str: string }[] }[] = [];
  for (const it of content.items as any[]) {
    if (!("str" in it) || !it.str.trim()) continue;
    const y = Math.round(it.transform[5]);
    const x = it.transform[4];
    const w = it.width || 0;
    let line = lines.find((l) => Math.abs(l.y - y) < 3);
    if (!line) {
      line = { y, items: [] };
      lines.push(line);
    }
    line.items.push({ x, w, str: it.str });
  }
  // PDF 坐标系 y 向上，按 y 从大到小 = 页面从上到下
  lines.sort((a, b) => b.y - a.y);
  return lines.map((line) => {
    line.items.sort((a, b) => a.x - b.x);
    let s = "";
    let prevEnd = 0;
    for (const item of line.items) {
      // 根据 x 间距判断是否需要补空格：间距大说明是不同栏目，间距小说明是同一词被拆分
      const gap = item.x - prevEnd;
      if (s && gap > 2) s += " ";
      s += item.str;
      prevEnd = item.x + item.w;
    }
    return s.trim();
  }).filter(Boolean);
}

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

// 姓名校验：2-4 个中文字符，且排除常见非人名词汇（避免把"个人简历"等标题当成姓名）
const NAME_BLACKLIST = new Set([
  "简历", "个人简历", "求职简历", "应聘简历", "基本信息", "个人信息", "个人信息表",
  "求职意向", "自我评价", "工作经历", "教育经历", "项目经验", "技能特长", "联系方式",
  "先生", "女士", "姓名", "名字",
]);

function isValidName(s: string): boolean {
  return /^[一-龥·]{2,4}$/.test(s) && !NAME_BLACKLIST.has(s) && !s.includes("简历");
}

// 从文件名兜底提取姓名，如"张三-简历.pdf"、"李四_2026.docx"
function nameFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  for (const seg of base.split(/[-_—–\s（）()【】\[\]]+/)) {
    if (isValidName(seg)) return seg;
  }
  return "";
}

function extractName(text: string, fileName: string): string {
  // 1. "姓名：张三" 标签式（限定中文字符，避免抓到"张三 男 28岁"整行）
  const label = text.match(/(?:姓名|名字)\s*[:：]\s*([一-龥·]{2,4})/);
  if (label && isValidName(label[1])) return label[1];
  // 2. "张三（男）"/"张三 男" 式
  const gender = text.match(/([一-龥·]{2,4})\s*[（(]\s*(?:男|女)\s*[）)]/) ||
    text.match(/([一-龥·]{2,4})\s+(?:男|女)(?=[\s，,；;]|$)/m);
  if (gender && isValidName(gender[1])) return gender[1];
  // 3. 简历前 3 行中的独立姓名行（简历通常以姓名开头）
  const headLines = text.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3);
  for (const line of headLines) {
    if (isValidName(line)) return line;
  }
  // 4. 手机号前的中文姓名
  const beforePhone = text.match(/([一-龥·]{2,4})\s*(?:[（(][男女][）)])?\s*1[3-9][\d\s-]{9,12}/);
  if (beforePhone && isValidName(beforePhone[1])) return beforePhone[1];
  // 5. 文件名兜底
  return nameFromFileName(fileName);
}

// 手机号：兼容"138 0000 0000"/"138-0000-0000"分隔写法；
// 前后不能是数字，避免从 18 位身份证号中误截取 11 位
function extractPhone(text: string): string {
  const m = text.match(/(?<!\d)1[3-9][\d\s-]{8,11}\d(?!\d)/);
  if (!m) return "";
  const digits = m[0].replace(/\D/g, "");
  return /^1[3-9]\d{9}$/.test(digits) ? digits : "";
}

// 职位关键词后缀（长的在前优先匹配）
const TITLE_SUFFIXES = [
  "架构师", "工程师", "设计师", "分析师", "总监", "经理", "主管", "专员",
  "顾问", "负责人", "专家", "主任", "店长", "教师", "医生", "律师",
  "会计", "出纳", "运营", "编辑", "翻译", "助理", "实习生", "销售代表",
];

// 清洗职位：截到定界符为止，去掉"全职/兼职"等修饰和尾部杂讯
function cleanTitle(raw: string): string {
  let s = raw.split(/[\n\r，,；;、|｜/]/)[0].trim();
  s = s.replace(/^(?:全职|兼职|实习|期望)[:：]?\s*/, "");
  // 优先截到职位后缀词结束（避免"Java工程师 北京 3年"抓全）
  for (const suf of TITLE_SUFFIXES) {
    const idx = s.indexOf(suf);
    if (idx > 0) {
      s = s.slice(0, idx + suf.length);
      break;
    }
  }
  if (s.length > 24) s = s.slice(0, 24);
  return s;
}

function extractTitle(text: string): string {
  // 1. 标签式："期望职位：高级Java工程师"
  const label = text.match(/(?:期望职位|期望岗位|求职意向|意向岗位|意向职位|应聘职位|应聘岗位|现任职位|当前职位|职位|岗位|职务)\s*[:：]\s*([^\n\r]{2,30})/);
  if (label) {
    const cleaned = cleanTitle(label[1]);
    if (cleaned.length >= 2) return cleaned;
  }
  // 2. 逐行扫描包含职位后缀的短行（通常是工作经历里的职位行），排除公司名
  const suffixRe = new RegExp(`([一-龥A-Za-z0-9·+]{2,18}?(?:${TITLE_SUFFIXES.join("|")}))`);
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (l.length > 30) continue;
    const m = l.match(suffixRe);
    if (m && !/(?:公司|有限|集团|大学|学院)/.test(m[1])) return m[1];
  }
  return "";
}

function extractTalent(text: string, key: string, fileName: string, file: File | null): ParsedTalent {
  const t: ParsedTalent = {
    key,
    name: extractName(text, fileName),
    phone: extractPhone(text),
    email: "",
    age: null,
    education: "",
    school: "",
    current_company: "",
    current_title: extractTitle(text),
    years_experience: null,
    city: "",
    skills: "",
    status: "active",
    notes: "",
    birth_date: "",
    contract_end: "",
    probation_end: "",
    resignation_date: "",
    fileName,
    file,
  };

  const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (emailMatch) t.email = emailMatch[0];

  // 年龄：优先"年龄：28"，其次"28岁"，最后由出生年份推算
  const ageMatch = text.match(/年龄\s*[:：]?\s*(\d{1,2})/) || text.match(/(\d{1,2})\s*岁/);
  if (ageMatch) {
    const age = parseInt(ageMatch[1], 10);
    if (age >= 16 && age <= 80) t.age = age;
  }
  if (t.age == null) {
    const birthMatch = text.match(/(?:出生日期|出生年月|出生|生日)\s*[:：]?\s*(\d{4})/);
    if (birthMatch) {
      const age = new Date().getFullYear() - parseInt(birthMatch[1], 10);
      if (age >= 16 && age <= 80) t.age = age;
    }
  }

  // 学历：优先"学历：本科"式标注，其次全文关键词匹配
  const eduLabelMatch = text.match(/学历\s*[:：]?\s*([^\n\r，,]{2,10})/);
  const eduText = eduLabelMatch ? eduLabelMatch[1] : text;
  for (const [kw, mapped] of EDUCATION_KEYWORDS) {
    if (eduText.includes(kw)) { t.education = mapped; break; }
  }

  // 院校：优先"毕业院校：XX大学"，其次全文第一个"XX大学/学院"
  const schoolMatch =
    text.match(/(?:毕业院校|毕业学校|毕业大学|院校|学校)\s*[:：]\s*([^\n\r，,]{2,30})/) ||
    text.match(/([一-龥]{2,20}(?:大学|学院|职业技术学院|高等专科学校))/);
  if (schoolMatch) t.school = schoolMatch[1].trim();

  const companyMatch =
    text.match(/(?:所在公司|公司名称|公司)\s*[:：]\s*([^\n\r]{2,40})/) ||
    text.match(/(?:工作经历|工作经验)[^\n]*?\n\s*([\u4e00-\u9fa5A-Za-z0-9（）()]{2,40})/);
  if (companyMatch) t.current_company = companyMatch[1].trim();

  const expMatch = text.match(/(\d{1,2})\s*年(?:工作经验|工作经历|经验)/);
  if (expMatch) t.years_experience = parseInt(expMatch[1], 10);

  const cityMatch =
    text.match(/(?:现居|所在城市|城市|base)\s*[:：]?\s*([\u4e00-\u9fa5]{2,4})/) ||
    (() => {
      const found = CITIES.filter((c) => text.includes(c));
      return found.length ? [null, found[0]] as (string | null)[] : null;
    })();
  if (cityMatch && cityMatch[1]) t.city = cityMatch[1].replace(/[市省]$/, "");

  const found = SKILL_KEYWORDS.filter((s) => text.includes(s));
  t.skills = [...new Set(found)].join(", ");

  return t;
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
            上传 PDF 或 Word（.docx）简历文件，系统会自动提取姓名、电话、邮箱、公司、职位等信息，核对无误后一键导入。原始简历文件会同时保存，可在人才详情页预览。
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
