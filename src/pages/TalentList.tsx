import { useState, useEffect, useCallback, lazy, Suspense } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Card, Table, Input, InputNumber, Select, Button, Space, Tag,
  message, Dropdown, Alert, Modal, Empty, Typography,
  Checkbox, Tooltip, Drawer,
} from "antd";
import {
  ImportOutlined, FilePdfOutlined, ExportOutlined,
  SearchOutlined, FileWordOutlined, PlusOutlined,
  FileExcelOutlined, SettingOutlined, RobotOutlined, HistoryOutlined,
  FilterOutlined, MoreOutlined, CloseOutlined, ReloadOutlined,
} from "@ant-design/icons";
import type { MenuProps } from "antd";
import { api } from "../api";
import AiThinking from "../components/AiThinking";
import { TypeText } from "../utils/useTypewriter";
import type { Talent, User, ComplianceItem, ComplianceResponse, AiTalentInventory } from "../types";
import {
  STATUS_LABELS, STATUS_COLORS,
  ENTRY_TYPE_LABELS, ENTRY_TYPE_COLORS, ENTRY_TYPE_OPTIONS,
  STAGE_META,
} from "../types";
import ImportModal from "../components/ImportModal";
// 导入记录：常驻弹窗，用 lazy + 门控（与 Layout.tsx 的弹窗同一模式），
// 不跟着人才库页一起进首包
const ImportHistoryModal = lazy(() => import("../components/ImportHistoryModal"));
import ResumePreviewModal from "../components/ResumePreviewModal";
import TalentFormModal from "../components/TalentFormModal";
import { CandidateCell, StageProgress, NextStepCell, UpdatedCell } from "../components/TalentListCells";
import { useDict } from "../dict";
import { registerOnbFill } from "../components/onboardingAutoFill";

// 搜索条件（draft = 编辑中，applied = 已生效）
interface Filters {
  q: string;                // 搜索框原文（含 xxx:yyy 语法，提交时解析）
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
  q: "", name: "", phone: "", education: [], city: [], major: "",
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

// 搜索语法支持的字段别名：`城市:杭州` / `city:杭州` 都认。
// 只映射到已有筛选字段，不新增查询能力——语法只是「少点两次」的捷径。
const QUERY_ALIASES: Record<string, keyof Filters> = {
  城市: "city", city: "city",
  学历: "education", education: "education",
  状态: "status", status: "status",
  标签: "tags", tag: "tags", tags: "tags",
  姓名: "name", name: "name",
  职位: "title", title: "title",
  手机: "phone", phone: "phone",
  专业: "major", major: "major",
};

/**
 * 解析搜索框：`城市:杭州 学历:本科 Java` → { q: "Java", patch: { city:["杭州"], education:["本科"] } }
 *
 * 为什么不把语法塞进后端：后端已经有 q/name/city/education 这些精确参数，
 * 前端解析后走同一套参数，导出、AI 盘点、快捷分组全部自动一致；
 * 后端再解析一遍等于两套规则，迟早对不上。
 */
function parseQuery(raw: string): { q: string; patch: Partial<Filters> } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const words: string[] = [];
  const patch: Partial<Filters> = {};
  const cities: string[] = [];
  const edus: string[] = [];
  const tags: string[] = [];

  for (const tok of tokens) {
    const m = tok.match(/^([^:：]+)[:：](.+)$/);
    const field = m ? QUERY_ALIASES[m[1].toLowerCase()] : undefined;
    if (!m || !field) { words.push(tok); continue; }
    const val = m[2].trim();
    if (!val) continue;
    if (field === "city") cities.push(val);
    else if (field === "education") edus.push(val);
    else if (field === "tags") tags.push(val);
    else if (field === "status") {
      // 状态允许写中文：`状态:已入职` → placed
      const hit = Object.entries(STATUS_LABELS).find(([, label]) => label === val);
      patch.status = hit ? hit[0] : val;
    } else {
      (patch as Record<string, unknown>)[field] = val;
    }
  }
  if (cities.length) patch.city = cities;
  if (edus.length) patch.education = edus;
  if (tags.length) patch.tags = tags.join(",");
  return { q: words.join(" "), patch };
}

