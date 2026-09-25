import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import {
  Card, Table, Input, InputNumber, Select, Button, Space, Tag,
  Popconfirm, message, Dropdown, Alert, Modal,
} from "antd";
import {
  ImportOutlined, FilePdfOutlined, ExportOutlined,
  SearchOutlined, ReloadOutlined, DownOutlined, UpOutlined,
  FileWordOutlined, TeamOutlined,
} from "@ant-design/icons";
import type { MenuProps } from "antd";
import { api } from "../api";
import type { Talent, User, ComplianceItem, ComplianceResponse } from "../types";
import { STATUS_LABELS, STATUS_COLORS, EDUCATION_OPTIONS } from "../types";
import ImportModal from "../components/ImportModal";
import ResumePreviewModal from "../components/ResumePreviewModal";
import TalentFormModal from "../components/TalentFormModal";
import AddToPipelineModal from "../components/AddToPipelineModal";

// 搜索条件（draft = 编辑中，applied = 已生效）
interface Filters {
  name: string;
  phone: string;
  education: string;
  years: number | null;
  title: string;
  status: string;
  owner_id: string;
}

const EMPTY_FILTERS: Filters = {
  name: "", phone: "", education: "",
  years: null, title: "", status: "", owner_id: "",
};

// 搜索条件 → 查询参数。列表查询与导出共用一份，
// 避免两处各写一遍导致「导出的数据和列表看到的不一致」。
function buildFilterParams(f: Filters): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  if (f.name) params.name = f.name;
  if (f.phone) params.phone = f.phone;
  if (f.education) params.education = f.education;
  if (f.years != null) params.years = f.years;
  if (f.title) params.title = f.title;
  if (f.status) params.status = f.status;
  if (f.owner_id) params.owner_id = f.owner_id;
  return params;
}

// 收起时展示的字段数（默认展开一行 4 个）
const COLLAPSED_COUNT = 4;

// 列表每页条数
const PAGE_SIZE = 10;

import { escapeHtml, downloadBlob } from "../utils/file";

function dateStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

