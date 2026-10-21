import { useState, useEffect, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Card, Table, Input, InputNumber, Select, Button, Space, Tag,
  Popconfirm, message, Dropdown, Alert, Modal, Empty,
  Checkbox, Popover, Tooltip,
} from "antd";
import {
  ImportOutlined, FilePdfOutlined, ExportOutlined,
  SearchOutlined, ReloadOutlined, DownOutlined, UpOutlined,
  FileWordOutlined, PlusOutlined,
  FileExcelOutlined, SettingOutlined, RobotOutlined,
} from "@ant-design/icons";
import type { MenuProps } from "antd";
import { api } from "../api";
import AiThinking from "../components/AiThinking";
import { TypeText } from "../utils/useTypewriter";
import type { Talent, User, ComplianceItem, ComplianceResponse, AiTalentInventory } from "../types";
import {
  STATUS_LABELS, STATUS_COLORS,
  ENTRY_TYPE_LABELS, ENTRY_TYPE_COLORS, ENTRY_TYPE_OPTIONS,
} from "../types";
import ImportModal from "../components/ImportModal";
import ResumePreviewModal from "../components/ResumePreviewModal";
import TalentFormModal from "../components/TalentFormModal";
import { useDict } from "../dict";
import { registerOnbFill } from "../components/onboardingAutoFill";

// 搜索条件（draft = 编辑中，applied = 已生效）
interface Filters {
  name: string;
  phone: string;
  education: string[];      // 多选：任一命中即算（逗号串传给后端）
  city: string[];           // 多选：城市自由文本
  major: string;
  years_min: number | null;
  years_max: number | null;
  age_min: number | null;
  age_max: number | null;
  title: string;
  status: string;
  owner_id: string;
  entry_type: string;
  tags: string;
  group: string;
}

const EMPTY_FILTERS: Filters = {
  name: "", phone: "", education: [], city: [], major: "",
  years_min: null, years_max: null, age_min: null, age_max: null,
  title: "", status: "", owner_id: "", entry_type: "", tags: "", group: "all",
};

// 人才库快捷分组：点击即筛选，复用列表查询的 group 参数。
// 与「状态」下拉互斥——点分组会清空 status，避免两个条件叠加。
const GROUP_OPTIONS = [
  { label: "全部", value: "all" },
  { label: "招聘进行中", value: "active_pipeline" },
  { label: "面试过的", value: "interviewed" },
  { label: "已入职", value: "placed" },
  { label: "已离职", value: "left" },
  { label: "已淘汰·放弃", value: "ended" },
  { label: "待激活", value: "inactive" },
];

// 搜索条件 → 查询参数。列表查询与导出共用一份，
// 避免两处各写一遍导致「导出的数据和列表看到的不一致」。
function buildFilterParams(f: Filters): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  if (f.name) params.name = f.name;
  if (f.phone) params.phone = f.phone;
  if (f.education.length) params.education = f.education.join(",");
  if (f.city.length) params.city = f.city.join(",");
  if (f.major) params.major = f.major;
  if (f.years_min != null) params.years_min = f.years_min;
  if (f.years_max != null) params.years_max = f.years_max;
  if (f.age_min != null) params.age_min = f.age_min;
  if (f.age_max != null) params.age_max = f.age_max;
  if (f.title) params.title = f.title;
  if (f.status) params.status = f.status;
  if (f.owner_id) params.owner_id = f.owner_id;
  if (f.entry_type) params.entry_type = f.entry_type;
  if (f.tags) params.tags = f.tags;
  // 快捷分组：与 status 互斥（applied.status 在切分组时已清空；后端也以 group 优先）
  if (f.group && f.group !== "all") params.group = f.group;
  return params;
}

// 收起时展示的字段数（默认展开一行 4 个）
const COLLAPSED_COUNT = 4;

// 列表每页条数
const PAGE_SIZE = 10;

// ---- 列显隐配置（姓名 / 操作列固定显示，其余可勾选，存 localStorage 跨会话记住）----
// 顺序即列顺序；label 与列头一致
const OPTIONAL_COL_LABELS: Record<string, string> = {
  current_title: "职位",
  years_experience: "年限",
  age: "年龄",
  education: "学历",
  school: "院校",
  major: "专业",
  city: "城市",
  phone: "手机号",
  email: "邮箱",
  status: "状态",
  entry_type: "来源",
  tags: "标签",
  owner_name: "创建人",
};
const OPTIONAL_COL_ORDER = Object.keys(OPTIONAL_COL_LABELS);
// 保存的常用搜索（名称 + 一组筛选条件），存 localStorage 跨会话复用
interface SavedSearch { name: string; filters: Filters; }
const SAVED_SEARCHES_KEY = "talent_list_saved_searches";
// 默认只显示高频列：低频字段（年龄/院校/城市/邮箱）按需在「列设置」里打开
const DEFAULT_VISIBLE_COLS = ["current_title", "years_experience", "education", "phone", "status", "entry_type", "tags"];
const COLS_STORAGE_KEY = "talent_list_visible_cols";

import { escapeHtml, downloadBlob, dateStamp, exportXlsx } from "../utils/file";
import { useIdentityProfile } from "../useIdentity";
import { termFor } from "../identityProfiles";

