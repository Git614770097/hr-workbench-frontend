import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Card, Table, Button, Space, Tag, Modal, Form, Input, message, Progress,
  Popconfirm, Empty, Typography, Checkbox, Select, Divider,
} from "antd";
import {
  PlusOutlined, ReloadOutlined, ThunderboltOutlined, CheckCircleOutlined, UserOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import type { OnboardingItem } from "../types";
import { ONBOARDING_STATUS_LABELS } from "../types";
import AnimatedNumber from "../components/AnimatedNumber";

/** 入职办理：材料清单模板可自定，逐项勾选跟进 */
export default function Onboarding() {
  const [items, setItems] = useState<OnboardingItem[]>([]);
  const [progress, setProgress] = useState({ total: 0, done: 0, percent: 0 });
  const [loading, setLoading] = useState(false);
  const [talentId, setTalentId] = useState<string | undefined>();
  const [talentOptions, setTalentOptions] = useState<{ label: string; value: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 候选人搜索（与「新增合同」同一套可搜索下拉，避免让用户手填 ID）
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

  useEffect(() => { searchTalents(""); }, [searchTalents]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // 不选候选人 = 看「全部在办人」总览（流转到已入职会自动生成清单，这里就能一眼看到）
      const r = await api.getOnboardingItems(talentId ? { talent_id: talentId } : {});
      setItems(r.items);
      setProgress(r.progress);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [talentId]);

  useEffect(() => { load(); }, [load]);

  const handleInit = async () => {
    if (!talentId) return;
    try {
      const r = await api.initOnboarding(talentId);
      message.success(`已生成 ${r.created} 项默认材料清单，可自行增删改`);
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const handleToggle = async (row: OnboardingItem, next: "pending" | "submitted" | "verified") => {
    try {
      await api.updateOnboardingItem(row.id, { status: next });
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const handleSave = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await api.createOnboardingItem({ ...v, talent_id: talentId, required: !!v.required });
      message.success("已添加");
      setOpen(false);
      form.resetFields();
      load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const statusColor = (s: string) => (s === "verified" ? "green" : s === "submitted" ? "blue" : "default");

  // 分组：选了候选人按「材料分组」看细节；没选则按「候选人」看全部在办人
  const grouped = useMemo(() => {
    const acc: Record<string, OnboardingItem[]> = {};
    for (const it of items) {
      const k = talentId ? (it.category || "其他材料") : (it.talent_name || "未命名候选人");
      (acc[k] = acc[k] || []).push(it);
    }
    return acc;
  }, [items, talentId]);

  return (
    <div className="page-fill profiles-page">
      {/* 统计区：办理进度（结构与合同/社保页一致） */}
      <div className="page-stats" style={{ marginBottom: 16 }}>
        <div className="stat stat-wide">
          <span className="stat-icon is-good"><CheckCircleOutlined /></span>
          <span className="stat-body" style={{ flex: 1 }}>
            <span className="stat-num is-neutral">
              <AnimatedNumber value={progress.percent} format={(n) => `${Math.round(n)}%`} />
            </span>
            <span className="stat-label">
              {talentId ? "该候选人" : "全部在办人"}入职材料办理进度（共 {progress.total} 项 / 已完成 {progress.done} 项）
            </span>
            <Progress
              percent={progress.percent}
              size="small"
              showInfo={false}
              style={{ marginTop: 6, marginBottom: 0, width: "100%" }}
              status={progress.total === 0 ? "normal" : progress.percent === 100 ? "success" : "active"}
            />
          </span>
        </div>
      </div>

      {/* 搜索区（约定：只放搜索字段，label 左 / 控件右） */}
      <Card className="search-card" style={{ marginBottom: 16 }}>
        <div className="search-grid">
          <div className="search-field">
            <span className="search-label">候选人</span>
            <div className="search-control">
              <Select
                showSearch
                allowClear
                value={talentId}
                placeholder="全部在办人（输入姓名或手机号筛选）"
                filterOption={false}
                loading={searching}
                options={talentOptions}
                onSearch={debouncedSearch}
                onChange={(v: string | undefined) => setTalentId(v)}
                suffixIcon={<UserOutlined />}
              />
            </div>
          </div>
        </div>
      </Card>

      <Card className="list-card">
        {/* 工具行：左侧数据操作，右侧刷新 */}
        <div className="toolbar">
          <Space>
            <Button
              type="primary" icon={<ThunderboltOutlined />}
              onClick={handleInit}
              disabled={!talentId || items.length > 0}
            >
              一键生成默认清单
            </Button>
            <Button
              icon={<PlusOutlined />}
              onClick={() => { form.resetFields(); setOpen(true); }}
              disabled={!talentId}
            >
              添加材料项
            </Button>
          </Space>
          <Space>
            <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          </Space>
        </div>

        {items.length === 0 && !loading ? (
          <Empty
            description={talentId
              ? "该候选人还没有材料清单，点左上角「一键生成默认清单」快速开始"
              : "还没有入职办理记录。把候选人在「招聘看板」推进到「已入职」，系统会自动生成材料清单"}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ margin: "60px 0" }}
          />
        ) : (
          Object.entries(grouped).map(([cat, list]) => (
            <div key={cat} style={{ marginBottom: 8 }}>
              <Divider orientation="left" plain>{cat}</Divider>
              <Table<OnboardingItem>
                className="profiles-table"
                rowKey="id"
                dataSource={list}
                size="small"
                pagination={false}
                columns={[
                  ...(!talentId
                    ? [{
                        title: "候选人",
                        key: "talent",
                        width: 130,
                        render: (_: unknown, r: OnboardingItem) => (
                          <Link to={`/talents/${r.talent_id}`}>{r.talent_name || "—"}</Link>
                        ),
                      }]
                    : []),
                  {
                    title: "材料 / 事项",
                    key: "name",
                    render: (_: unknown, r: OnboardingItem) => (
                      <Space size={8}>
                        <span>{r.name}</span>
                        {r.required ? <Tag color="red">必交</Tag> : <Tag>选交</Tag>}
                      </Space>
                    ),
                  },
                  {
                    title: "状态",
                    dataIndex: "status",
                    key: "status",
                    width: 110,
                    render: (v: string) => <Tag color={statusColor(v)}>{ONBOARDING_STATUS_LABELS[v] || v}</Tag>,
                  },
                  {
                    title: "操作",
                    key: "act",
                    width: 220,
                    render: (_: unknown, r: OnboardingItem) => (
                      <Space size={4} wrap>
                        <Button size="small" onClick={() => handleToggle(r, "submitted")} disabled={r.status !== "pending"}>
                          标记已提交
                        </Button>
                        <Button size="small" onClick={() => handleToggle(r, "verified")} disabled={r.status === "verified"}>
                          标记已核验
                        </Button>
                        <Popconfirm title="删除该项？" onConfirm={async () => {
                          try { await api.deleteOnboardingItem(r.id); load(); } catch (e) { message.error((e as Error).message); }
                        }} okText="删除" cancelText="取消">
                          <Button type="link" size="small" danger>删除</Button>
                        </Popconfirm>
                      </Space>
                    ),
                  },
                ]}
              />
            </div>
          ))
        )}
      </Card>

      <Modal
        title="添加材料项"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={handleSave}
        confirmLoading={saving}
        okText="添加"
        cancelText="取消"
        width={520}
        destroyOnClose
      >
        <Form form={form} layout="horizontal" className="form-horizontal" labelCol={{ flex: "88px" }} initialValues={{ required: true }}>
          <Form.Item name="name" label="材料名称" rules={[{ required: true, message: "请填写名称" }]}>
            <Input placeholder="如：体检报告 / 银行卡信息" />
          </Form.Item>
          <Form.Item name="category" label="分组">
            <Input placeholder="如：身份材料 / 财务材料" />
          </Form.Item>
          <Form.Item name="required" label="是否必交" valuePropName="checked">
            <Checkbox>必交（未完成会在进度里体现）</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
