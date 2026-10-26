import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Card, Table, Button, Space, Tag, Modal, Form, Input, message, Progress,
  Popconfirm, Empty, Typography, Checkbox, Select, Divider, Dropdown, Alert, Tooltip,
} from "antd";
import {
  PlusOutlined, ReloadOutlined, ThunderboltOutlined, CheckCircleOutlined, UserOutlined, RobotOutlined,
} from "@ant-design/icons";
import { api } from "../api";
import AiThinking from "../components/AiThinking";
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
  // 全部视图下隐藏「材料全部核验完」的候选人（办结归档，避免越堆越多）；默认隐藏可切回
  const [hideDone, setHideDone] = useState(true);

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

  // 人才详情「入职办理」入口带 talent_id 跳转：预选该候选人
  // （searchTalents 只带前 20 人，deep-link 的人可能不在选项里，单独取姓名补进去）
  useEffect(() => {
    const tid = new URLSearchParams(window.location.search).get("talent_id");
    if (!tid) return;
    (async () => {
      try {
        const t = await api.getTalent(tid);
        setTalentOptions((prev) =>
          prev.some((o) => o.value === tid) ? prev : [...prev, { label: t.phone ? `${t.name}（${t.phone}）` : t.name, value: tid }]
        );
        setTalentId(tid);
      } catch { /* 读取失败不预选，用户可手动在下拉里选 */ }
    })();
  }, []);

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

  // AI 入职清单：按岗位/城市上下文生成材料初稿 → 预览勾选 → 批量入库。
  // AI 只起草，入库由人确认；失败降级提示走「一键生成默认清单」。
  type AiItemOpt = { name: string; category: string; required: boolean; _on: boolean };
  const [aiCheck, setAiCheck] = useState<{ open: boolean; loading: boolean; err: string; options: AiItemOpt[] }>({
    open: false, loading: false, err: "", options: [],
  });
  const [aiSaving, setAiSaving] = useState(false);

  const genChecklist = async () => {
    if (!talentId) return;
    setAiCheck({ open: true, loading: true, err: "", options: [] });
    try {
      const r = await api.aiOnboardChecklist(talentId);
      setAiCheck({ open: true, loading: false, err: "", options: r.items.map((o) => ({ ...o, _on: true })) });
    } catch (e) {
      setAiCheck({ open: true, loading: false, err: (e as Error).message || "生成失败，请稍后重试", options: [] });
    }
  };

  // 勾选项批量入库：并发写单条接口（清单为 owner 隔离数据，复用 createOnboardingItem）
  const confirmChecklist = async () => {
    if (!talentId) return;
    const picked = aiCheck.options.filter((o) => o._on);
    if (!picked.length) {
      message.info("请至少勾选一项");
      return;
    }
    setAiSaving(true);
    try {
      const rs = await Promise.allSettled(
        picked.map((o) => api.createOnboardingItem({
          talent_id: talentId, name: o.name, category: o.category, required: o.required ? 1 : 0,
        }))
      );
      const ok = rs.filter((r) => r.status === "fulfilled").length;
      const fail = rs.length - ok;
      if (!ok) throw new Error("添加失败，请重试");
      message.success(`已添加 ${ok} 项材料${fail ? `，${fail} 项失败请重试` : ""}`);
      setAiCheck({ open: false, loading: false, err: "", options: [] });
      load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setAiSaving(false);
    }
  };

  // 状态三态互切（支持回退）：点状态标签直接改，退回待提交会清空提交时间（后端处理）
  const handleToggle = async (row: OnboardingItem, next: "pending" | "submitted" | "verified") => {
    if (row.status === next) return;
    try {
      await api.updateOnboardingItem(row.id, { status: next });
      message.success(
        next === "pending" ? "已退回「待提交」" : `已标记为「${ONBOARDING_STATUS_LABELS[next]}」`
      );
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
  interface Group { key: string; label: string; sub: string; list: OnboardingItem[] }
  const groups = useMemo((): Group[] => {
    if (talentId) {
      // 单人视图：按材料分组，顶部进度条已覆盖整体进度
      const acc: Record<string, OnboardingItem[]> = {};
      for (const it of items) {
        const k = it.category || "其他材料";
        (acc[k] = acc[k] || []).push(it);
      }
      return Object.entries(acc).map(([label, list]) => ({ key: label, label, sub: "", list }));
    }
    // 全部视图：按候选人分组，分组头带岗位与完成进度（非待提交即视为完成，与顶部口径一致）
    const acc: Record<string, OnboardingItem[]> = {};
    for (const it of items) {
      (acc[it.talent_id] = acc[it.talent_id] || []).push(it);
    }
    const list: Group[] = Object.values(acc).map((g) => {
      const done = g.filter((r) => r.status !== "pending").length;
      const first = g[0];
      return {
        key: first.talent_id,
        label: first.talent_name || "未命名候选人",
        sub: [first.job_title, `${done}/${g.length} 项`].filter(Boolean).join(" · "),
        list: g,
      };
    });
    // 隐藏已办结：材料全部核验完的候选人不再出现在「全部在办人」里
    if (hideDone) return list.filter((g) => g.list.some((r) => r.status !== "verified"));
    return list;
  }, [items, talentId, hideDone]);

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
            <Tooltip
              title={
                !talentId
                  ? "先在右上角选择一位候选人"
                  : items.length > 0
                    ? "已有清单；如需补充材料请用「AI 生成清单」或「添加材料项」"
                    : "生成标准入职材料清单（固定模板）"
              }
            >
              <Button
                type="primary" icon={<ThunderboltOutlined />}
                onClick={handleInit}
                disabled={!talentId || items.length > 0}
              >
                一键生成默认清单
              </Button>
            </Tooltip>
            {/* AI 生成：按岗位/城市出材料初稿，已有清单时也可用来补充材料 */}
            <Tooltip
              title={
                !talentId
                  ? "先在右上角选择一位候选人"
                  : aiCheck.loading
                    ? "正在生成…"
                    : "AI 按岗位与城市生成材料初稿，可先预览勾选再入库（比「默认清单」更贴合岗位）"
              }
            >
              <Button className="ai-btn" icon={<RobotOutlined />} onClick={genChecklist} disabled={!talentId || aiCheck.loading}>
                AI 生成清单
              </Button>
            </Tooltip>
            <Button
              icon={<PlusOutlined />}
              onClick={() => { form.resetFields(); setOpen(true); }}
              disabled={!talentId}
            >
              添加材料项
            </Button>
          </Space>
          <Space>
            {/* 单人视图：直接跳这位候选人的合同 / 社保（数据层本已联动，补上界面跳转） */}
            {talentId && (
              <Space size={4}>
                <Link to={`/contracts?talent_id=${talentId}`}>查看合同</Link>
                <Link to={`/social?talent_id=${talentId}`}>查看社保</Link>
              </Space>
            )}
            {!talentId && (
              <Checkbox
                checked={hideDone}
                onChange={(e) => setHideDone(e.target.checked)}
              >
                隐藏已办结
              </Checkbox>
            )}
            <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          </Space>
        </div>

        {items.length === 0 && !loading ? (
          <Empty
            description={talentId
              ? "该候选人还没有材料清单，点左上角「一键生成默认清单」快速开始"
              : "还没有入职办理记录。把候选人在「招聘看板」推进到「已入职」，系统会自动生成材料清单"}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ margin: 0 }}
          />
        ) : groups.length === 0 && !loading ? (
          <Empty
            description="没有进行中的入职办理：清单都已办结（已隐藏，可勾掉右上角「隐藏已办结」查看）"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ margin: 0 }}
          />
        ) : (
          groups.map((g) => (
            <div key={g.key} style={{ marginBottom: 8 }}>
              <Divider orientation="left" plain>
                {g.label}
                {g.sub && (
                  <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400, marginInlineStart: 8 }}>
                    {g.sub}
                  </Typography.Text>
                )}
                {/* 全部视图：每位候选人一行直达合同 / 社保（g.key 即 talent_id） */}
                {!talentId && (
                  <Space size={4} style={{ marginInlineStart: 12 }}>
                    <Link to={`/contracts?talent_id=${g.key}`}>合同</Link>
                    <Link to={`/social?talent_id=${g.key}`}>社保</Link>
                  </Space>
                )}
              </Divider>
              <Table<OnboardingItem>
                className="profiles-table"
                rowKey="id"
                dataSource={g.list}
                size="small"
                pagination={false}
                columns={[
                  ...(!talentId
                    ? [{
                        title: "候选人",
                        key: "talent",
                        width: 130,
                        render: (_: unknown, r: OnboardingItem) => (
                          <Link to={`/talents/${r.talent_id}`}>{r.talent_name || "-"}</Link>
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
                    render: (v: string, r: OnboardingItem) => (
                      // 点状态标签三态互切（支持回退），替代原先两个常驻按钮
                      <Dropdown
                        trigger={["click"]}
                        menu={{
                          items: (["pending", "submitted", "verified"] as const).map((s) => ({
                            key: s,
                            label: ONBOARDING_STATUS_LABELS[s],
                          })),
                          onClick: ({ key }) => handleToggle(r, key as "pending" | "submitted" | "verified"),
                        }}
                      >
                        <Tag color={statusColor(v)} style={{ cursor: "pointer" }} title="点击切换状态">
                          {ONBOARDING_STATUS_LABELS[v] || v}
                        </Tag>
                      </Dropdown>
                    ),
                  },
                  {
                    title: "操作",
                    key: "action",
                    width: 70,
                    fixed: "right" as const,
                    render: (_: unknown, r: OnboardingItem) => (
                      <Popconfirm title="删除该项？" onConfirm={async () => {
                        try { await api.deleteOnboardingItem(r.id); load(); } catch (e) { message.error((e as Error).message); }
                      }} okText="删除" cancelText="取消">
                        <Button type="link" size="small" danger>删除</Button>
                      </Popconfirm>
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

      {/* AI 入职清单预览：勾选需要的项后批量入库；AI 失败可退回「一键生成默认清单」 */}
      <Modal
        title="AI 生成的入职材料清单"
        open={aiCheck.open}
        onCancel={() => setAiCheck((s) => ({ ...s, open: false }))}
        footer={null}
        width={520}
        destroyOnClose
      >
        {aiCheck.loading ? (
          <AiThinking steps={["正在读取入职上下文…", "正在匹配岗位与城市…", "正在整理材料清单…"]} />
        ) : aiCheck.err ? (
          <Alert
            type="warning"
            showIcon
            message={`AI 暂不可用（${aiCheck.err}）`}
            description="可点「一键生成默认清单」先生成通用清单，稍后再用 AI 补充。"
          />
        ) : (
          <>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
              勾选需要的材料项，确认后批量加入清单；必交/选交入库后可再调整。
            </Typography.Text>
            <div style={{ maxHeight: 320, overflow: "auto", marginBottom: 12 }}>
              {aiCheck.options.map((o, i) => (
                <div
                  key={i}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid #f5f5f5" }}
                >
                  <Checkbox
                    checked={o._on}
                    onChange={(e) => setAiCheck((s) => ({
                      ...s,
                      options: s.options.map((x, j) => (j === i ? { ...x, _on: e.target.checked } : x)),
                    }))}
                  />
                  <span style={{ flex: 1 }}>{o.name}</span>
                  <Tag>{o.category}</Tag>
                  <Tag color={o.required ? "orange" : "default"}>{o.required ? "必交" : "选交"}</Tag>
                </div>
              ))}
            </div>
            <Space style={{ width: "100%", justifyContent: "flex-end" }}>
              <Button onClick={() => setAiCheck((s) => ({ ...s, open: false }))}>取消</Button>
              <Button type="primary" loading={aiSaving} onClick={confirmChecklist}>
                加入清单（{aiCheck.options.filter((o) => o._on).length} 项）
              </Button>
            </Space>
          </>
        )}
      </Modal>
    </div>
  );
}
