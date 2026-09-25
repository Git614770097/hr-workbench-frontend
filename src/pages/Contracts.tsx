import { useState, useEffect, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import {
  Card, Table, Input, Select, Button, Space, Tag, DatePicker, Modal,
  Form, message, Alert, Upload, Popconfirm, Typography,
} from "antd";
import { SearchOutlined, ReloadOutlined, BellOutlined, InboxOutlined, PlusOutlined, UserOutlined, FileTextOutlined, ExclamationCircleOutlined, FileProtectOutlined, HourglassOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api";
import type { ContractItem, ContractFile, Talent } from "../types";
import { STATUS_LABELS } from "../types";
import { extractContractText } from "../utils/contractFile";
import AnimatedNumber from "../components/AnimatedNumber";

// 日期快捷预设（从今天起算）：试用期按月、合同按年。
// 三个弹窗（新增合同 / 合同文件 / 编辑日期）共用，保证体验一致。
const PROBATION_PRESETS = [
  { label: "一个月", value: dayjs().add(1, "month") },
  { label: "三个月", value: dayjs().add(3, "month") },
  { label: "六个月", value: dayjs().add(6, "month") },
];
const CONTRACT_PRESETS = [
  { label: "一年", value: dayjs().add(1, "year") },
  { label: "两年", value: dayjs().add(2, "year") },
  { label: "三年", value: dayjs().add(3, "year") },
];

/** 剩余天数：两侧都用 UTC 午夜基准相减，无时区跨日问题 */
function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const today = new Date(`${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T00:00:00Z`);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

/** 到期日 + 剩余天数 Tag（红=已过期 / 橙=30 天内 / 灰=充裕） */
function DateWithTag({ date }: { date: string | null }) {
  if (!date) return <span>—</span>;
  const left = daysUntil(date);
  let tag = null;
  if (left != null) {
    if (left < 0) tag = <Tag color="red" style={{ marginInlineEnd: 0 }}>已过期 {-left} 天</Tag>;
    else if (left <= 30) tag = <Tag color="orange" style={{ marginInlineEnd: 0 }}>仅剩 {left} 天</Tag>;
    else tag = <Tag style={{ marginInlineEnd: 0 }}>{left} 天</Tag>;
  }
  return (
    <Space size={6}>
      <span>{date}</span>
      {tag}
    </Space>
  );
}

/** 文件大小展示 */
function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 合同文件弹窗：上传原件（AI 自动识别日期 → 核对 → 应用到档案）+ 已传文件管理 */
function ContractFilesModal({
  talent, onClose, onApplied,
}: {
  talent: ContractItem | null;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [files, setFiles] = useState<ContractFile[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [reading, setReading] = useState(false);      // 正在本地抽取文本
  const [uploading, setUploading] = useState(false);  // 正在上传 + AI 识别
  const [applying, setApplying] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [form] = Form.useForm();

  const fetchFiles = useCallback(async (talentId: string) => {
    setListLoading(true);
    try {
      setFiles(await api.getContractFiles(talentId));
    } catch (e: any) {
      message.error(e?.message || "文件列表加载失败");
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!talent) return;
    setWarning(null);
    form.resetFields();
    fetchFiles(talent.id);
  }, [talent, fetchFiles, form]);

  const handleUpload = async (file: File) => {
    if (!talent) return;
    setReading(true);
    let text = "";
    try {
      text = await extractContractText(file);
    } catch (e: any) {
      message.warning(e?.message || "文件内容读取失败");
    } finally {
      setReading(false);
    }
    setUploading(true);
    try {
      const r = await api.uploadContractFile(talent.id, file, text);
      setWarning(r.warning);
      form.setFieldsValue({
        contract_end: r.extracted?.contract_end ? dayjs(r.extracted.contract_end) : null,
        probation_end: r.extracted?.probation_end ? dayjs(r.extracted.probation_end) : null,
      });
      if (r.extracted) message.success("上传成功，AI 已识别出日期，请核对后应用到档案");
      else message.info("文件已上传，未能自动识别日期，可手动填写后应用");
      fetchFiles(talent.id);
    } catch (e: any) {
      message.error(e?.message || "上传失败");
    } finally {
      setUploading(false);
    }
  };

  // 识别结果（或手动改过）→ 写入人才档案；PUT 后端会即时同步到期提醒待办
  const handleApply = async () => {
    if (!talent) return;
    const values = await form.validateFields();
    setApplying(true);
    try {
      await api.updateTalent(talent.id, {
        contract_end: values.contract_end ? values.contract_end.format("YYYY-MM-DD") : null,
        probation_end: values.probation_end ? values.probation_end.format("YYYY-MM-DD") : null,
      });
      message.success("合同日期已应用到档案，到期提醒待办已同步");
      onApplied();
    } catch (e: any) {
      message.error(e?.message || "应用失败");
    } finally {
      setApplying(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteContractFile(id);
      if (talent) fetchFiles(talent.id);
    } catch (e: any) {
      message.error(e?.message || "删除失败");
    }
  };

  const fileColumns = [
    {
      title: "文件名", dataIndex: "filename", key: "filename", ellipsis: true,
      render: (v: string, r: ContractFile) => (
        <a href={api.getContractFileUrl(r.id)} target="_blank" rel="noreferrer">{v}</a>
      ),
    },
    { title: "大小", dataIndex: "size", key: "size", width: 90, render: (v: number) => fmtSize(v) },
    {
      title: "AI 识别", key: "extracted", width: 220,
      render: (_: unknown, r: ContractFile) => {
        const parts: string[] = [];
        if (r.extracted_contract_end) parts.push(`合同 ${r.extracted_contract_end}`);
        if (r.extracted_probation_end) parts.push(`试用期 ${r.extracted_probation_end}`);
        return parts.length
          ? <Typography.Text type="secondary">{parts.join("，")}</Typography.Text>
          : <Typography.Text type="secondary">未识别</Typography.Text>;
      },
    },
    { title: "上传时间", dataIndex: "created_at", key: "created_at", width: 160, render: (v: string) => (v || "").replace("T", " ").slice(0, 16) },
    {
      title: "操作", key: "action", width: 110,
      render: (_: unknown, r: ContractFile) => (
        <Space size={4}>
          <a href={api.getContractFileUrl(r.id, true)}>下载</a>
          <Popconfirm title="确定删除该合同文件？" onConfirm={() => handleDelete(r.id)}>
            <Button type="link" size="small" danger style={{ paddingInline: 4 }}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Modal
      title={`合同文件 — ${talent?.name || ""}`}
      open={!!talent}
      onCancel={onClose}
      footer={null}
      width={720}
      destroyOnClose
    >
      <Upload.Dragger
        accept=".pdf,.docx"
        showUploadList={false}
        disabled={reading || uploading}
        beforeUpload={(f) => { handleUpload(f as unknown as File); return false; }}
        style={{ marginTop: 16 }}
      >
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">
          {reading ? "正在读取文件内容…" : uploading ? "上传中，AI 识别日期…" : "点击或拖拽合同文件到这里上传"}
        </p>
        <p className="ant-upload-hint">支持 PDF / Word（.docx），上传后自动识别合同到期日与试用期到期日</p>
      </Upload.Dragger>

      {(reading || uploading || warning) && (
        <Alert
          style={{ marginTop: 12 }}
          type={warning ? "warning" : "info"}
          showIcon
          message={reading ? "正在读取文件内容…" : uploading ? "正在上传并识别日期…" : warning || ""}
        />
      )}

      <Form form={form} layout="horizontal" labelCol={{ span: 5 }} wrapperCol={{ span: 17 }} style={{ marginTop: 16 }}>
        <Form.Item name="contract_end" label="合同到期日" extra="AI 预填，可修改；应用到档案后自动生成/更新到期提醒待办">
          <DatePicker style={{ width: "100%" }} placeholder="合同到期日" allowClear presets={CONTRACT_PRESETS} />
        </Form.Item>
        <Form.Item name="probation_end" label="试用期到期日">
          <DatePicker style={{ width: "100%" }} placeholder="试用期到期日" allowClear presets={PROBATION_PRESETS} />
        </Form.Item>
        <Form.Item wrapperCol={{ offset: 5, span: 17 }} style={{ marginBottom: 8 }}>
          <Button type="primary" loading={applying} onClick={handleApply}>应用到档案</Button>
        </Form.Item>
      </Form>

      <Table
        size="small"
        columns={fileColumns}
        dataSource={files}
        rowKey="id"
        loading={listLoading}
        pagination={false}
        locale={{ emptyText: "暂无合同文件" }}
      />
    </Modal>
  );
}

/** 新增合同弹窗：没填过日期的人才不会出现在合同列表里，这里是它们的统一入口。
 *  选人才 → 上传合同文件（AI 识别预填，文件同时存档）或直接手填日期 → 保存到档案。 */
function AddContractModal({
  open, onClose, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [talentId, setTalentId] = useState<string | null>(null);
  const [selectedTalent, setSelectedTalent] = useState<Talent | null>(null);
  const [talentLoading, setTalentLoading] = useState(false);
  const [talentOptions, setTalentOptions] = useState<{ label: string; value: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [reading, setReading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [extracted, setExtracted] = useState<{ contract_end: string | null; probation_end: string | null } | null>(null);
  const [aiFilled, setAiFilled] = useState(false);
  const [form] = Form.useForm();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchTalents = useCallback(async (q: string) => {
    setSearching(true);
    try {
      const r = await api.getTalents({ q, page: 1, limit: 20 });
      setTalentOptions(
        r.items.map((t) => ({ label: t.phone ? `${t.name}（${t.phone}）` : t.name, value: t.id }))
      );
    } catch { /* 搜索失败不打断输入 */ } finally {
      setSearching(false);
    }
  }, []);

  const debouncedSearch = useCallback((q: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => searchTalents(q), 300);
  }, [searchTalents]);

  useEffect(() => {
    if (!open) return;
    setTalentId(null);
    setSelectedTalent(null);
    setWarning(null);
    setFileName(null);
    setExtracted(null);
    setAiFilled(false);
    form.resetFields();
    searchTalents("");
  }, [open, form, searchTalents]);

  // 选择/切换人才：切换时重置已上传文件与 AI 预填（文件已挂到原人才名下，留着会误导）；
  // 手填日期不动。同时拉取人才详情回显现有合同日期，提示覆盖风险。
  const handleTalentChange = async (id: string | null) => {
    if (fileName || extracted) {
      setFileName(null);
      setExtracted(null);
      setWarning(null);
      setAiFilled(false);
      form.setFieldsValue({ contract_end: null, probation_end: null });
      message.info("已切换人才，上传的文件与识别结果已重置");
    }
    setTalentId(id);
    setSelectedTalent(null);
    if (!id) return;
    setTalentLoading(true);
    try {
      setSelectedTalent(await api.getTalent(id));
    } catch { /* 详情拉取失败不阻塞，仅少一行回显 */ } finally {
      setTalentLoading(false);
    }
  };

  // 上传合同文件：文本抽取 → 存档 + AI 识别 → 预填日期（文件已关联所选人才）
  const handleUpload = async (file: File) => {
    if (!talentId) return;
    setReading(true);
    let text = "";
    try {
      text = await extractContractText(file);
    } catch (e: any) {
      message.warning(e?.message || "文件内容读取失败");
    } finally {
      setReading(false);
    }
    setUploading(true);
    try {
      const r = await api.uploadContractFile(talentId, file, text);
      setWarning(r.warning);
      setFileName(file.name);
      setExtracted(r.extracted);
      setAiFilled(!!r.extracted);
      form.setFieldsValue({
        contract_end: r.extracted?.contract_end ? dayjs(r.extracted.contract_end) : null,
        probation_end: r.extracted?.probation_end ? dayjs(r.extracted.probation_end) : null,
      });
      if (r.extracted) message.success("AI 已识别出日期，请核对后保存");
      else message.info("文件已存档，未能自动识别日期，可手动填写");
    } catch (e: any) {
      message.error(e?.message || "上传失败");
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async () => {
    if (!talentId) {
      message.warning("请先选择人才");
      return;
    }
    const values = await form.validateFields();
    if (!values.contract_end && !values.probation_end) {
      message.warning("请至少填写合同到期日或试用期到期日");
      return;
    }
    setSaving(true);
    try {
      await api.updateTalent(talentId, {
        contract_end: values.contract_end ? values.contract_end.format("YYYY-MM-DD") : null,
        probation_end: values.probation_end ? values.probation_end.format("YYYY-MM-DD") : null,
      });
      message.success("合同已新增，到期提醒待办已同步");
      onSaved();
      onClose();
    } catch (e: any) {
      message.error(e?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="新增合同"
      open={open}
      onCancel={onClose}
      onOk={handleSave}
      confirmLoading={saving}
      okText="保存到档案"
      cancelText="取消"
      width={560}
      destroyOnClose
    >
      <Form form={form} layout="horizontal" labelCol={{ span: 6 }} wrapperCol={{ span: 16 }} style={{ marginTop: 16 }}>
        <Form.Item label="选择人才" required extra="没填过合同日期的人才不会出现在左侧列表，在这里搜索选择">
          <Select
            showSearch
            value={talentId}
            placeholder="输入姓名或手机号搜索"
            filterOption={false}
            loading={searching}
            options={talentOptions}
            onSearch={debouncedSearch}
            onChange={handleTalentChange}
            allowClear
            style={{ width: "100%" }}
          />
        </Form.Item>

        {/* 选中人才回显：现有合同日期 + 覆盖风险提示 */}
        {talentId && (
          <Form.Item wrapperCol={{ span: 20, offset: 2 }} style={{ marginBottom: 12 }}>
            {talentLoading ? (
              <Alert type="info" showIcon icon={<UserOutlined />} message="正在读取人才信息…" />
            ) : selectedTalent ? (
              <Alert
                type={selectedTalent.contract_end || selectedTalent.probation_end ? "warning" : "success"}
                showIcon
                icon={<UserOutlined />}
                message={
                  <Space size={6} wrap>
                    <span>{selectedTalent.name}{selectedTalent.phone ? `（${selectedTalent.phone}）` : ""}</span>
                    {selectedTalent.contract_end || selectedTalent.probation_end ? (
                      <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                        已有日期：{[selectedTalent.contract_end && `合同 ${selectedTalent.contract_end}`, selectedTalent.probation_end && `试用期 ${selectedTalent.probation_end}`].filter(Boolean).join("，")}，保存将覆盖
                      </Tag>
                    ) : (
                      <Tag color="green" style={{ marginInlineEnd: 0 }}>暂无合同日期</Tag>
                    )}
                  </Space>
                }
              />
            ) : null}
          </Form.Item>
        )}

        <Form.Item wrapperCol={{ span: 20, offset: 2 }} style={{ marginBottom: 8 }}>
          <Upload.Dragger
            accept=".pdf,.docx"
            showUploadList={false}
            disabled={!talentId || reading || uploading}
            beforeUpload={(f) => { handleUpload(f as unknown as File); return false; }}
          >
            <p className="ant-upload-drag-icon"><InboxOutlined /></p>
            <p className="ant-upload-text">
              {reading ? "正在读取文件内容…" : uploading ? "上传中，AI 识别日期…" : "上传合同文件（可选）"}
            </p>
            <p className="ant-upload-hint">
              {talentId ? "支持 PDF / Word（.docx），上传后 AI 自动识别日期，文件同时存档" : "请先选择人才"}
            </p>
          </Upload.Dragger>
        </Form.Item>

        {/* 上传结果：文件卡片 + AI 识别结果 Tag */}
        {fileName && !reading && !uploading && (
          <Form.Item wrapperCol={{ span: 20, offset: 2 }} style={{ marginBottom: 8 }}>
            <Alert
              type="success"
              showIcon
              icon={<FileTextOutlined />}
              message={`${fileName} 已存档`}
              description={
                <Space size={6} wrap>
                  <Tag style={{ marginInlineEnd: 0 }}>合同 {extracted?.contract_end || "未识别"}</Tag>
                  <Tag style={{ marginInlineEnd: 0 }}>试用期 {extracted?.probation_end || "未识别"}</Tag>
                </Space>
              }
            />
          </Form.Item>
        )}
        {(reading || uploading || (warning && !fileName)) && (
          <Form.Item wrapperCol={{ span: 20, offset: 2 }} style={{ marginBottom: 8 }}>
            <Alert
              type={warning && !reading && !uploading ? "warning" : "info"}
              showIcon
              message={
                reading ? "正在读取文件内容…"
                : uploading ? "正在上传并识别日期…"
                : warning || ""
              }
            />
          </Form.Item>
        )}

        <Form.Item
          name="contract_end"
          label="合同到期日"
          extra={aiFilled ? "AI 识别结果，可修改" : "保存后自动生成/更新合同到期提醒待办"}
        >
          <DatePicker style={{ width: "100%" }} placeholder="合同到期日" allowClear presets={CONTRACT_PRESETS} />
        </Form.Item>
        <Form.Item name="probation_end" label="试用期到期日">
          <DatePicker style={{ width: "100%" }} placeholder="试用期到期日" allowClear presets={PROBATION_PRESETS} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export default function Contracts() {
  const [items, setItems] = useState<ContractItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [appliedQ, setAppliedQ] = useState("");
  const [rangeFilter, setRangeFilter] = useState("all");
  const [editing, setEditing] = useState<ContractItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [fileTalent, setFileTalent] = useState<ContractItem | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [form] = Form.useForm();

  const fetchList = useCallback(async (keyword: string) => {
    setLoading(true);
    try {
      setItems(await api.getContracts(keyword || undefined));
    } catch (e: any) {
      message.error(e?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  // 页面打开：先自动同步一次到期提醒待办（幂等），再拉清单
  useEffect(() => {
    (async () => {
      try {
        const r = await api.syncContractTasks();
        if (r.created + r.updated > 0) {
          message.info(`已同步合同到期提醒：新建 ${r.created} 条、更新 ${r.updated} 条，请在「跟进待办」查看`);
        }
      } catch { /* 同步失败不阻塞页面 */ }
      fetchList("");
    })();
  }, [fetchList]);

  // 前端过滤：30 天内 / 已过期（按合同与试用期中更早的日期判断）
  const filtered = items.filter((r) => {
    if (rangeFilter === "all") return true;
    const days = [daysUntil(r.contract_end), daysUntil(r.probation_end)].filter((d): d is number => d != null);
    if (!days.length) return rangeFilter === "all";
    const earliest = Math.min(...days);
    return rangeFilter === "due30" ? earliest >= 0 && earliest <= 30 : earliest < 0;
  });

  const expiredCount = items.filter((r) => {
    const days = [daysUntil(r.contract_end), daysUntil(r.probation_end)].filter((d): d is number => d != null);
    return days.length && Math.min(...days) < 0;
  }).length;
  const due30Count = items.filter((r) => {
    const days = [daysUntil(r.contract_end), daysUntil(r.probation_end)].filter((d): d is number => d != null);
    const earliest = days.length ? Math.min(...days) : Infinity;
    return earliest >= 0 && earliest <= 30;
  }).length;
  const probationDueCount = items.filter((r) => {
    const d = daysUntil(r.probation_end);
    return d != null && d >= 0 && d <= 30;
  }).length;

  const openEdit = (r: ContractItem) => {
    setEditing(r);
    form.setFieldsValue({
      contract_end: r.contract_end ? dayjs(r.contract_end) : null,
      probation_end: r.probation_end ? dayjs(r.probation_end) : null,
    });
  };

  const handleSave = async () => {
    if (!editing) return;
    const values = await form.validateFields();
    setSaving(true);
    try {
      // 显式传 null 表示清空日期，后端会同步取消对应提醒待办
      await api.updateTalent(editing.id, {
        contract_end: values.contract_end ? values.contract_end.format("YYYY-MM-DD") : null,
        probation_end: values.probation_end ? values.probation_end.format("YYYY-MM-DD") : null,
      });
      message.success("合同日期已保存，到期提醒待办已同步");
      setEditing(null);
      fetchList(appliedQ);
    } catch (e: any) {
      message.error(e?.message || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const manualSync = async () => {
    try {
      const r = await api.syncContractTasks();
      if (r.created + r.updated > 0) {
        message.success(`已同步：新建 ${r.created} 条、更新 ${r.updated} 条、取消 ${r.cancelled} 条`);
      } else {
        message.info("所有到期提醒均为最新，无需更新");
      }
      fetchList(appliedQ);
    } catch (e: any) {
      message.error(e?.message || "同步失败");
    }
  };

  const columns = [
    {
      title: "姓名", dataIndex: "name", key: "name", width: 120,
      render: (v: string, r: ContractItem) => <Link to={`/talents/${r.id}`}>{v}</Link>,
    },
    { title: "手机号", dataIndex: "phone", key: "phone", width: 140, render: (v: string | null) => v || "—" },
    {
      title: "人才状态", dataIndex: "status", key: "status", width: 100,
      render: (v: string) => STATUS_LABELS[v as keyof typeof STATUS_LABELS] || v,
    },
    {
      title: "合同到期日", dataIndex: "contract_end", key: "contract_end", width: 200,
      render: (v: string | null) => <DateWithTag date={v} />,
    },
    {
      title: "试用期到期日", dataIndex: "probation_end", key: "probation_end", width: 200,
      render: (v: string | null) => <DateWithTag date={v} />,
    },
    {
      title: "操作", key: "action", width: 160,
      render: (_: unknown, r: ContractItem) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => openEdit(r)}>编辑日期</Button>
          <Button type="link" size="small" onClick={() => setFileTalent(r)}>合同文件</Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {/* 统计区：合同/试用期到期概况 */}
      <div className="page-stats" style={{ marginBottom: 16 }}>
        <div className="stat">
          <span className="stat-icon is-bad"><ExclamationCircleOutlined /></span>
          <span className="stat-body">
            <span className="stat-num is-bad"><AnimatedNumber value={expiredCount} format={(n) => Math.round(n).toLocaleString("zh-CN")} /></span>
            <span className="stat-label">已过期（合同或试用期）</span>
          </span>
        </div>
        <div className="stat">
          <span className="stat-icon is-warn"><FileProtectOutlined /></span>
          <span className="stat-body">
            <span className="stat-num is-warn"><AnimatedNumber value={due30Count} format={(n) => Math.round(n).toLocaleString("zh-CN")} /></span>
            <span className="stat-label">合同 30 天内到期</span>
          </span>
        </div>
        <div className="stat">
          <span className="stat-icon is-neutral"><HourglassOutlined /></span>
          <span className="stat-body">
            <span className="stat-num is-neutral"><AnimatedNumber value={probationDueCount} format={(n) => Math.round(n).toLocaleString("zh-CN")} /></span>
            <span className="stat-label">试用期 30 天内到期</span>
          </span>
        </div>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="合同 / 试用期到期前 30 天（含已过期未处理）会自动在「跟进待办」生成高优先级提醒；编辑日期后提醒自动更新，清空日期则自动取消提醒。"
      />

      {/* 搜索：姓名关键词 + 到期状态筛选 */}
      <Card className="search-card" style={{ marginBottom: 16 }} styles={{ body: { padding: 16 } }}>
        <div className="search-grid">
          <div className="search-field">
            <span className="search-label">姓名</span>
            <div className="search-control">
              <Input
                placeholder="按姓名搜索" value={q} allowClear
                onChange={(e) => setQ(e.target.value)}
                onPressEnter={() => { setAppliedQ(q); fetchList(q); }}
              />
            </div>
          </div>
          <div className="search-field">
            <span className="search-label">到期状态</span>
            <div className="search-control">
              <Select
                value={rangeFilter} onChange={setRangeFilter}
                options={[
                  { label: "全部", value: "all" },
                  { label: "30 天内到期", value: "due30" },
                  { label: "已过期", value: "expired" },
                ]}
              />
            </div>
          </div>
          <div className="search-field">
            <span className="search-label" />
            <div className="search-control" />
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
            <Button icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>新增合同</Button>
            <Button icon={<BellOutlined />} onClick={manualSync}>同步提醒</Button>
            <Button icon={<ReloadOutlined />} onClick={() => { setQ(""); setAppliedQ(""); setRangeFilter("all"); fetchList(""); }}>重置</Button>
            <Button type="primary" icon={<SearchOutlined />} onClick={() => { setAppliedQ(q); fetchList(q); }}>查询</Button>
          </div>
        </div>
      </Card>

      <Card styles={{ body: { padding: 0 } }}>
        <Table
          className="profiles-table"
          columns={columns}
          dataSource={filtered}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
        />
      </Card>

      {/* 新增合同：选人才 → 传文件 AI 识别或手填日期 → 保存到档案 */}
      <AddContractModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={() => fetchList(appliedQ)}
      />

      {/* 合同文件弹窗：上传原件 + AI 识别日期 + 应用到档案 */}
      <ContractFilesModal
        talent={fileTalent}
        onClose={() => setFileTalent(null)}
        onApplied={() => fetchList(appliedQ)}
      />

      {/* 编辑合同日期弹窗：保存即同步待办 */}
      <Modal
        title={`编辑合同日期 — ${editing?.name || ""}`}
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={handleSave}
        confirmLoading={saving}
        okText="保存"
        cancelText="取消"
        width={520}
        destroyOnClose
      >
        <Form form={form} layout="horizontal" labelCol={{ span: 6 }} wrapperCol={{ span: 16 }} style={{ marginTop: 16 }}>
          <Form.Item name="contract_end" label="合同到期日" extra="清空日期并保存，将自动取消合同到期提醒">
            <DatePicker style={{ width: "100%" }} placeholder="选择合同到期日（可清空）" presets={CONTRACT_PRESETS} />
          </Form.Item>
          <Form.Item name="probation_end" label="试用期到期日" extra="到期前 30 天自动生成转正评估提醒">
            <DatePicker style={{ width: "100%" }} placeholder="选择试用期到期日（可清空）" presets={PROBATION_PRESETS} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