// 搜索条件 → 查询参数。列表查询与导出共用一份，
// 避免两处各写一遍导致「导出的数据和列表看到的不一致」。
function buildFilterParams(f: Filters): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  if (f.q) params.q = f.q;
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

// 列表每页条数
const PAGE_SIZE = 10;

// ---- 列显隐配置（候选人 / 流程阶段 / 下一步 / 操作 固定显示，其余可勾选）----
const OPTIONAL_COL_LABELS: Record<string, string> = {
  status: "状态",
  phone: "手机号",
  current_title: "职位",
  years_experience: "年限",
  age: "年龄",
  education: "学历",
  school: "院校",
  major: "专业",
  city: "城市",
  email: "邮箱",
  entry_type: "来源",
  tags: "标签",
  owner_name: "创建人",
  updated_at: "最近更新",
};
const OPTIONAL_COL_ORDER = Object.keys(OPTIONAL_COL_LABELS);
// 默认只留两个高频列：主列已经承载了身份/阶段/待办信息，
// 再平铺一堆档案字段就退回「字段清单」了，其余按需在「列设置」里打开。
const DEFAULT_VISIBLE_COLS = ["status", "phone"];
// v2：主列语义变了（职位/城市/年限进了候选人副标题），旧值里的列按新顺序重排；
// 换 key 而不是原地兼容，是为了让老用户也吃到新的默认列宽与列序。
const COLS_STORAGE_KEY = "talent_list_visible_cols_v2";

import { escapeHtml, downloadBlob, dateStamp, exportXlsx } from "../utils/file";