export default function TalentList() {
  const [talents, setTalents] = useState<Talent[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [expanded, setExpanded] = useState(false);

  // 弹窗状态
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [previewTalent, setPreviewTalent] = useState<Talent | null>(null);
  const [editId, setEditId] = useState<string | null>(null);

  // 批量加入招聘流程：受控多选（跨页保留选中）+ 弹窗
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);

  // 合规到期提醒：合同 / 试用期 30 天内到期
  const [compliance, setCompliance] = useState<ComplianceResponse | null>(null);
  const [complianceOpen, setComplianceOpen] = useState(false);

  // 导出状态
  const [exporting, setExporting] = useState(false);
  const [printData, setPrintData] = useState<Talent[] | null>(null);

  const currentUser: User | null = (() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  })();
  const isAdmin = currentUser?.role === "admin";

  const fetchTalents = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { page, limit: PAGE_SIZE, ...buildFilterParams(applied) };
      const res = await api.getTalents(params);
      setTalents(res.items);
      setTotal(res.total);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, [page, applied]);

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
    setApplied({ ...draft });
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

  // 拉取当前筛选条件下的全量数据（用于导出）
  const fetchAllForExport = async (): Promise<Talent[]> => {
    const params = { ...buildFilterParams(applied), page: 1, limit: 10000 };
    const res = await api.getTalents(params);
    return res.items;
  };

  // 导出字段顺序与列表一致
  const exportColumns: { key: string; title: string; get: (t: Talent) => string }[] = [
    { key: "name", title: "姓名", get: (t) => t.name || "" },
    { key: "current_title", title: "职位", get: (t) => t.current_title || "" },
    { key: "years_experience", title: "年限", get: (t) => (t.years_experience != null ? `${t.years_experience}年` : "") },
    { key: "age", title: "年龄", get: (t) => (t.age != null ? String(t.age) : "") },
    { key: "education", title: "学历", get: (t) => t.education || "" },
    { key: "school", title: "院校", get: (t) => t.school || "" },
    { key: "city", title: "城市", get: (t) => t.city || "" },
    { key: "phone", title: "手机号", get: (t) => t.phone || "" },
    { key: "email", title: "邮箱", get: (t) => t.email || "" },
    { key: "current_company", title: "当前公司", get: (t) => t.current_company || "" },
    { key: "industry", title: "行业", get: (t) => t.industry || "" },
    { key: "expected_salary", title: "期望薪资", get: (t) => t.expected_salary || "" },
    { key: "skills", title: "技能", get: (t) => (t.skills || []).join("、") },
    { key: "status", title: "状态", get: (t) => STATUS_LABELS[t.status] || t.status || "" },
    { key: "owner_name", title: "创建人", get: (t) => t.owner_name || "" },
    { key: "created_at", title: "创建时间", get: (t) => t.created_at || "" },
  ];

  // 生成导出表格 HTML（Word 与 PDF 打印共用）
  const buildExportHtml = (rows: Talent[]): string => {
    const thead = exportColumns.map((c) => `<th>${c.title}</th>`).join("");
    const tbody = rows.map((t) => {
      const tds = exportColumns.map((c) => `<td>${escapeHtml(c.get(t))}</td>`).join("");
      return `<tr>${tds}</tr>`;
    }).join("");
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>人才库导出</title>
<style>
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; margin: 24px; color: #333; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #999; font-size: 12px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; }
  tr:nth-child(even) td { background: #fafafa; }
</style></head><body>
<h1>人才库导出</h1>
<div class="sub">共 ${rows.length} 人 · 导出时间 ${new Date().toLocaleString("zh-CN")}</div>
<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>
</body></html>`;
  };

  // 导出 Word（.doc 格式，Word 可直接打开 HTML）
  const handleExportWord = async () => {
    try {
      setExporting(true);
      const rows = await fetchAllForExport();
      if (rows.length === 0) { message.warning("暂无数据可导出"); return; }
      const html = buildExportHtml(rows);
      const blob = new Blob(["\ufeff" + html], { type: "application/msword;charset=utf-8" });
      downloadBlob(blob, `人才库导出_${dateStamp()}.doc`);
      message.success(`已导出 ${rows.length} 条人才（Word）`);
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
      const rows = await fetchAllForExport();
      if (rows.length === 0) { message.warning("暂无数据可导出"); return; }
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
    { key: "word", label: "导出 Word", icon: <FileWordOutlined /> },
    { key: "pdf", label: "导出 PDF", icon: <FilePdfOutlined /> },
  ];

  const onExportMenuClick: MenuProps["onClick"] = ({ key }) => {
    if (key === "word") handleExportWord();
    else if (key === "pdf") handleExportPdf();
  };

  // 导出单份简历：根据 resume_url 扩展名判断原文件格式，PDF 导出 PDF、Word 导出 Word
  const handleExportResume = (record: Talent) => {
    if (!record.resume_url) { message.warning("该人才暂无简历文件"); return; }
    const ext = (record.resume_url.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
    const isWord = ext === "docx" || ext === "doc";
    const isPdf = ext === "pdf";
    const typeLabel = isWord ? "Word" : isPdf ? "PDF" : "简历";
    // 触发浏览器下载（后端 Content-Disposition: attachment）
    const a = document.createElement("a");
    a.href = api.getResumeDownloadUrl(record.id);
    a.download = `${record.name}_${typeLabel}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    message.success(`正在导出 ${record.name} 的${typeLabel}简历`);
  };

  // ---- 搜索字段定义（label 左 + 控件右，一行 4 个）----
  const controlStyle: React.CSSProperties = { width: "100%" };
  const fieldDefs: { key: string; label: string; control: React.ReactNode }[] = [
    { key: "name", label: "姓名", control: <Input style={controlStyle} placeholder="请输入姓名" value={draft.name} onChange={(e) => setField("name", e.target.value)} onPressEnter={handleSearch} allowClear /> },
    { key: "title", label: "职位", control: <Input style={controlStyle} placeholder="请输入职位" value={draft.title} onChange={(e) => setField("title", e.target.value)} onPressEnter={handleSearch} allowClear /> },
    { key: "years", label: "年限", control: <InputNumber style={controlStyle} value={draft.years} onChange={(v) => setField("years", v ?? null)} min={0} max={50} placeholder="请输入年限" /> },
    { key: "education", label: "学历", control: <Select style={controlStyle} value={draft.education || undefined} onChange={(v) => setField("education", v || "")} allowClear placeholder="请选择学历" options={EDUCATION_OPTIONS.map((e) => ({ label: e, value: e }))} /> },
    { key: "phone", label: "手机号", control: <Input style={controlStyle} placeholder="请输入手机号" value={draft.phone} onChange={(e) => setField("phone", e.target.value)} onPressEnter={handleSearch} allowClear /> },
    { key: "status", label: "状态", control: <Select style={controlStyle} value={draft.status || undefined} onChange={(v) => setField("status", v || "")} allowClear placeholder="请选择状态" options={Object.entries(STATUS_LABELS).map(([k, v]) => ({ label: v, value: k }))} /> },
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

  const columns = [
    {
      title: "姓名",
      dataIndex: "name",
      key: "name",
      width: 120,
      fixed: "left" as const,
      render: (text: string, record: Talent) => (
        <Link to={`/talents/${record.id}`} style={{ fontWeight: 600 }}>{text}</Link>
      ),
    },
    { title: "职位", dataIndex: "current_title", key: "current_title", width: 150, render: (v: string) => v || "—" },
    {
      title: "年限", dataIndex: "years_experience", key: "years_experience", width: 90,
      render: (v: number | null) => (v != null ? `${v}年` : "—"),
    },
    { title: "年龄", dataIndex: "age", key: "age", width: 80, render: (v: number | null) => (v != null ? v : "—") },
    { title: "学历", dataIndex: "education", key: "education", width: 110, render: (v: string) => v || "—" },
    { title: "院校", dataIndex: "school", key: "school", width: 160, render: (v: string) => v || "—" },
    { title: "城市", dataIndex: "city", key: "city", width: 90, render: (v: string) => v || "—" },
    { title: "手机号", dataIndex: "phone", key: "phone", width: 130, render: (v: string) => v || "—" },
    { title: "邮箱", dataIndex: "email", key: "email", width: 200, render: (v: string) => v || "—" },
    {
      title: "状态",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (status: string) => (
        <Tag color={STATUS_COLORS[status] || "default"}>
          {STATUS_LABELS[status] || status}
        </Tag>
      ),
    },
    ...(isAdmin ? [{
      title: "创建人",
      dataIndex: "owner_name",
      key: "owner_name",
      width: 120,
      render: (v: string) => v || "—",
    }] : []),
    {
      title: "操作",
      key: "action",
      width: 170,
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
  ];

  return (
    <div>
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
        {/* 布局约定（全站统一）：搜索 Card 只放搜索字段（label 左 / 控件右，一行 4 个）；
            顶部工具行左侧是「导入/导出」等数据操作，右侧是「展开收起 / 重置 / 查询」，
            两者形成一条对齐的右侧操作区，不要另起一行。 */}
        <div className="toolbar">
          <Space>
            <Button icon={<ImportOutlined />} onClick={() => setImportModalOpen(true)}>导入</Button>
            <Dropdown menu={{ items: exportMenuItems, onClick: onExportMenuClick }} disabled={exporting}>
              <Button icon={<ExportOutlined />} loading={exporting}>导出</Button>
            </Dropdown>
            <Button
              icon={<TeamOutlined />}
              disabled={selectedKeys.length === 0}
              onClick={() => setBatchOpen(true)}
            >
              加入流程{selectedKeys.length > 0 ? `（${selectedKeys.length} 人）` : ""}
            </Button>
          </Space>
          <Space>
            {fieldDefs.length > COLLAPSED_COUNT && (
              <Button type="link" size="small" onClick={() => setExpanded(!expanded)}>
                {expanded ? <>收起 <UpOutlined /></> : <>展开 <DownOutlined /></>}
              </Button>
            )}
            <Button icon={<ReloadOutlined />} onClick={handleReset}>重置</Button>
            <Button type="primary" icon={<SearchOutlined />} onClick={handleSearch}>查询</Button>
          </Space>
        </div>
        <Table
          className="profiles-table"
          columns={columns}
          dataSource={talents}
          rowKey="id"
          loading={loading}
          rowSelection={rowSelection}
          scroll={{ x: 1500 }}
          pagination={{
            current: page,
            total,
            pageSize: PAGE_SIZE,
            onChange: (p) => setPage(p),
            showTotal: (t) => `共 ${t} 位人才`,
          }}
        />
      </Card>

      {/* 打印导出容器：仅在打印时显示 */}
      {printData && (
        <div className="export-print-area" dangerouslySetInnerHTML={{ __html: buildExportHtml(printData) }} />
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
        open={!!editId}
        talentId={editId}
        onClose={() => setEditId(null)}
        onSuccess={fetchTalents}
      />

      {/* 批量加入招聘流程：勾选人才 → 选岗位 → 一次挂入（已在流程中的自动跳过） */}
      <AddToPipelineModal
        open={batchOpen}
        presetTalentIds={selectedKeys.map(String)}
        onClose={() => setBatchOpen(false)}
        onSuccess={() => {
          setSelectedKeys([]);
          fetchTalents();
        }}
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
    </div>
  );
}
