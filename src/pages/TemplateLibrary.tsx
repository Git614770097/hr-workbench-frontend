import { useState, useEffect, useCallback } from "react";
import {
  Card, Input, Select, Button, Tag, Typography, Modal, Form,
  message, Popconfirm, Upload, Tooltip, Table, Tabs, Dropdown,
} from "antd";
import type { MenuProps } from "antd";
import {
  PlusOutlined, SearchOutlined, FileTextOutlined, EditOutlined,
  DeleteOutlined, DownloadOutlined, EyeOutlined, ThunderboltOutlined,
  ImportOutlined, ReloadOutlined, CopyOutlined,
  FileWordOutlined, FilePdfOutlined,
} from "@ant-design/icons";
import mammoth from "mammoth";
import { api } from "../api";
import type { DocTemplate, User } from "../types";
import { TEMPLATE_CATEGORIES, SCOPE_LABELS, SCOPE_COLORS } from "../types";
import { extractPlaceholders, exportTemplateAsDoc, exportTemplateAsPdf, toHtml, stripHtml, smartTidyHtml } from "../utils/template";
import { parseDocFile } from "../utils/docImport";
import GenerateDocModal from "../components/GenerateDocModal";
import RichTextEditor from "../components/RichTextEditor";

export default function TemplateLibrary() {
  const [templates, setTemplates] = useState<DocTemplate[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState("");
  const [keyword, setKeyword] = useState("");
  const [appliedKeyword, setAppliedKeyword] = useState("");

  // 弹窗状态
  const [editTarget, setEditTarget] = useState<DocTemplate | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [viewTarget, setViewTarget] = useState<DocTemplate | null>(null);
  const [generateTarget, setGenerateTarget] = useState<DocTemplate | null>(null);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const currentUser: User | null = (() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  })();
  const isAdmin = currentUser?.role === "admin";
  // 官方模板仅管理员可改/删；共享和个人模板创建者本人或管理员可改/删
  const canModify = (t: DocTemplate) =>
    isAdmin || (t.owner_id === currentUser?.id && t.scope !== "official");

  const fetchTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getTemplates({ category: category || undefined, q: appliedKeyword || undefined, page, limit: pageSize });
      setTemplates(res.items);
      setTotal(res.total || 0);
    } catch (err) {
      message.error((err as Error).message);
    }
    setLoading(false);
  }, [category, appliedKeyword, page, pageSize]);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  const openCreate = () => {
    setEditTarget(null);
    form.resetFields();
    form.setFieldsValue({ scope: "shared" });
    setEditOpen(true);
  };

  const openEdit = (t: DocTemplate) => {
    setEditTarget(t);
    // 旧的纯文本模板统一转成 HTML 再进富文本编辑器
    form.setFieldsValue({ name: t.name, category: t.category, content: toHtml(t.content), scope: t.scope || "shared" });
    setEditOpen(true);
  };

  // 复制为己用：把官方/他人的共享模板复制为我的个人模板
  const handleDuplicate = async (t: DocTemplate) => {
    try {
      const res = await api.duplicateTemplate(t.id) as any;
      message.success(`已复制为个人模板「${res.name}」，可自由修改`);
      fetchTemplates();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      if (editTarget) {
        await api.updateTemplate(editTarget.id, values);
        message.success("模板已更新");
      } else {
        await api.createTemplate(values);
        message.success("模板已创建");
      }
      setEditOpen(false);
      fetchTemplates();
    } catch (err) {
      message.error((err as Error).message);
    }
    setSaving(false);
  };

  const handleDelete = async (t: DocTemplate) => {
    try {
      await api.deleteTemplate(t.id);
      message.success(`已删除「${t.name}」`);
      fetchTemplates();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  // 导出菜单（Word / PDF）
  const exportMenuItems: MenuProps["items"] = [
    { key: "word", label: "导出 Word", icon: <FileWordOutlined /> },
    { key: "pdf", label: "导出 PDF", icon: <FilePdfOutlined /> },
  ];
  const onExportMenuClick = (t: DocTemplate): MenuProps["onClick"] => ({ key }) => {
    if (key === "word") exportTemplateAsDoc(t);
    else if (key === "pdf") exportTemplateAsPdf(t);
  };

  // 导入：.docx 保留排版转 HTML；.doc 按形态解析（HTML 型保留排版，RTF/二进制型提取文字）；.txt 按段落转换
  const handleImportFile = async (file: File) => {
    const name = file.name.toLowerCase();
    try {
      let html = "";
      let hint: string | null = null;
      if (name.endsWith(".docx")) {
        const result = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
        html = result.value;
      } else if (name.endsWith(".doc")) {
        const result = await parseDocFile(file);
        html = result.html;
        if (result.mode === "text") hint = "旧版二进制 .doc 已按纯文本提取，可用「一键整理格式」自动排版";
      } else if (name.endsWith(".txt")) {
        html = toHtml(await file.text());
      } else {
        message.error("仅支持 .doc / .docx / .txt 文件");
        return false;
      }
      if (!stripHtml(html).trim()) {
        message.error("未能从文件中提取到文字内容");
        return false;
      }
      setEditTarget(null);
      form.setFieldsValue({
        name: file.name.replace(/\.(docx?|txt)$/i, ""),
        category: "证明文档",
        content: html,
        scope: "shared",
      });
      setEditOpen(true);
      if (hint) message.info(hint, 5);
      else message.success("已提取文件内容，可在编辑器中调整后保存");
    } catch {
      message.error("文件解析失败");
    }
    return false;
  };

  // 一键整理格式：按中文文档惯例自动排版，先预览，用户选择采用或放弃
  const [tidyPreview, setTidyPreview] = useState<string | null>(null);
  const handleSmartTidy = () => {
    const v = form.getFieldValue("content") || "";
    if (!stripHtml(v).trim()) {
      message.warning("请先在编辑器中输入内容");
      return;
    }
    setTidyPreview(smartTidyHtml(v));
  };
  const adoptTidy = () => {
    if (tidyPreview) {
      form.setFieldsValue({ content: tidyPreview });
      message.success("已采用整理后的排版，可继续微调");
    }
    setTidyPreview(null);
  };

  const columns = [
    {
      title: "模板名称",
      dataIndex: "name",
      key: "name",
      ellipsis: true,
      render: (v: string) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <FileTextOutlined style={{ color: "#3b82f6" }} />
          <Typography.Text strong style={{ maxWidth: 260 }} ellipsis={{ tooltip: v }}>{v}</Typography.Text>
        </span>
      ),
    },
    {
      title: "分类",
      dataIndex: "category",
      key: "category",
      width: 110,
      render: (v: string) => <Tag color="blue">{v}</Tag>,
    },
    {
      title: "级别",
      dataIndex: "scope",
      key: "scope",
      width: 80,
      render: (v: string) => <Tag color={SCOPE_COLORS[v] || "default"}>{SCOPE_LABELS[v] || "共享"}</Tag>,
    },
    {
      title: "占位符",
      dataIndex: "content",
      key: "placeholders",
      width: 240,
      render: (content: string) => {
        const keys = extractPlaceholders(content);
        if (keys.length === 0) return <Typography.Text type="secondary" style={{ fontSize: 12 }}>无</Typography.Text>;
        return (
          <span>
            {keys.slice(0, 3).map((k) => (
              <Tag key={k} style={{ fontSize: 11, marginInlineEnd: 4 }}>{`{{${k}}}`}</Tag>
            ))}
            {keys.length > 3 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>+{keys.length - 3}</Typography.Text>}
          </span>
        );
      },
    },
    {
      title: "来源",
      dataIndex: "owner_name",
      key: "owner",
      width: 100,
      render: (v: string | undefined, t: DocTemplate) =>
        v || (t.owner_id === "system" ? "内置" : "—"),
    },
    {
      title: "更新时间",
      dataIndex: "updated_at",
      key: "updated_at",
      width: 110,
      render: (v: string) => new Date(v).toLocaleDateString("zh-CN"),
    },
    {
      title: "操作",
      key: "actions",
      width: 250,
      render: (_: any, t: DocTemplate) => (
        <span style={{ display: "inline-flex", gap: 4 }}>
          <Button type="primary" size="small" icon={<ThunderboltOutlined />} onClick={() => setGenerateTarget(t)}>套用生成</Button>
          <Tooltip title="查看"><Button size="small" icon={<EyeOutlined />} onClick={() => setViewTarget(t)} /></Tooltip>
          <Tooltip title="导出模板">
            <Dropdown menu={{ items: exportMenuItems, onClick: onExportMenuClick(t) }} trigger={["click"]}>
              <Button size="small" icon={<DownloadOutlined />} />
            </Dropdown>
          </Tooltip>
          {canModify(t) ? (
            <>
              <Tooltip title="编辑"><Button size="small" icon={<EditOutlined />} onClick={() => openEdit(t)} /></Tooltip>
              <Popconfirm title="确认删除该模板？" onConfirm={() => handleDelete(t)}>
                <Tooltip title="删除"><Button size="small" danger icon={<DeleteOutlined />} /></Tooltip>
              </Popconfirm>
            </>
          ) : (
            <Tooltip title="复制为我的个人模板后可自由修改">
              <Button size="small" icon={<CopyOutlined />} onClick={() => handleDuplicate(t)} />
            </Tooltip>
          )}
        </span>
      ),
    },
  ];

  return (
    <div>
      {/* 搜索区：关键词 + 操作按钮 */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <Input
            style={{ width: 260 }}
            placeholder="请输入模板名称或内容关键词"
            allowClear
            prefix={<SearchOutlined style={{ color: "#bbb" }} />}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onPressEnter={() => { setPage(1); setAppliedKeyword(keyword); }}
          />
          <Button type="primary" icon={<SearchOutlined />} onClick={() => { setPage(1); setAppliedKeyword(keyword); }}>搜索</Button>
          <Button icon={<ReloadOutlined />} onClick={() => { setKeyword(""); setAppliedKeyword(""); setCategory(""); setPage(1); }}>重置</Button>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <Upload accept=".doc,.docx,.txt" showUploadList={false} beforeUpload={handleImportFile}>
              <Button icon={<ImportOutlined />}>导入模板</Button>
            </Upload>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新建模板</Button>
          </div>
        </div>
      </Card>

      {/* 模板列表 */}
      <Card>
        {/* 分类 Tab */}
        <Tabs
          activeKey={category || "all"}
          onChange={(key) => { setCategory(key === "all" ? "" : key); setPage(1); }}
          items={[
            { key: "all", label: "全部" },
            ...TEMPLATE_CATEGORIES.map((c) => ({ key: c, label: c })),
          ]}
          style={{ marginBottom: 8 }}
        />
        <Table
          rowKey="id"
          columns={columns}
          dataSource={templates}
          loading={loading}
          size="middle"
          pagination={{
            current: page,
            pageSize,
            total,
            onChange: (p) => setPage(p),
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50, 100],
            onShowSizeChange: (_current, size) => { setPageSize(size); setPage(1); },
            showTotal: (t) => `共 ${t} 个模板`,
          }}
          locale={{ emptyText: "暂无模板，点击右上角新建或导入" }}
        />
      </Card>

      {/* 新建 / 编辑模板弹窗（富文本） */}
      <Modal
        title={editTarget ? "编辑模板" : "新建模板"}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        width={900}
        destroyOnClose
        footer={null}
      >
        <Form form={form} layout="horizontal" className="form-horizontal" labelCol={{ flex: "88px" }} onFinish={handleSave} initialValues={{ category: "证明文档", scope: "shared" }}>
          <div className="form-grid">
            <Form.Item name="name" label="模板名称" rules={[{ required: true, message: "请输入模板名称" }]}>
              <Input placeholder="请输入模板名称，如：劳动合同（技术岗）" />
            </Form.Item>
            <Form.Item name="category" label="分类" rules={[{ required: true, message: "请选择分类" }]}>
              <Select placeholder="请选择分类" options={TEMPLATE_CATEGORIES.map((c) => ({ label: c, value: c }))} />
            </Form.Item>
            <Form.Item
              name="scope"
              label="级别"
              rules={[{ required: true, message: "请选择级别" }]}
              tooltip={isAdmin ? "官方模板全员只读，仅管理员可维护" : "个人模板仅自己可见"}
            >
              <Select
                placeholder="请选择级别"
                options={(isAdmin ? ["official", "shared", "private"] : ["shared", "private"]).map((s) => ({
                  label: SCOPE_LABELS[s],
                  value: s,
                }))}
              />
            </Form.Item>
          </div>
          <Form.Item
            name="content"
            label={
              <span style={{ display: "flex", alignItems: "center", width: "100%" }}>
                模板内容
                <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8, fontWeight: "normal" }}>
                  用 {"{{占位符}}"} 标记可变内容，如 {"{{姓名}}"}、{"{{公司}}"}、{"{{日期}}"}
                </Typography.Text>
                <Button type="link" size="small" style={{ marginLeft: "auto", padding: 0 }} onClick={handleSmartTidy}>
                  一键整理格式
                </Button>
              </span>
            }
            rules={[{
              validator: (_: any, v: string) =>
                v && stripHtml(v).trim()
                  ? Promise.resolve()
                  : Promise.reject(new Error("请输入模板内容")),
            }]}
          >
            <RichTextEditor placeholder="在此输入模板正文…支持 {{姓名}} {{手机号}} {{公司}} {{职位}} {{日期}} 等占位符" />
          </Form.Item>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button onClick={() => setEditOpen(false)}>取消</Button>
            <Button type="primary" htmlType="submit" loading={saving}>{editTarget ? "保存修改" : "创建模板"}</Button>
          </div>
        </Form>
      </Modal>

      {/* 查看模板弹窗（保留富文本排版） */}
      <Modal
        title={viewTarget ? `查看模板 - ${viewTarget.name}` : "查看模板"}
        open={!!viewTarget}
        onCancel={() => setViewTarget(null)}
        width={820}
        footer={
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Dropdown menu={{ items: exportMenuItems, onClick: onExportMenuClick(viewTarget!) }} trigger={["click"]}>
              <Button icon={<DownloadOutlined />}>导出模板</Button>
            </Dropdown>
            <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => { setGenerateTarget(viewTarget); setViewTarget(null); }}>套用生成</Button>
          </div>
        }
      >
        {viewTarget && (
          <div>
            <div style={{ marginBottom: 12 }}>
              <Tag color="blue">{viewTarget.category}</Tag>
              <Tag color={SCOPE_COLORS[viewTarget.scope] || "default"}>{SCOPE_LABELS[viewTarget.scope] || "共享"}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                更新于 {new Date(viewTarget.updated_at).toLocaleString("zh-CN")}
              </Typography.Text>
            </div>
            <div
              className="doc-preview"
              style={{ maxHeight: "62vh", overflowY: "auto" }}
              dangerouslySetInnerHTML={{ __html: toHtml(viewTarget.content) }}
            />
          </div>
        )}
      </Modal>

      {/* 一键整理格式：排版预览（采用 / 放弃） */}
      <Modal
        title="一键整理格式 - 排版预览"
        open={!!tidyPreview}
        onCancel={() => setTidyPreview(null)}
        width={840}
        destroyOnClose
        footer={
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button onClick={() => setTidyPreview(null)}>放弃整理</Button>
            <Button type="primary" onClick={adoptTidy}>采用整理结果</Button>
          </div>
        }
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          已按中文文档惯例自动排版：标题居中加粗、条款标题加粗、正文宋体四号并首行缩进、落款右对齐。
          采用后将替换编辑器中的当前内容（替换后仍可手动微调）。
        </Typography.Paragraph>
        {tidyPreview && (
          <div
            className="doc-preview"
            style={{ maxHeight: "60vh", overflowY: "auto" }}
            dangerouslySetInnerHTML={{ __html: tidyPreview }}
          />
        )}
      </Modal>

      {/* 套用生成弹窗 */}
      <GenerateDocModal template={generateTarget} onClose={() => setGenerateTarget(null)} />
    </div>
  );
}