export default function TalentList() {
  const navigate = useNavigate();
  const { education: educationOptions, cities: cityOptions } = useDict();
  const [talents, setTalents] = useState<Talent[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  // 每页条数 + 列表排序（受控，配合后端 sort/order 白名单）
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [sortField, setSortField] = useState<string>("");
  const [sortOrder, setSortOrder] = useState<"ascend" | "descend" | "">("");
  const [loading, setLoading] = useState(true);
  // 列表加载失败：不能静默（否则用户只看到空表，不知道是网络问题）
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  // 高级筛选抽屉 + 列设置弹窗（低频，打开才挂载内容）
  const [advOpen, setAdvOpen] = useState(false);
  const [colSettingOpen, setColSettingOpen] = useState(false);

  // 弹窗状态
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importHistoryOpen, setImportHistoryOpen] = useState(false);
  const [previewTalent, setPreviewTalent] = useState<Talent | null>(null);
  // 列表不再做行内编辑（编辑入口统一收敛到详情页），此弹窗只服务「新增人才」
  const [addOpen, setAddOpen] = useState(false);
  // 新手指引代填数据（仅新增态写入）+ 触发填充的计数
  const [talentPrefill, setTalentPrefill] = useState<Record<string, any> | undefined>(undefined);
  const [talentFillToken, setTalentFillToken] = useState(0);

  // 新手指引：登记「打开空表单」与「填示例数据」两个回调
  useEffect(() => {
    return registerOnbFill("/talents", {
      open: () => {
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

  // 受控多选（跨页保留选中）：勾选后的动作是「导出选中」，工具行会显式显示已选条数
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

  const currentUser: User | null = (() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  })();
  const isAdmin = currentUser?.role === "admin";

  const fetchTalents = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
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
      const msg = (err as Error).message || "人才列表加载失败，请重试";
      setLoadError(msg);
      message.error(msg);
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

  /**
   * 即时生效的筛选（状态/学历/城市/标签四个快筛、条件 chip 的移除）。
   * 与「查询」的区别：快筛点一下就该看到结果，不该再让人点第二次按钮。
   */
  const applyNow = (patch: Partial<Filters>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setApplied((a) => ({
      ...a,
      ...patch,
      // 手动给了状态就退出分组高亮，避免两个条件叠加（分组清空 status，反之亦然）
      ...(patch.status !== undefined ? { group: "all" } : {}),
    }));
    setPage(1);
  };

  const handleSearch = () => {
    const { q, patch } = parseQuery(draft.q);
    const next: Filters = { ...draft, ...patch, q };
    setDraft(next);
    setApplied((a) => ({ ...next, group: next.status ? "all" : a.group }));
    setPage(1);
  };

  const handleReset = () => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setPage(1);
  };

  // 导入/合并之后刷新列表。
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

  // 导出字段定义：跟随「列设置」visibleCols 动态生成（姓名/阶段/下一步始终包含）。
  // 这样导出的列与列表看到的一致，不会写死一堆用户没勾选的字段。
  const exportColDefs: Record<string, { title: string; get: (t: Talent) => string }> = {
    name: { title: "姓名", get: (t) => t.name || "" },
    stage: { title: "流程阶段", get: (t) => (t.stage && t.stage !== "new" ? (t.stage === "archived" ? "已结束" : STAGE_META[t.stage]?.label || t.stage) : "未进流程") },
    next_follow_at: { title: "下次跟进", get: (t) => (t.next_follow_at || "").slice(0, 10) },
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
    updated_at: { title: "最近更新", get: (t) => t.updated_at || "" },
    tags: { title: "标签", get: (t) => (t.tags || []).join("、") },
  };
  const buildExportColumns = (): { key: string; title: string; get: (t: Talent) => string }[] => {
    // 主列不走 visibleCols（它们常显），导出时固定跟在姓名后面
    const keys = ["name", "stage", "next_follow_at", ...visibleCols.filter((k) => k !== "name")];
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
<html lang="zh-CN"><head><meta charset="utf-8"><title>${"人才库导出"}</title>
<style>
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; margin: 24px; color: #333; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #999; font-size: 12px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; }
  tr:nth-child(even) td { background: #fafafa; }
</style></head><body>
<h1>${"人才库导出"}</h1>
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
      downloadBlob(blob, `${"人才库导出"}_${dateStamp()}.doc`);
      const label = selectedKeys.length > 0 ? `已导出选中的 ${rows.length} 条` : `已导出 ${rows.length} 条人才`;
      message.success(`${label}（Word）`);
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
      await exportXlsx(`${"人才库导出"}_${dateStamp()}.xlsx`, [
        {
          name: "人才库",
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
      message.success(`${label}（Excel）`);
    } catch (err) {
      message.error((err as Error).message || "导出失败");
    } finally {
      setExporting(false);
    }
  };

  // 导出单份简历：根据 resume_url 扩展名判断原文件格式，PDF 导出 PDF、Word 导出 Word
  const handleExportResume = async (record: Talent) => {
    if (!record.resume_url) { message.warning("该人才暂无简历文件"); return; }
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
      message.success(`正在导出 ${record.name} 的${typeLabel}简历`);
    } catch (e) {
      message.error((e as Error).message || "导出失败");
    }
  };

  // ---- 高级筛选字段（低频，收进抽屉；高频四项在搜索行做快筛）----
  const controlStyle: React.CSSProperties = { width: "100%" };
  const advancedDefs: { key: string; label: string; control: React.ReactNode }[] = [
    { key: "name", label: "姓名", control: <Input style={controlStyle} placeholder="请输入姓名" value={draft.name} onChange={(e) => setField("name", e.target.value)} onPressEnter={handleSearch} allowClear /> },
    { key: "title", label: "职位", control: <Input style={controlStyle} placeholder="请输入职位" value={draft.title} onChange={(e) => setField("title", e.target.value)} onPressEnter={handleSearch} allowClear /> },
    { key: "major", label: "专业", control: <Input style={controlStyle} placeholder="请输入专业" value={draft.major} onChange={(e) => setField("major", e.target.value)} onPressEnter={handleSearch} allowClear /> },
    { key: "phone", label: "手机号", control: <Input style={controlStyle} placeholder="请输入手机号" value={draft.phone} onChange={(e) => setField("phone", e.target.value)} onPressEnter={handleSearch} allowClear /> },
    {
      key: "years", label: "年限",
      control: (
        <Space.Compact style={controlStyle}>
          <InputNumber style={{ width: "50%" }} value={draft.years_min} onChange={(v) => setField("years_min", v ?? null)} min={0} max={50} placeholder="最小" />
          <InputNumber style={{ width: "50%" }} value={draft.years_max} onChange={(v) => setField("years_max", v ?? null)} min={0} max={50} placeholder="最大" />
        </Space.Compact>
      ),
    },
    {
      key: "age", label: "年龄",
      control: (
        <Space.Compact style={controlStyle}>
          <InputNumber style={{ width: "50%" }} value={draft.age_min} onChange={(v) => setField("age_min", v ?? null)} min={16} max={80} placeholder="最小" />
          <InputNumber style={{ width: "50%" }} value={draft.age_max} onChange={(v) => setField("age_max", v ?? null)} min={16} max={80} placeholder="最大" />
        </Space.Compact>
      ),
    },
    { key: "entry_type", label: "录入方式", control: <Select style={controlStyle} value={draft.entry_type || undefined} onChange={(v) => setField("entry_type", v || "")} allowClear placeholder="全部方式" options={ENTRY_TYPE_OPTIONS} /> },
    ...(isAdmin && users.length > 0
      ? [{ key: "owner_id", label: "创建人", control: <Select style={controlStyle} value={draft.owner_id || undefined} onChange={(v) => setField("owner_id", v || "")} allowClear placeholder="请选择创建人" options={users.map((u) => ({ label: u.name, value: u.id }))} /> }]
      : []),
  ];

  // ---- 已选条件 chips：把「当前到底筛了什么」摆到明面上，一条一条可摘 ----
  const clearFilter = (patch: Partial<Filters>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setApplied((a) => ({ ...a, ...patch }));
    setPage(1);
  };
  const activeChips: { key: string; text: string; clear: () => void; advanced: boolean }[] = [];
  {
    const f = applied;
    if (f.name) activeChips.push({ key: "name", text: `姓名：${f.name}`, clear: () => clearFilter({ name: "" }), advanced: true });
    if (f.title) activeChips.push({ key: "title", text: `职位：${f.title}`, clear: () => clearFilter({ title: "" }), advanced: true });
    if (f.major) activeChips.push({ key: "major", text: `专业：${f.major}`, clear: () => clearFilter({ major: "" }), advanced: true });
    if (f.phone) activeChips.push({ key: "phone", text: `手机：${f.phone}`, clear: () => clearFilter({ phone: "" }), advanced: true });
    if (f.entry_type) activeChips.push({ key: "entry_type", text: `录入：${ENTRY_TYPE_LABELS[f.entry_type] || f.entry_type}`, clear: () => clearFilter({ entry_type: "" }), advanced: true });
    if (f.owner_id) {
      const owner = users.find((u) => u.id === f.owner_id);
      activeChips.push({ key: "owner_id", text: `创建人：${owner?.name || f.owner_id}`, clear: () => clearFilter({ owner_id: "" }), advanced: true });
    }
    if (f.years_min != null || f.years_max != null) {
      activeChips.push({ key: "years", text: `年限：${f.years_min ?? 0}-${f.years_max ?? "不限"}`, clear: () => clearFilter({ years_min: null, years_max: null }), advanced: true });
    }
    if (f.age_min != null || f.age_max != null) {
      activeChips.push({ key: "age", text: `年龄：${f.age_min ?? 16}-${f.age_max ?? "不限"}`, clear: () => clearFilter({ age_min: null, age_max: null }), advanced: true });
    }
    if (f.status) activeChips.push({ key: "status", text: `状态：${STATUS_LABELS[f.status] || f.status}`, clear: () => clearFilter({ status: "" }), advanced: false });
    if (f.education.length) activeChips.push({ key: "education", text: `学历：${f.education.join(" / ")}`, clear: () => clearFilter({ education: [] }), advanced: false });
    if (f.city.length) activeChips.push({ key: "city", text: `城市：${f.city.join(" / ")}`, clear: () => clearFilter({ city: [] }), advanced: false });
    if (f.tags) activeChips.push({ key: "tags", text: `标签：${f.tags.split(",").filter(Boolean).join(" / ")}`, clear: () => clearFilter({ tags: "" }), advanced: false });
    if (f.q) activeChips.push({ key: "q", text: `关键词：${f.q}`, clear: () => clearFilter({ q: "" }), advanced: false });
  }
  const advancedActiveCount = activeChips.filter((c) => c.advanced).length;

  // 受控多选：跨页保留非本页选中，本页按新 keys 重建（全站统一写法，勿加 some 去重）
  const pageKeySet = new Set<React.Key>(talents.map((t) => t.id));
  const rowSelection = {
    selectedRowKeys: selectedKeys,
    onChange: (keys: React.Key[]) => {
      setSelectedKeys([...selectedKeys.filter((k) => !pageKeySet.has(k)), ...keys]);
    },
  };

  // 列定义按 key 收进 colMap，再按「列设置」勾选结果组装
  // （候选人 / 流程阶段 / 下一步 / 操作 常显，其余可显隐）
  const colMap: Record<string, any> = {
    candidate: {
      title: "候选人",
      // dataIndex 只为排序服务：antd 的 sorter.field 取自 dataIndex，
      // 不给它就没有字段名，点列头排序会静默失效（render 仍走自定义单元格）
      dataIndex: "name",
      key: "candidate",
      width: 300,
      fixed: "left" as const,
      sorter: true,
      sortOrder: sortField === "name" ? sortOrder || undefined : null,
      render: (_: unknown, record: Talent) => <CandidateCell t={record} />,
    },
    stage: {
      title: "流程阶段",
      key: "stage",
      width: 140,
      render: (_: unknown, record: Talent) => <StageProgress stage={record.stage} />,
    },
    next_follow_at: {
      title: "下一步",
      dataIndex: "next_follow_at",
      key: "next_follow_at",
      width: 130,
      sorter: true,
      sortOrder: sortField === "next_follow_at" ? sortOrder || undefined : null,
      render: (_: unknown, record: Talent) => <NextStepCell value={record.next_follow_at} />,
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
    updated_at: {
      title: "最近更新",
      dataIndex: "updated_at",
      key: "updated_at",
      width: 110,
      sorter: true,
      sortOrder: sortField === "updated_at" ? sortOrder || undefined : null,
      render: (v: string) => <UpdatedCell value={v} />,
    },
    action: {
      title: "操作",
      key: "action",
      width: 220,
      fixed: "right" as const,
      render: (_: any, record: Talent) => {
        // 四个动作全部平铺：详情 / 预览简历 / 导出 / 删除，一次点击可达。
        // 没有简历的行把「预览简历」「导出」置灰而不是隐藏，保证每行按钮位置对齐；
        // 删除走 Modal.confirm（确认框独立于表格渲染，不会像 Popconfirm 那样
        // 因为触发器收起而弹不出来）。编辑入口收敛到详情页。
        const hasResume = !!record.resume_url;
        return (
          <Space size={0}>
            <Button type="link" size="small" onClick={() => navigate(`/talents/${record.id}`)}>详情</Button>
            <Button type="link" size="small" disabled={!hasResume} onClick={() => setPreviewTalent(record)}>预览简历</Button>
            <Button type="link" size="small" disabled={!hasResume} onClick={() => handleExportResume(record)}>导出</Button>
            <Button
              type="link"
              size="small"
              danger
              onClick={() => Modal.confirm({
                title: `确认删除「${record.name}」？`,
                content: "所有关联数据将被清除，且不可恢复。",
                okText: "删除",
                okType: "danger",
                cancelText: "取消",
                onOk: () => handleDelete(record.id, record.name),
              })}
            >
              删除
            </Button>
          </Space>
        );
      },
    },
  };

  // 组装列：候选人 → 流程阶段 → 下一步 → 按勾选结果排可选列（创建人列仅 admin 可见）→ 操作
  const optionalKeys = OPTIONAL_COL_ORDER.filter((k) => k !== "owner_name" || isAdmin);
  const shownKeys = optionalKeys.filter((k) => visibleCols.includes(k));
  const columns = [
    colMap.candidate,
    colMap.stage,
    colMap.next_follow_at,
    ...shownKeys.map((k) => colMap[k]),
    colMap.action,
  ];
  // 横向滚动宽度跟随可见列宽计算，避免固定值在少列时出现过宽空白。
  // 额外 44 是 rowSelection 勾选列（不在 columns 里，但占宽度）。
  const scrollX = (colMap.candidate.width + colMap.stage.width + colMap.next_follow_at.width + colMap.action.width + 44)
    + shownKeys.reduce((a, k) => a + (colMap[k]?.width || 120), 0);

  // 列设置选项（创建人仅 admin 展示）
  const colSettingOptions = optionalKeys.map((k) => ({ label: OPTIONAL_COL_LABELS[k], value: k }));

  // 表格受控分页 + 排序：排序变化时回到第 1 页，避免停留在不存在的页。
  // 候选人列没有 dataIndex（render 自带），antd 只在 field 里给 undefined，
  // 真实字段名在 columnKey 上——两者都要读，否则点列头排序不生效。
  const handleTableChange = (
    pg: { current?: number; pageSize?: number },
    _filters: unknown,
    sorter: unknown,
  ) => {
    const s = Array.isArray(sorter) ? null : (sorter as { field?: string; columnKey?: string; order?: "ascend" | "descend" } | null);
    const newField = (s?.field as string) || (s?.columnKey as string) || "";
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

  // 工具行「更多」：低频动作收进来，工具行只留三个动作 + 录入主入口
  const moreMenuItems: MenuProps["items"] = [
    { key: "history", label: "导入记录", icon: <HistoryOutlined /> },
    { key: "match", label: "人才 AI 匹配", icon: <RobotOutlined /> },
    { key: "inventory", label: "AI 盘点", icon: <RobotOutlined /> },
    { type: "divider" as const },
    { key: "cols", label: "列设置", icon: <SettingOutlined /> },
  ];
  const onMoreMenuClick: MenuProps["onClick"] = ({ key }) => {
    if (key === "history") setImportHistoryOpen(true);
    else if (key === "match") navigate("/match", { state: { from: "talents" } });
    else if (key === "inventory") genInventory();
    else if (key === "cols") setColSettingOpen(true);
  };

  const statusOptions = Object.entries(STATUS_LABELS).map(([k, v]) => ({ label: v, value: k }));
  const citySelectOptions = cityOptions.map((c) => ({ label: c, value: c }));

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

      {/* 搜索区：一个搜索框（支持 字段:值 语法）+ 四个高频快筛（点完立即生效）+
          其余字段进「高级筛选」抽屉。原来的 11 字段表单默认只露 4 个，
          城市+学历+状态这种日常组合每次都要展开→填→收起。 */}
      <Card className="search-card tl-search-card" style={{ marginBottom: 16 }}>
        <div className="tl-search">
          <Input
            className="tl-search-input"
            allowClear
            prefix={<SearchOutlined style={{ color: "#b0b6c0" }} />}
            placeholder="搜索姓名 / 公司 / 职位 / 技能；也可写 城市:杭州 学历:本科"
            value={draft.q}
            onChange={(e) => {
              const v = e.target.value;
              setField("q", v);
              // 清空输入框（✕ 或删光）时立即撤掉已生效的关键词，
              // 否则列表还停在旧结果上，人会以为清空没生效
              if (!v && applied.q) applyNow({ q: "" });
            }}
            onPressEnter={handleSearch}
          />
          <Select
            className="tl-quick" placeholder="状态" allowClear
            value={draft.status || undefined}
            onChange={(v) => applyNow({ status: v || "" })}
            options={statusOptions}
          />
          <Select
            className="tl-quick" mode="multiple" maxTagCount="responsive" placeholder="学历" allowClear
            value={draft.education}
            onChange={(v) => applyNow({ education: (v || []) as string[] })}
            options={educationOptions.map((e) => ({ label: e, value: e }))}
          />
          <Select
            className="tl-quick" mode="tags" maxTagCount="responsive" placeholder="城市" allowClear
            value={draft.city}
            onChange={(v) => applyNow({ city: (v || []) as string[] })}
            options={citySelectOptions}
            tokenSeparators={[",", "，"]}
          />
          <Select
            className="tl-quick" mode="tags" placeholder="标签" allowClear
            value={draft.tags ? draft.tags.split(",").filter(Boolean) : undefined}
            onChange={(v) => applyNow({ tags: (v || []).join(",") })}
            tokenSeparators={[","]}
          />
          <Button icon={<FilterOutlined />} onClick={() => setAdvOpen(true)}>
            高级筛选{advancedActiveCount > 0 ? `（${advancedActiveCount}）` : ""}
          </Button>
          <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>查询</Button>
          <Tooltip title="清空全部筛选条件">
            <Button icon={<ReloadOutlined />} onClick={handleReset} />
          </Tooltip>
        </div>
        {/* 已选条件：一眼看到「现在到底筛了什么」，每条可单独摘掉 */}
        {activeChips.length > 0 && (
          <div className="tl-chips">
            {activeChips.map((c) => (
              <button key={c.key} type="button" className="tl-chip-item" onClick={c.clear}>
                {c.text}
                <CloseOutlined className="tl-chip-x" />
              </button>
            ))}
            <Button type="link" size="small" onClick={handleReset}>清空全部</Button>
          </div>
        )}
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
        {/* 工具行：左侧只留两个录入主入口 + 导出；导入记录/AI 匹配/AI 盘点/列设置收进「更多」。
            右侧在勾选时变成「已选 N 项 · 导出选中」，让勾选这件事有明确出口。 */}
        <div className="toolbar">
          <Space>
            <Button
              type="primary" icon={<PlusOutlined />}
              data-onb-action="new-talent"
              onClick={() => { setTalentPrefill(undefined); setAddOpen(true); }}
            >
              {"新增人才"}
            </Button>
            {/* 与「新增人才」同为录入主入口，统一 type="primary" */}
            <Button type="primary" icon={<ImportOutlined />} onClick={() => setImportModalOpen(true)}>导入</Button>
            <Dropdown menu={{ items: exportMenuItems, onClick: onExportMenuClick }} disabled={exporting}>
              <Button icon={<ExportOutlined />} loading={exporting}>导出</Button>
            </Dropdown>
            <Dropdown menu={{ items: moreMenuItems, onClick: onMoreMenuClick }}>
              <Button icon={<MoreOutlined />}>更多</Button>
            </Dropdown>
          </Space>
          <Space size={12}>
            {selectedKeys.length > 0 ? (
              <>
                <Typography.Text style={{ fontSize: 13 }}>已选 {selectedKeys.length} 项</Typography.Text>
                <Button size="small" onClick={() => handleExportExcel()} loading={exporting}>导出选中</Button>
                <Button size="small" type="link" onClick={() => setSelectedKeys([])}>取消选择</Button>
              </>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>共 {total} 位人才</Typography.Text>
            )}
          </Space>
        </div>
        <Table
          className="profiles-table"
          columns={columns}
          dataSource={talents}
          rowKey="id"
          loading={loading}
          rowSelection={rowSelection}
          // 整行可点进详情：原来唯一入口是那个蓝色姓名，用户扫到行尾找入口会落空。
          // 三种情况必须让行点击失效，否则会抢掉用户本来要做的事：
          //   1. 点在勾选框/按钮/链接/下拉上——那是另一个明确意图；
          //   2. 用户正在拖选文字（手机号那列经常要复制）；
          //   3. 选中态是点击后的默认结果，不做额外处理。
          onRow={(record) => ({
            style: { cursor: "pointer" },
            onClick: (e) => {
              const el = e.target as HTMLElement;
              if (el.closest("button, a, input, label, .ant-checkbox-wrapper, .ant-table-selection-column, .ant-dropdown-trigger")) return;
              if (window.getSelection()?.toString()) return;
              navigate(`/talents/${record.id}`);
            },
          })}
          onChange={handleTableChange}
          scroll={{ x: scrollX }}
          locale={{
          // 加载失败 ≠ 空库：给可重试的错误态；正常空库才显示录入引导
          emptyText: loadError ? (
            <div style={{ padding: "40px 0", textAlign: "center" }}>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={<Typography.Text type="secondary">人才列表加载失败：{loadError}</Typography.Text>}
              />
              <Button type="primary" onClick={fetchTalents} style={{ marginTop: 12 }}>重新加载</Button>
            </div>
          ) : (
            // 空库引导：第一次进来别只看一个干巴巴的「暂无数据」。
            // 注意区分「库是空的」和「筛出来是空的」——后者要提示清条件，否则用户以为数据丢了
            activeChips.length > 0 ? (
              <div style={{ padding: "40px 0", textAlign: "center" }}>
                <Empty description={"没有符合条件的人才"} image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginBottom: 16 }} />
                <Button onClick={handleReset}>清空筛选条件</Button>
              </div>
            ) : (
              <div style={{ padding: "40px 0", textAlign: "center" }}>
                <Empty description={"人才库还是空的"} image={Empty.PRESENTED_IMAGE_SIMPLE} style={{ marginBottom: 16 }} />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {"点左上角「新增人才」或「导入」开始录入真实数据"}
                </Typography.Text>
              </div>
            )
          ),
          }}
          pagination={{
            current: page,
            total,
            pageSize,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50, 100],
            showTotal: (t) => `共 ${t} 位人才`,
          }}
        />
      </Card>

      {/* 打印导出容器：仅在打印时显示 */}
      {printData && (
        <div className="export-print-area" dangerouslySetInnerHTML={{ __html: buildExportHtml(printData, buildExportColumns()) }} />
      )}

      {/* 高级筛选：低频字段集中在这里，不占用列表上方的常驻空间 */}
      <Drawer
        title="高级筛选"
        open={advOpen}
        onClose={() => setAdvOpen(false)}
        width={420}
        extra={
          <Space>
            <Button size="small" onClick={() => { setDraft(EMPTY_FILTERS); setApplied(EMPTY_FILTERS); setPage(1); }}>重置</Button>
            <Button size="small" type="primary" onClick={() => { handleSearch(); setAdvOpen(false); }}>应用</Button>
          </Space>
        }
      >
        <div className="tl-drawer-fields">
          {advancedDefs.map((d) => (
            <div key={d.key} className="search-field">
              <span className="search-label">{d.label}</span>
              <div className="search-control">{d.control}</div>
            </div>
          ))}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          状态 / 学历 / 城市 / 标签 在搜索行直接选，不用进这里。
        </Typography.Text>
      </Drawer>

      {/* 列设置：勾选要显示的列，选择存 localStorage */}
      <Modal
        title="列设置"
        open={colSettingOpen}
        onCancel={() => setColSettingOpen(false)}
        footer={<Button type="primary" onClick={() => setColSettingOpen(false)}>完成</Button>}
        width={420}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          候选人、流程阶段、下一步、操作 固定显示
        </Typography.Text>
        <Checkbox.Group
          value={visibleCols}
          options={colSettingOptions}
          onChange={(vals) => changeVisibleCols(vals as string[])}
          style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}
        />
      </Modal>

      {/* 导入弹窗（上传 → 逐份核对 → 保存即写入人才库） */}
      <ImportModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onSuccess={refreshAfterImport}
      />

      {/* 导入记录（上传 N 份 / 录入 N 份 / 失败 N 份，逐份可查）。
          懒加载 + 门控：不打开就不下载这份代码，也不影响首屏 */}
      <Suspense fallback={null}>
        {importHistoryOpen && (
          <ImportHistoryModal open onClose={() => setImportHistoryOpen(false)} />
        )}
      </Suspense>

      {/* 简历预览弹窗（PDF 原生渲染保留格式；Word 在线转 HTML 查看，不下载） */}
      <ResumePreviewModal talent={previewTalent} onClose={() => setPreviewTalent(null)} />

      {/* 新增人才弹窗：列表的行内编辑已移除，改资料请点「详情」进详情页编辑 */}
      <TalentFormModal
        open={addOpen}
        talentId={null}
        prefill={talentPrefill}
        fillToken={talentFillToken}
        onClose={() => { setAddOpen(false); setTalentPrefill(undefined); }}
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
    </div>
  );
}
