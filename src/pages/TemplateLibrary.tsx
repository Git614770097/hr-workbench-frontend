import { useState, useEffect, useCallback } from "react";
import {
  Card, Input, Select, Button, Tag, Typography, Modal, Form,
  message, Popconfirm, Tooltip, Table, Tabs, Alert, Progress,
} from "antd";
import {
  PlusOutlined, SearchOutlined, FileTextOutlined, ReloadOutlined, ThunderboltOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import type { DocTemplate, User } from "../types";
import { TEMPLATE_CATEGORIES, SCOPE_LABELS, SCOPE_COLORS } from "../types";
import { toHtml, stripHtml, smartTidyHtml, detailRowsToTable } from "../utils/template";
import { downloadBlob, dateStamp, escapeHtml } from "../utils/file";
import { fmtDate, fmtDateTime } from "../utils/time";
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

  // 导出单个模板为 Word 文档（.doc，占位符 {{xxx}} 原文保留，供用户在 Word 里填写）
  const handleExport = (t: DocTemplate) => {
    // 明细行（序号 | 姓名 | …）转成真表格，台账类模板导出后可直接填写使用
    const body = detailRowsToTable(toHtml(t.content));
    const safeName = t.name.replace(/[\\/:*?"<>|]/g, "_");
    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(t.name)}</title>
<style>
  body { font-family: "SimSun", "宋体", serif; margin: 48px 56px; color: #222; font-size: 14px; line-height: 1.9; }
  h1 { text-align: center; font-size: 22px; margin: 0 0 8px; }
  .meta { text-align: center; color: #999; font-size: 12px; margin-bottom: 28px; }
  p { margin: 0.4em 0; }
</style></head><body>
<h1>${escapeHtml(t.name)}</h1>
<div class="meta">${escapeHtml(t.category)} · 导出时间 ${new Date().toLocaleString("zh-CN")}</div>
${body}
</body></html>`;
    downloadBlob(new Blob(["\ufeff" + html], { type: "application/msword;charset=utf-8" }), `${safeName}_${dateStamp()}.doc`);
    message.success(`已导出模板「${t.name}」（Word）`);
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

  // ---- 全库一键整理（仅管理员）：遍历所有模板，逐个按公文规范自动排版并保存 ----
  const [tidyAll, setTidyAll] = useState<{
    open: boolean; done: number; total: number; failed: string[]; skipped: number; finished: boolean;
  }>({ open: false, done: 0, total: 0, failed: [], skipped: 0, finished: false });

  const handleTidyAll = async () => {
    setTidyAll({ open: true, done: 0, total: 0, failed: [], skipped: 0, finished: false });
    try {
      // 分页拉全量模板（管理员可见 = 全库，含内容字段）
      const all: DocTemplate[] = [];
      let p = 1, pages = 1;
      do {
        const res = await api.getTemplates({ page: p, limit: 100 });
        all.push(...res.items);
        pages = res.pages || 1;
        p += 1;
      } while (p <= pages);

      const failed: string[] = [];
      let skipped = 0;
      setTidyAll(s => ({ ...s, total: all.length }));

      for (const t of all) {
        try {
          const html = toHtml(t.content || "");
          if (!canModify(t) || !stripHtml(html).trim()) {
            skipped += 1;
          } else {
            // smartTidyHtml 幂等：先重置块级字体/对齐再按规则重排，重复执行不会叠加损害
            const tidied = smartTidyHtml(html);
            await api.updateTemplate(t.id, { name: t.name, category: t.category, content: tidied, scope: t.scope || "shared" });
          }
        } catch {
          failed.push(t.name);
        }
        setTidyAll(s => ({ ...s, done: s.done + 1, skipped, failed: [...failed] }));
      }
      setTidyAll(s => ({ ...s, finished: true }));
      fetchTemplates();
    } catch (err) {
      message.error((err as Error).message);
      setTidyAll(s => ({ ...s, finished: true }));
    }
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
      render: (v: string) => fmtDate(v),
    },
    {
      title: "操作",
      key: "actions",
      width: 228,
      render: (_: any, t: DocTemplate) => (
        <span style={{ display: "inline-flex", gap: 4 }}>
          <Button type="link" size="small" onClick={() => setViewTarget(t)}>查看</Button>
          <Button type="link" size="small" onClick={() => handleExport(t)}>导出</Button>
          {canModify(t) ? (
            <>
              <Button type="link" size="small" onClick={() => openEdit(t)}>编辑</Button>
              <Popconfirm title="确认删除该模板？" onConfirm={() => handleDelete(t)}>
                <Button type="link" size="small" danger>删除</Button>
              </Popconfirm>
            </>
          ) : (
            <Tooltip title="复制为我的个人模板后可自由修改">
              <Button type="link" size="small" onClick={() => handleDuplicate(t)}>复制</Button>
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
            prefix={<SearchOutlined />}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onPressEnter={() => { setPage(1); setAppliedKeyword(keyword); }}
          />
          <Button type="primary" icon={<SearchOutlined />} onClick={() => { setPage(1); setAppliedKeyword(keyword); }}>搜索</Button>
          <Button icon={<ReloadOutlined />} onClick={() => { setKeyword(""); setAppliedKeyword(""); setCategory(""); setPage(1); }}>重置</Button>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {isAdmin && (
              <Popconfirm
                title="一键整理全部模板"
                description="将遍历所有模板，按中文公文规范自动排版（标题居中加粗、条款加粗、正文首行缩进、落款右对齐），原有字体字号设置会被重置。确认执行？"
                okText="开始整理"
                cancelText="取消"
                onConfirm={handleTidyAll}
              >
                <Button icon={<ThunderboltOutlined />} disabled={tidyAll.open && !tidyAll.finished}>一键整理全部</Button>
              </Popconfirm>
            )}
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
          locale={{ emptyText: "暂无模板，点击右上角新建" }}
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
            label="模板内容"
            extra={
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8, marginTop: -4 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  支持字体 / 字号 / 颜色等排版
                </Typography.Text>
                <Button type="link" size="small" style={{ padding: 0, flexShrink: 0 }} onClick={handleSmartTidy}>
                  一键整理格式
                </Button>
              </div>
            }
            rules={[{
              validator: (_: any, v: string) =>
                v && stripHtml(v).trim()
                  ? Promise.resolve()
                  : Promise.reject(new Error("请输入模板内容")),
            }]}
          >
            <RichTextEditor placeholder="在此输入模板正文…" />
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
        footer={null}
      >
        {viewTarget && (
          <div>
            <div style={{ marginBottom: 12 }}>
              <Tag color="blue">{viewTarget.category}</Tag>
              <Tag color={SCOPE_COLORS[viewTarget.scope] || "default"}>{SCOPE_LABELS[viewTarget.scope] || "共享"}</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                更新于 {fmtDateTime(viewTarget.updated_at)}
              </Typography.Text>
            </div>
            <div
              className="doc-preview"
              style={{ maxHeight: "62vh", overflowY: "auto" }}
              dangerouslySetInnerHTML={{ __html: detailRowsToTable(toHtml(viewTarget.content)) }}
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

      {/* 全库一键整理：进度与结果弹窗（长耗时操作，常驻状态展示） */}
      <Modal
        title="一键整理全部模板"
        open={tidyAll.open}
        width={480}
        maskClosable={false}
        closable={tidyAll.finished}
        onCancel={() => tidyAll.finished && setTidyAll(s => ({ ...s, open: false }))}
        footer={
          tidyAll.finished ? (
            <Button type="primary" onClick={() => setTidyAll(s => ({ ...s, open: false }))}>完成</Button>
          ) : null
        }
      >
        {tidyAll.finished ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Alert
              type={tidyAll.failed.length ? "warning" : "success"}
              showIcon
              message={`整理完成：共 ${tidyAll.total} 个模板`}
              description={`成功 ${tidyAll.total - tidyAll.skipped - tidyAll.failed.length} 个，跳过（空内容或无权限）${tidyAll.skipped} 个${tidyAll.failed.length ? `，失败 ${tidyAll.failed.length} 个：${tidyAll.failed.join("、")}` : ""}`}
            />
          </div>
        ) : (
          <div>
            <Progress
              percent={tidyAll.total ? Math.round((tidyAll.done / tidyAll.total) * 100) : 0}
              status="active"
            />
            <Typography.Text type="secondary">
              正在整理 {tidyAll.done}/{tidyAll.total || "…"}，请勿关闭页面
            </Typography.Text>
          </div>
        )}
      </Modal>
    </div>
  );
}