export default function TalentList() {
  const profile = useIdentityProfile();
  const navigate = useNavigate();
  const { education: educationOptions } = useDict();
  const [talents, setTalents] = useState<Talent[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  // 每页条数 + 列表排序（受控，配合后端 sort/order 白名单）
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [sortField, setSortField] = useState<string>("");
  const [sortOrder, setSortOrder] = useState<"ascend" | "descend" | "">("");
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [expanded, setExpanded] = useState(false);

  // 弹窗状态
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [previewTalent, setPreviewTalent] = useState<Talent | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // 新手指引代填数据（仅新增态写入）+ 触发填充的计数
  const [talentPrefill, setTalentPrefill] = useState<Record<string, any> | undefined>(undefined);
  const [talentFillToken, setTalentFillToken] = useState(0);

  // 新手指引：登记「打开空表单」与「填示例数据」两个回调
  useEffect(() => {
    return registerOnbFill("/talents", {
      open: () => {
        setEditId(null);
        setTalentPrefill(undefined); // 打开空表单
        setAddOpen(true);
      },
      fill: () => {
        setTalentPrefill({
          name: "张明",
          phone: "13800138000",
          email: "zhangming@example.com",
          education: "本科",
          current_company: "某某科技有限公司",
          current_title: "前端工程师",
          years_experience: 4,
          city: "深圳",
          skills: "React, TypeScript, Node.js",
          source: "猎头推荐",
          status: "active",
        });
        setTalentFillToken((t) => t + 1); // 触发弹窗把示例写进已打开的表单
      },
    });
  }, []);

  // 受控多选（跨页保留选中）：勾选态仍服务于「导出选中」；批量入流程/批量操作已于 2026-10-21 移除
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);

  // 合规到期提醒：合同 / 试用期 30 天内到期
  const [compliance, setCompliance] = useState<ComplianceResponse | null>(null);
  const [complianceOpen, setComplianceOpen] = useState(false);

  // 导出状态
  const [exporting, setExporting] = useState(false);
  const [printData, setPrintData] = useState<Talent[] | null>(null);

  // 列显隐：从 localStorage 恢复（无保存或保存非法时用默认高频列；过滤掉不认识的 key 防脏数据）
  const [visibleCols, setVisibleCols] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_STORAGE_KEY) || "null");
      if (Array.isArray(saved)) {
        const valid = saved.filter((k: string) => OPTIONAL_COL_ORDER.includes(k));
        if (valid.length > 0) return valid;
      }
    } catch { /* 忽略脏数据 */ }
    return DEFAULT_VISIBLE_COLS;
  });
  const changeVisibleCols = (keys: string[]) => {
    setVisibleCols(keys);
    try { localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(keys)); } catch { /* 存储失败不阻断 */ }
  };

  // 常用搜索：保存当前筛选条件并命名，下次一键复用
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SAVED_SEARCHES_KEY) || "null");
      if (Array.isArray(saved)) return saved.filter((s: any) => s && typeof s.name === "string" && s.filters);
    } catch { /* 忽略脏数据 */ }
    return [];
  });
  const [saveSearchOpen, setSaveSearchOpen] = useState(false);
  const [saveSearchName, setSaveSearchName] = useState("");
  const persistSavedSearches = (list: SavedSearch[]) => {
    setSavedSearches(list);
    try { localStorage.setItem(SAVED_SEARCHES_KEY, JSON.stringify(list)); } catch { /* 存储失败不阻断 */ }
  };
  const applySavedSearch = (s: SavedSearch) => {
    setDraft(s.filters);
    setApplied(s.filters);
    setPage(1);
  };
  const saveCurrentSearch = () => {
    const name = saveSearchName.trim();
    if (!name) { message.warning("请输入搜索名称"); return; }
    persistSavedSearches([...savedSearches.filter((s) => s.name !== name), { name, filters: applied }]);
    setSaveSearchOpen(false);
    setSaveSearchName("");
    message.success("已保存当前搜索");
  };
  const removeSavedSearch = (name: string) =>
    persistSavedSearches(savedSearches.filter((s) => s.name !== name));

  const currentUser: User | null = (() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  })();
  const isAdmin = currentUser?.role === "admin";

  const fetchTalents = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = {
        page,
        limit: pageSize,
        ...buildFilterParams(applied),
      };
      if (sortField) {
        params.sort = sortField;
        params.order = sortOrder === "ascend" ? "asc" : "desc";
      }
      const res = await api.getTalents(params);
      setTalents(res.items);
      setTotal(res.total);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, [page, pageSize, sortField, sortOrder, applied]);

  useEffect(() => {
    fetchTalents();
  }, [fetchTalents]);

  useEffect(() => {
    if (isAdmin) {
      api.getUsers().then((u) => setUsers(u)).catch(() => {});
    }
  }, [isAdmin]);

  // 合规到期：加载失败静默（只是提醒，不阻塞列表）
  useEffect(() => {
    api.getTalentCompliance().then(setCompliance).catch(() => {});
  }, []);

  // 登录后从 /auth/me 获取用户信息存入 localStorage
  useEffect(() => {
    api.me().then((u) => localStorage.setItem("user", JSON.stringify(u))).catch(() => {});
  }, []);

  const setField = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const handleSearch = () => {
    setPage(1);
    // 手动选了「状态」就退出分组高亮，避免两个条件叠加
    setApplied((a) => ({ ...draft, group: draft.status ? "all" : a.group }));
  };

  const handleReset = () => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setPage(1);
  };

  // 导入/合并之后刷新列表。新记录按 updated_at 倒序排在最前，
  // 如果当前不在第 1 页，刷新了也看不见，所以一并跳回第 1 页。
  const refreshAfterImport = useCallback(() => {
    if (page === 1) {
      fetchTalents();
    } else {
      setPage(1); // page 变化会触发上面的 useEffect 重新拉取
    }
  }, [page, fetchTalents]);

  const handleDelete = async (id: string, name: string) => {
    try {
      await api.deleteTalent(id);
      message.success(`已删除「${name}」`);
      fetchTalents();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  // 拉取当前筛选条件下的全量数据（用于导出）。后端 limit 上限 100，这里分页拉取直到取完。
  const fetchAllForExport = async (): Promise<Talent[]> => {
    const base = buildFilterParams(applied);
    if (sortField) {
      base.sort = sortField;
      base.order = sortOrder === "ascend" ? "asc" : "desc";
    }
    const all: Talent[] = [];
    let pageNum = 1;
    const ps = 100;
    while (true) {
      const res = await api.getTalents({ ...base, page: pageNum, limit: ps });
      all.push(...res.items);
      if (res.items.length === 0 || all.length >= res.total) break;
      pageNum++;
    }
    return all;
  };

  // 导出字段定义：跟随「列设置」visibleCols 动态生成（姓名始终包含）。
  // 这样导出的列与列表看到的一致，不会写死一堆用户没勾选的字段。
  const exportColDefs: Record<string, { title: string; get: (t: Talent) => string }> = {
    name: { title: "姓名", get: (t) => t.name || "" },
    current_title: { title: "职位", get: (t) => t.current_title || "" },
    years_experience: { title: "年限", get: (t) => (t.years_experience != null ? `${t.years_experience}年` : "") },
    age: { title: "年龄", get: (t) => (t.age != null ? String(t.age) : "") },
    education: { title: "学历", get: (t) => t.education || "" },
    school: { title: "院校", get: (t) => t.school || "" },
    major: { title: "专业", get: (t) => t.major || "" },
    city: { title: "城市", get: (t) => t.city || "" },
    phone: { title: "手机号", get: (t) => t.phone || "" },
    email: { title: "邮箱", get: (t) => t.email || "" },
    current_company: { title: "当前公司", get: (t) => t.current_company || "" },
    industry: { title: "行业", get: (t) => t.industry || "" },
    expected_salary: { title: "期望薪资", get: (t) => t.expected_salary || "" },
    skills: { title: "技能", get: (t) => (t.skills || []).join("、") },
    status: { title: "状态", get: (t) => STATUS_LABELS[t.status] || t.status || "" },
    owner_name: { title: "创建人", get: (t) => t.owner_name || "" },
    entry_type: { title: "录入方式", get: (t) => ENTRY_TYPE_LABELS[t.entry_type || "manual"] || "手动录入" },
    source: { title: "来源渠道", get: (t) => t.source || "" },
    created_at: { title: "创建时间", get: (t) => t.created_at || "" },
    tags: { title: "标签", get: (t) => (t.tags || []).join("、") },
  };
  const buildExportColumns = (): { key: string; title: string; get: (t: Talent) => string }[] => {
    const keys = ["name", ...visibleCols.filter((k) => k !== "name")];
    return keys.filter((k) => exportColDefs[k]).map((k) => ({ key: k, ...exportColDefs[k] }));
  };

  // 导出数据：全量（按当前筛选 + 排序）→ 若勾选了行则只取选中行
  const getExportData = async (): Promise<{
    rows: Talent[];
    columns: { key: string; title: string; get: (t: Talent) => string }[];
  }> => {
    const columns = buildExportColumns();
    const all = await fetchAllForExport();
    if (selectedKeys.length > 0) {
      const sel = new Set(selectedKeys.map(String));
      return { rows: all.filter((t) => sel.has(t.id)), columns };
    }
    return { rows: all, columns };
  };

  // 生成导出表格 HTML（Word 与 PDF 打印共用）
  const buildExportHtml = (rows: Talent[], cols: { key: string; title: string; get: (t: Talent) => string }[]): string => {
    const thead = cols.map((c) => `<th>${c.title}</th>`).join("");
    const tbody = rows.map((t) => {
      const tds = cols.map((c) => `<td>${escapeHtml(c.get(t))}</td>`).join("");
      return `<tr>${tds}</tr>`;
    }).join("");
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${termFor(profile, "人才库导出")}</title>
<style>
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; margin: 24px; color: #333; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #999; font-size: 12px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; }
  tr:nth-child(even) td { background: #fafafa; }
</style></head><body>
<h1>${termFor(profile, "人才库导出")}</h1>
<div class="sub">共 ${rows.length} 人 · 导出时间 ${new Date().toLocaleString("zh-CN")}</div>
<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>
</body></html>`;
  };

  // 导出 Word（.doc 格式，Word 可直接打开 HTML）
  const handleExportWord = async () => {
    try {
      setExporting(true);
      const { rows, columns } = await getExportData();
      if (rows.length === 0) { message.warning(selectedKeys.length > 0 ? "未选中可导出的数据" : "暂无数据可导出"); return; }
      const html = buildExportHtml(rows, columns);
      const blob = new Blob(["\ufeff" + html], { type: "application/msword;charset=utf-8" });
      downloadBlob(blob, `${termFor(profile, "人才库导出")}_${dateStamp()}.doc`);
      const label = selectedKeys.length > 0 ? `已导出选中的 ${rows.length} 条` : `已导出 ${rows.length} 条人才`;
      message.success(termFor(profile, `${label}（Word）`));
    } catch (err) {
      message.error((err as Error).message || "导出失败");
    } finally {
      setExporting(false);
    }
  };

  // 导出 PDF（打印视图 → 浏览器"另存为 PDF"）
  const handleExportPdf = async () => {
    try {
      setExporting(true);
      const { rows } = await getExportData();
      if (rows.length === 0) { message.warning(selectedKeys.length > 0 ? "未选中可导出的数据" : "暂无数据可导出"); return; }
      setPrintData(rows);
      // 等待打印容器渲染后触发打印
      setTimeout(() => {
        window.print();
        setPrintData(null);
      }, 300);
    } catch (err) {
      message.error((err as Error).message || "导出失败");
    } finally {
      setExporting(false);
    }
  };

  const exportMenuItems: MenuProps["items"] = [
    { key: "excel", label: "导出 Excel", icon: <FileExcelOutlined /> },
    { key: "word", label: "导出 Word", icon: <FileWordOutlined /> },
    { key: "pdf", label: "导出 PDF", icon: <FilePdfOutlined /> },
  ];

  const onExportMenuClick: MenuProps["onClick"] = ({ key }) => {
    if (key === "excel") handleExportExcel();
    else if (key === "word") handleExportWord();
    else if (key === "pdf") handleExportPdf();
  };

  // 导出 Excel（人才盘点 / 汇报用表格；字段顺序与 Word/PDF 完全一致）
  const handleExportExcel = async () => {
    try {
      setExporting(true);
      const { rows, columns } = await getExportData();
      if (rows.length === 0) { message.warning(selectedKeys.length > 0 ? "未选中可导出的数据" : "暂无数据可导出"); return; }
      await exportXlsx(`${termFor(profile, "人才库导出")}_${dateStamp()}.xlsx`, [
        {
          name: termFor(profile, "人才库"),
          columns: columns.map((c) => ({
            header: c.title,
            key: c.key,
            width: c.key === "email" || c.key === "skills" || c.key === "tags" ? 24 : 14,
          })),
          rows: rows.map((t) => Object.fromEntries(columns.map((c) => [c.key, c.get(t)]))),
        },
      ]);
      // 导出发生在浏览器内存里，服务端无从得知——显式上报，留痕「谁把多少条人才数据导走了」
      void api.reportAudit({
        action: "export",
        targetType: "talent",
        targetName: `人才库导出（Excel）`,
        detail: { rows: rows.length, selected: selectedKeys.length > 0 },
      });
      const label = selectedKeys.length > 0 ? `已导出选中的 ${rows.length} 条` : `已导出 ${rows.length} 条人才`;
      message.success(termFor(profile, `${label}（Excel）`));
    } catch (err) {
      message.error((err as Error).message || "导出失败");
    } finally {
      setExporting(false);
    }
  };

  // 导出单份简历：根据 resume_url 扩展名判断原文件格式，PDF 导出 PDF、Word 导出 Word
  const handleExportResume = async (record: Talent) => {
    if (!record.resume_url) { message.warning(termFor(profile, "该人才暂无简历文件")); return; }
    const ext = (record.resume_url.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
    const isWord = ext === "docx" || ext === "doc";
    const isPdf = ext === "pdf";
    const typeLabel = isWord ? "Word" : isPdf ? "PDF" : "简历";
    try {
      // 先取 60s 短期票据，再触发浏览器下载（后端 Content-Disposition: attachment）
      const url = await api.getResumeDownloadUrl(record.id);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${record.name}_${typeLabel}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      message.success(termFor(profile, `正在导出 ${record.name} 的${typeLabel}简历`));
    } catch (e) {
      message.error((e as Error).message || "导出失败");
    }
  };

  // ---- 搜索字段定义（label 左 + 控件右，一行 4 个）----
  const controlStyle: React.CSSProperties = { width: "100%" };
  const fieldDefs: { key: string; label: string; control: React.ReactNode }[] = [
    { key: "name", label: "姓名", control: <Input style={controlStyle} placeholder="请输入姓名" value={draft.name} onChange={(e) => setField("name", e.target.value)} onPressEnter={handleSearch} allowClear /> },
    { key: "title", label: "职位", control: <Input style={controlStyle} placeholder="请输入职位" value={draft.title} onChange={(e) => setField("title", e.target.value)} onPressEnter={handleSearch} allowClear /> },
    {
      key: "years", label: "年限",
      control: (
        <Space.Compact style={controlStyle}>
          <InputNumber style={{ width: "50%" }} value={draft.years_min} onChange={(v) => setField("years_min", v ?? null)} min={0} max={50} placeholder="最小" />
          <InputNumber style={{ width: "50%" }} value={draft.years_max} onChange={(v) => setField("years_max", v ?? null)} min={0} max={50} placeholder="最大" />
        </Space.Compact>
      ),
    },
    { key: "education", label: "学历", control: <Select mode="multiple" maxTagCount="responsive" style={controlStyle} value={draft.education} onChange={(v) => setField("education", (v || []) as string[])} allowClear placeholder="请选择学历（可多选）" options={educationOptions.map((e) => ({ label: e, value: e }))} /> },
    { key: "major", label: "专业", control: <Input style={controlStyle} placeholder="请输入专业" value={draft.major} onChange={(e) => setField("major", e.target.value)} onPressEnter={handleSearch} allowClear /> },
    { key: "city", label: "城市", control: <Select mode="tags" style={controlStyle} value={draft.city} onChange={(v) => setField("city", (v || []) as string[])} tokenSeparators={[",", "，"]} placeholder="输入城市，回车可多个" /> },
    { key: "phone", label: "手机号", control: <Input style={controlStyle} placeholder="请输入手机号" value={draft.phone} onChange={(e) => setField("phone", e.target.value)} onPressEnter={handleSearch} allowClear /> },
    {
      key: "age", label: "年龄",
      control: (
        <Space.Compact style={controlStyle}>
          <InputNumber style={{ width: "50%" }} value={draft.age_min} onChange={(v) => setField("age_min", v ?? null)} min={16} max={80} placeholder="最小" />
          <InputNumber style={{ width: "50%" }} value={draft.age_max} onChange={(v) => setField("age_max", v ?? null)} min={16} max={80} placeholder="最大" />
        </Space.Compact>
      ),
    },
    { key: "status", label: "状态", control: <Select style={controlStyle} value={draft.status || undefined} onChange={(v) => setField("status", v || "")} allowClear placeholder="请选择状态" options={Object.entries(STATUS_LABELS).map(([k, v]) => ({ label: v, value: k }))} /> },
    { key: "tags", label: "标签", control: <Select style={controlStyle} mode="tags" value={draft.tags ? draft.tags.split(",").filter(Boolean) : undefined} onChange={(v) => setField("tags", (v || []).join(","))} tokenSeparators={[","]} placeholder="按标签筛选" /> },
    { key: "entry_type", label: "录入方式", control: <Select style={controlStyle} value={draft.entry_type || undefined} onChange={(v) => setField("entry_type", v || "")} allowClear placeholder="全部方式" options={ENTRY_TYPE_OPTIONS} /> },
    ...(isAdmin && users.length > 0
      ? [{ key: "owner_id", label: "创建人", control: <Select style={controlStyle} value={draft.owner_id || undefined} onChange={(v) => setField("owner_id", v || "")} allowClear placeholder="请选择创建人" options={users.map((u) => ({ label: u.name, value: u.id }))} /> }]
      : []),
  ];

  const visibleDefs = expanded ? fieldDefs : fieldDefs.slice(0, COLLAPSED_COUNT);

  // 受控多选：跨页保留非本页选中，本页按新 keys 重建（全站统一写法，勿加 some 去重）
  const pageKeySet = new Set<React.Key>(talents.map((t) => t.id));
  const rowSelection = {
    selectedRowKeys: selectedKeys,
    onChange: (keys: React.Key[]) => {
      setSelectedKeys([...selectedKeys.filter((k) => !pageKeySet.has(k)), ...keys]);
    },
  };

  // 列定义按 key 收进 colMap，再按「列设置」勾选结果组装（姓名/操作固定，其余可显隐）
  const colMap: Record<string, any> = {
    name: {
      title: "姓名",
      dataIndex: "name",
      key: "name",
      width: 120,
      fixed: "left" as const,
      sorter: true,
      sortOrder: sortField === "name" ? sortOrder || undefined : null,
      render: (text: string, record: Talent) => (
        <Link to={`/talents/${record.id}`} style={{ fontWeight: 600 }}>{text}</Link>
      ),
    },
    current_title: { title: "职位", dataIndex: "current_title", key: "current_title", width: 150, render: (v: string) => v || "-" },
    years_experience: {
      title: "年限", dataIndex: "years_experience", key: "years_experience", width: 90,
      sorter: true,
      sortOrder: sortField === "years_experience" ? sortOrder || undefined : null,
      render: (v: number | null) => (v != null ? `${v}年` : "-"),
    },
    age: { title: "年龄", dataIndex: "age", key: "age", width: 80, sorter: true, sortOrder: sortField === "age" ? sortOrder || undefined : null, render: (v: number | null) => (v != null ? `${v}岁` : "-") },
    education: { title: "学历", dataIndex: "education", key: "education", width: 110, render: (v: string) => v || "-" },
    school: { title: "院校", dataIndex: "school", key: "school", width: 160, render: (v: string) => v || "-" },
    major: { title: "专业", dataIndex: "major", key: "major", width: 140, render: (v: string) => v || "-" },
    city: { title: "城市", dataIndex: "city", key: "city", width: 90, render: (v: string) => v || "-" },
    phone: { title: "手机号", dataIndex: "phone", key: "phone", width: 130, render: (v: string) => v || "-" },
    email: { title: "邮箱", dataIndex: "email", key: "email", width: 200, render: (v: string) => v || "-" },
    status: {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (status: string) => (
        <Tag color={STATUS_COLORS[status] || "default"}>
          {STATUS_LABELS[status] || status || "-"}
        </Tag>
      ),
    },
    entry_type: {
      title: "来源",
      dataIndex: "entry_type",
      key: "entry_type",
      width: 168,
      render: (_: string, record: Talent) => {
        const t = record.entry_type || "manual";
        // 来源渠道（source）为空时不占位：入口标签（如「简历导入」）本身已说明来历，
        // 再补一个「-」只会让人以为漏填了字段（2026-10-21 用户反馈）
        return (
          <Space size={4} wrap>
            <Tag color={ENTRY_TYPE_COLORS[t] || ENTRY_TYPE_COLORS.manual} style={{ marginInlineEnd: 0 }}>
              {ENTRY_TYPE_LABELS[t] || "手动录入"}
            </Tag>
            {record.source && <Tag style={{ marginInlineEnd: 0 }}>{record.source}</Tag>}
          </Space>
        );
      },
    },
    tags: {
      title: "标签",
      dataIndex: "tags",
      key: "tags",
      width: 170,
      render: (tags: string[]) =>
        tags && tags.length ? (
          <Space size={4} wrap>
            {tags.map((t) => (
              <Tag key={t} color="blue" style={{ marginInlineEnd: 0 }}>{t}</Tag>
            ))}
          </Space>
        ) : <span>-</span>,
    },
    owner_name: {
      title: "创建人",
      dataIndex: "owner_name",
      key: "owner_name",
      width: 120,
      render: (v: string) => v || "-",
    },
    action: {
      title: "操作",
      key: "action",
      width: 184,
      fixed: "right" as const,
      render: (_: any, record: Talent) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => setEditId(record.id)}>编辑</Button>
          {record.resume_url && (
            <>
              <Button type="link" size="small" onClick={() => setPreviewTalent(record)}>预览</Button>
              <Button type="link" size="small" onClick={() => handleExportResume(record)}>导出</Button>
            </>
          )}
          <Popconfirm title="确认删除？所有关联数据将被清除。" onConfirm={() => handleDelete(record.id, record.name)}>
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  };

  // 组装列：姓名 → 按勾选结果排可选列（创建人列仅 admin 可见）→ 操作
  const optionalKeys = OPTIONAL_COL_ORDER.filter((k) => k !== "owner_name" || isAdmin);
  const shownKeys = optionalKeys.filter((k) => visibleCols.includes(k));
  const columns = [
    colMap.name,
    ...shownKeys.map((k) => colMap[k]),
    colMap.action,
  ];
  // 横向滚动宽度跟随可见列宽计算，避免固定 1500 在少列时出现过宽空白
  const scrollX = 120 + 184 + shownKeys.reduce((a, k) => a + (colMap[k]?.width || 120), 0);

  // 列设置弹层选项（创建人仅 admin 展示）
  const colSettingOptions = optionalKeys.map((k) => ({ label: OPTIONAL_COL_LABELS[k], value: k }));

  // 表格受控分页 + 排序：排序变化时回到第 1 页，避免停留在不存在的页
  const handleTableChange = (
    pg: { current?: number; pageSize?: number },
    _filters: unknown,
    sorter: unknown,
  ) => {
    const s = Array.isArray(sorter) ? null : (sorter as { field?: string; order?: "ascend" | "descend" } | null);
    const newField = (s?.field as string) || "";
    const newOrder = (s?.order as "ascend" | "descend" | undefined) || "";
    const sortChanged = newField !== sortField || newOrder !== sortOrder;
    setSortField(newField);
    setSortOrder(newOrder);
    if (pg.pageSize && pg.pageSize !== pageSize) setPageSize(pg.pageSize);
    setPage(sortChanged ? 1 : pg.current || 1);
  };

  // AI 人才储备盘点：按当前筛选口径聚合人才结构后讲结论（库里有没有货、缺口在哪、怎么运营）。
  // AI 失败降级提示本身，不阻塞列表任何功能。
  const [inventory, setInventory] = useState<{ open: boolean; loading: boolean; err: string; data: AiTalentInventory | null }>({
    open: false, loading: false, err: "", data: null,
  });
  const genInventory = useCallback(async () => {
    setInventory((s) => ({ ...s, open: true, loading: true, err: "", data: null }));
    try {
      const r = await api.aiTalentInventory(buildFilterParams(applied));
      setInventory({ open: true, loading: false, err: "", data: r });
    } catch (e) {
      setInventory({ open: true, loading: false, err: (e as Error).message || "生成失败，请稍后重试", data: null });
    }
  }, [applied]);

  return (
    <div className="page-fill">
      {/* 合规到期提醒：轻量 Alert + 名单弹窗（不做成独立看板） */}
      {compliance && compliance.items.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`合规到期提醒：30 天内合同到期 ${compliance.contract_count} 人、试用期到期 ${compliance.probation_count} 人`}
          action={
            <Button size="small" onClick={() => setComplianceOpen(true)}>查看名单</Button>
          }
        />
      )}

      {/* 顶部搜索区域：label 左 + 控件右，一行 4 个，超过一行可展开/收起（复用 search-card 约定类） */}
      <Card className="search-card" style={{ marginBottom: 16 }}>
        <div className="search-grid">
          {visibleDefs.map((d) => (
            <div key={d.key} className="search-field">
              <span className="search-label">{d.label}</span>
              <div className="search-control">{d.control}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card className="list-card">
        {/* 快捷分组：列表顶部区域，点击即筛选，复用列表查询 group 参数；
            与「状态」下拉互斥——点分组会清空 status，避免两个条件叠加。 */}
        <div className="talent-groups" role="tablist" aria-label="人才分组">
          {GROUP_OPTIONS.map((g) => (
            <button
              key={g.value}
              type="button"
              role="tab"
              aria-selected={applied.group === g.value}
              className={`talent-group-item${applied.group === g.value ? " is-active" : ""}`}
              onClick={() => {
                setApplied((a) => ({ ...a, status: "", group: g.value }));
                setDraft((d) => ({ ...d, status: "" }));
                setPage(1);
              }}
            >
              {g.label}
            </button>
          ))}
        </div>
        {/* 布局约定（全站统一）：搜索 Card 只放搜索字段（label 左 / 控件右，一行 4 个）；
            顶部工具行左侧是「导入/导出」等数据操作，右侧是「展开收起 / 重置 / 查询」，
            两者形成一条对齐的右侧操作区，不要另起一行。 */}
        <div className="toolbar">
          <Space>
            <Button
              type="primary" icon={<PlusOutlined />}
              data-onb-action="new-talent"
              onClick={() => { setEditId(null); setTalentPrefill(undefined); setAddOpen(true); }}
            >
              {termFor(profile, "新增人才")}
            </Button>
            <Button icon={<ImportOutlined />} onClick={() => setImportModalOpen(true)}>导入</Button>
            {/* 智能匹配入口：从「挑人」场景顺手进匹配页（页内自选画像）。
                用站内统一 ai-btn（淡紫底 + 机器人图标）标识 AI 能力，
                与人才详情页头部按钮、画像页「去匹配」视觉一致 */}
            <Button className="ai-btn" icon={<RobotOutlined />} onClick={() => navigate("/match")}>智能匹配</Button>
            <Dropdown menu={{ items: exportMenuItems, onClick: onExportMenuClick }} disabled={exporting}>
              <Button icon={<ExportOutlined />} loading={exporting}>导出</Button>
            </Dropdown>
            {/* 列设置：姓名/操作固定，其余列可勾选显隐，选择存 localStorage */}
            <Popover
              trigger="click"
              placement="bottomRight"
              content={
                <div style={{ width: 240 }}>
                  <div style={{ fontSize: 12, color: "#999", marginBottom: 8 }}>
                    勾选要显示的列（姓名、操作固定显示）
                  </div>
                  <Checkbox.Group
                    value={visibleCols}
                    options={colSettingOptions}
                    onChange={(vals) => changeVisibleCols(vals as string[])}
                    style={{ display: "flex", flexDirection: "column", gap: 6 }}
                  />
                </div>
              }
            >
              <Button icon={<SettingOutlined />}>列设置</Button>
            </Popover>
            {/* AI 盘点：按当前筛选口径生成储备简报，打开后自动生成 */}
            <Tooltip title="按当前筛选口径，让 AI 生成人才储备画像、缺口与运营建议">
              <Button className="ai-btn" icon={<RobotOutlined />} onClick={genInventory}>AI 盘点</Button>
            </Tooltip>
          </Space>
          <Space>
            {fieldDefs.length > COLLAPSED_COUNT && (
              <Button type="link" size="small" onClick={() => setExpanded(!expanded)}>
                {expanded ? <>收起 <UpOutlined /></> : <>展开 <DownOutlined /></>}
              </Button>
            )}
            <Button icon={<ReloadOutlined />} onClick={handleReset}>重置</Button>
            <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>查询</Button>
            {/* 常用搜索：一键复用已保存的筛选；「保存」把当前条件命名后存本地 */}
            <Dropdown
              trigger={["click"]}
              menu={{
                items: savedSearches.length
                  ? savedSearches.map((s) => ({ key: s.name, label: s.name }))
                  : [{ key: "__empty", label: "暂无保存的搜索", disabled: true }],
                onClick: ({ key }) => {
                  const s = savedSearches.find((x) => x.name === key);
                  if (s) applySavedSearch(s);
                },
              }}
            >
              <Button>常用搜索 <DownOutlined /></Button>
            </Dropdown>
            <Button onClick={() => setSaveSearchOpen(true)}>保存搜索</Button>
          </Space>
        </div>
        <Table
          className="profiles-table"
          columns={columns}
          dataSource={talents}
          rowKey="id"
          loading={loading}
          rowSelection={rowSelection}
          onChange={handleTableChange}
          scroll={{ x: scrollX }}
          locale={{
          // 空库引导：第一次进来别只看一个干巴巴的「暂无数据」
          emptyText: (
            <div style={{ padding: "40px 0", textAlign: "center" }}>
              <Empty description={termFor(profile, "人才库还是空的")} image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginBottom: 16 }} />
              <div style={{ marginTop: 12, color: "#999", fontSize: 12 }}>
                {termFor(profile, "点左上角「新增人才」或「导入」开始录入真实数据")}
              </div>
            </div>
          ),
          }}
          pagination={{
            current: page,
            total,
            pageSize,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50, 100],
            showTotal: (t) => termFor(profile, `共 ${t} 位人才`),
          }}
        />
      </Card>

      {/* 打印导出容器：仅在打印时显示 */}
      {printData && (
        <div className="export-print-area" dangerouslySetInnerHTML={{ __html: buildExportHtml(printData, buildExportColumns()) }} />
      )}

      {/* 导入弹窗（上传 → 逐份核对 → 保存即写入人才库） */}
      <ImportModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onSuccess={refreshAfterImport}
      />

      {/* 简历预览弹窗（PDF 原生渲染保留格式；Word 在线转 HTML 查看，不下载） */}
      <ResumePreviewModal talent={previewTalent} onClose={() => setPreviewTalent(null)} />

      {/* 行内编辑：不跳详情页，改完即刷新列表 */}
      <TalentFormModal
        open={addOpen || !!editId}
        talentId={editId}
        prefill={talentPrefill}
        fillToken={talentFillToken}
        onClose={() => { setEditId(null); setAddOpen(false); setTalentPrefill(undefined); }}
        onSuccess={fetchTalents}
      />

      {/* 合规到期名单：30 天内合同 / 试用期到期（含已过期），点姓名进详情 */}
      <Modal
        title="合规到期名单（30 天内 · 含已过期）"
        open={complianceOpen}
        onCancel={() => setComplianceOpen(false)}
        footer={null}
        width={560}
      >
        <Table
          size="small"
          rowKey={(r) => `${r.type}-${r.talent_id}`}
          dataSource={compliance?.items || []}
          pagination={false}
          scroll={{ y: 380 }}
          columns={[
            {
              title: "姓名", dataIndex: "name",
              render: (v: string, r: ComplianceItem) => (
                <Link to={`/talents/${r.talent_id}`} style={{ fontWeight: 600 }}>{v}</Link>
              ),
            },
            {
              title: "类型", dataIndex: "type", width: 110,
              render: (v: string) => (
                <Tag color={v === "contract" ? "orange" : "blue"}>
                  {v === "contract" ? "合同到期" : "试用期到期"}
                </Tag>
              ),
            },
            { title: "到期日", dataIndex: "due_date", width: 110 },
            {
              title: "剩余", dataIndex: "days_left", width: 110,
              render: (v: number) => v < 0 ? (
                <span style={{ color: "#ff4d4f" }}>已过期 {-v} 天</span>
              ) : v <= 7 ? (
                <span style={{ color: "#fa8c16" }}>仅剩 {v} 天</span>
              ) : (
                `剩 ${v} 天`
              ),
            },
          ]}
        />
      </Modal>

      {/* AI 人才储备盘点：画像 + 缺口 + 运营建议；AI 失败降级为错误提示（不阻塞列表） */}
      <Modal
        title="AI 人才储备盘点"
        open={inventory.open}
        onCancel={() => setInventory((s) => ({ ...s, open: false }))}
        footer={
          <Space>
            <Button size="small" icon={<RobotOutlined />} onClick={genInventory} disabled={inventory.loading}>
              重新生成
            </Button>
            <Button onClick={() => setInventory((s) => ({ ...s, open: false }))}>关闭</Button>
          </Space>
        }
        width={560}
      >
        {inventory.loading ? (
          <AiThinking steps={["正在聚合人才结构…", "正在比对在招岗位…", "正在形成盘点结论…"]} />
        ) : inventory.err ? (
          <Alert type="warning" showIcon message={`AI 暂不可用（${inventory.err}）`} />
        ) : inventory.data ? (
          <div>
            <div style={{ lineHeight: 1.8, marginBottom: 10 }}>
              <TypeText text={inventory.data.profile} />
            </div>
            {inventory.data.gaps.length > 0 && (
              <>
                <div style={{ fontWeight: 600, margin: "6px 0 4px" }}>储备缺口</div>
                {inventory.data.gaps.map((g, i) => (
                  <div key={i} style={{ lineHeight: 1.7, fontSize: 13 }}>• <TypeText text={g} /></div>
                ))}
              </>
            )}
            <div style={{ fontWeight: 600, margin: "8px 0 4px" }}>运营建议</div>
            {inventory.data.actions.map((a, i) => (
              <div key={i} style={{ lineHeight: 1.7, fontSize: 13 }}>{i + 1}. <TypeText text={a} /></div>
            ))}
          </div>
        ) : null}
      </Modal>

      {/* 保存常用搜索：命名当前筛选条件并存入本地；已保存的可直接删除 */}
      <Modal
        title="保存常用搜索"
        open={saveSearchOpen}
        onOk={saveCurrentSearch}
        onCancel={() => setSaveSearchOpen(false)}
        okText="保存"
      >
        <Input
          placeholder="给这组搜索条件起个名字，如「杭州本科3年以上」"
          value={saveSearchName}
          onChange={(e) => setSaveSearchName(e.target.value)}
          onPressEnter={saveCurrentSearch}
          allowClear
        />
        {savedSearches.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: "#8c8c8c", marginBottom: 6 }}>已保存（点 × 删除）</div>
            <Space wrap size={[8, 8]}>
              {savedSearches.map((s) => (
                <Tag key={s.name} closable onClose={() => removeSavedSearch(s.name)}>{s.name}</Tag>
              ))}
            </Space>
          </div>
        )}
      </Modal>
    </div>
  );
}
