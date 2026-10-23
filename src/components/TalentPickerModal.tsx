import { useState, useEffect, useRef } from "react";
import { Modal, Input, Table, Button, Tag, Space, Typography, Tooltip, message } from "antd";
import { LoadingOutlined } from "@ant-design/icons";
import { api } from "../api";
import type { Talent } from "../types";
import { useIdentityProfile } from "../useIdentity";
import { termFor } from "../identityProfiles";

interface Props {
  open: boolean;
  /** 已经在比选列表里的库内人才 id，避免重复添加 */
  excludeIds: string[];
  onCancel: () => void;
  onOk: (rows: Talent[]) => void;
}

const PAGE_SIZE = 20;
/** 输入即检索的防抖间隔：低于 300ms 会在快速输入时打出过多查询，高于 500ms 会觉得迟钝 */
const SEARCH_DEBOUNCE_MS = 350;

/**
 * 从人才库勾选已有人选参与人才AI匹配。
 * 只负责"选人"：简历原文的抽取由调用方做（那里才有解析管线），本组件不碰文件。
 *
 * 检索是「输入即查」（无查询按钮），三个坑必须处理：
 * 1. 竞态：连续输入会并发多个请求，慢的「张」可能覆盖快的「张三」→ 用递增 seq 只认最新一次
 * 2. 中文输入法：拼音组词过程中 onChange 会带出 zhangs 这类中间态 → composition 期间不查
 * 3. 闪烁：Table 的 loading 会让整张表每敲一个字闪白 → 只在输入框右侧转小圈，表格保留旧结果
 */
export default function TalentPickerModal({ open, excludeIds, onCancel, onOk }: Props) {
  const [rows, setRows] = useState<Talent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  /** 输入框里的当前值（每次按键都变） */
  const [kw, setKw] = useState("");
  /** 已经生效的检索词（分页要用它，不能跟着输入框乱变） */
  const [query, setQuery] = useState("");
  /** 表格 loading：只在首次打开和翻页时出现 */
  const [loading, setLoading] = useState(false);
  /** 输入框右侧的小转圈：输入即查时出现 */
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Talent[]>([]);
  const profile = useIdentityProfile();

  /** 请求序号：只有最后一次发出的请求才有权写入结果 */
  const seqRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  /** 输入法是否正在组词（true 时不触发查询） */
  const composingRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // 常驻挂载时 open 再次变 true 必须重置，否则上次的搜索词/选中项会残留
  useEffect(() => {
    if (!open) return;
    setPage(1);
    setKw("");
    setQuery("");
    setSelected([]);
    load(1, "", "table");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 关闭 / 卸载时把待触发的防抖定时器清掉，避免请求打到已关闭的弹窗
  useEffect(() => () => clearTimer(), []);

  const load = async (p: number, q: string, mode: "table" | "search" = "table") => {
    const seq = ++seqRef.current;
    if (mode === "table") setLoading(true);
    else setSearching(true);
    try {
      const res = await api.getTalents({ q, page: p, limit: PAGE_SIZE });
      // 过期响应直接丢弃：期间用户又输入了新的词
      if (seq !== seqRef.current) return;
      setRows(res.items || []);
      setTotal(res.total || 0);
    } catch (err) {
      if (seq !== seqRef.current) return;
      message.error((err as Error).message);
    } finally {
      // 只有最新那次请求有权收掉加载态，否则旧请求会把新请求的转圈提前关掉
      if (seq === seqRef.current) {
        setLoading(false);
        setSearching(false);
      }
    }
  };

  /** 真正发起一次检索：词没变就不重复请求（删字又打回同一个词的情况很常见）；force=回车强制刷新 */
  const runSearch = (value: string, force = false) => {
    const q = value.trim();
    if (!force && q === query) return;
    setQuery(q);
    setPage(1);
    load(1, q, "search");
  };

  const handleKwChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setKw(v);
    // 输入法组词中：等 compositionend 再查，否则会拿拼音中间态去搜
    if (composingRef.current) return;
    clearTimer();
    timerRef.current = window.setTimeout(() => runSearch(v), SEARCH_DEBOUNCE_MS);
  };

  const handleCompositionEnd = (e: React.CompositionEvent<HTMLInputElement>) => {
    composingRef.current = false;
    clearTimer();
    runSearch((e.target as HTMLInputElement).value);
  };

  // 支持跨页多选：本页之外的选中项原样保留，本页以当前勾选状态为准。
  // ⚠️ 不能在这里再用 `!prev.some(...)` 去重：上一行已把本页旧选中清空了，
  // 再去重会把本页已勾的项一起排掉，表现为"勾新的就把旧的顶掉"（只能选一个）。
  const handleSelectChange = (keys: React.Key[]) => {
    const keySet = new Set(keys.map(String));
    const pageIds = new Set(rows.map((r) => r.id));
    setSelected((prev) => [
      ...prev.filter((t) => !pageIds.has(t.id)),
      ...rows.filter((r) => keySet.has(r.id)),
    ]);
  };

  return (
    <Modal
      title={termFor(profile, "从人才库添加人选")}
      open={open}
      onCancel={onCancel}
      width={1080}
      getContainer={() => document.body}
      zIndex={1050}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Typography.Text type="secondary">
            已选 <Typography.Text strong style={{ color: "#1677ff" }}>{selected.length}</Typography.Text> 人
            <span style={{ marginLeft: 6 }}>· 可勾选多人，跨页选择会保留</span>
            {excludeIds.length > 0 && `（${excludeIds.length} 位已在比选列表中，不可重复勾选）`}
          </Typography.Text>
          <Space>
            {selected.length > 0 && (
              <Button type="link" style={{ paddingInline: 0 }} onClick={() => setSelected([])}>
                清空已选
              </Button>
            )}
            <Button onClick={onCancel}>取消</Button>
            <Button type="primary" disabled={selected.length === 0} onClick={() => onOk(selected)}>
              {selected.length > 0 ? `加入比选（${selected.length}）` : "加入比选"}
            </Button>
          </Space>
        </div>
      }
    >
      <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
        <Input
          style={{ width: 300 }}
          allowClear
          value={kw}
          placeholder="输入即搜索：姓名 / 公司 / 职位 / 技能"
          suffix={searching ? <LoadingOutlined style={{ color: "#1677ff" }} /> : null}
          onChange={handleKwChange}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={handleCompositionEnd}
          onPressEnter={() => { clearTimer(); runSearch(kw, true); }}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {searching ? "搜索中…" : loading ? "加载中…" : query ? `「${query}」命中 ${total} 人` : `共 ${total} 人`}
        </Typography.Text>
      </div>

      <Table
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={rows}
        rowSelection={{
          selectedRowKeys: selected.map((s) => s.id),
          onChange: handleSelectChange,
          getCheckboxProps: (r) => ({ disabled: excludeIds.includes(r.id) }),
        }}
        // 点行也能勾选（复选框区域除外，避免与 onChange 重复触发一次）
        onRow={(r) => {
          const disabled = excludeIds.includes(r.id);
          return {
            onClick: (e) => {
              if (disabled) return;
              if ((e.target as HTMLElement).closest(".ant-table-selection-column")) return;
              const ids = selected.map((s) => s.id);
              handleSelectChange(ids.includes(r.id) ? ids.filter((x) => x !== r.id) : [...ids, r.id]);
            },
            style: { cursor: disabled ? "not-allowed" : "pointer" },
          };
        }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total,
          size: "small",
          showSizeChanger: false,
          onChange: (p) => { setPage(p); load(p, query); },
        }}
        columns={[
          { title: "姓名", dataIndex: "name", width: 100 },
          { title: "当前职位", dataIndex: "current_title", ellipsis: true, render: (v) => v || "-" },
          { title: "公司", dataIndex: "current_company", width: 160, ellipsis: true, render: (v) => v || "-" },
          {
            title: "年限",
            dataIndex: "years_experience",
            width: 80,
            render: (v) => (v != null ? `${v} 年` : "-"),
          },
          { title: "城市", dataIndex: "city", width: 90, render: (v) => v || "-" },
          { title: "学历", dataIndex: "education", width: 80, render: (v) => v || "-" },
          {
            title: "技能",
            dataIndex: "skills",
            width: 220,
            ellipsis: true,
            render: (v: string[] | null) =>
              v && v.length > 0 ? (
                <span>{v.slice(0, 4).join("、")}{v.length > 4 ? " …" : ""}</span>
              ) : "-",
          },
          {
            title: "简历",
            dataIndex: "resume_url",
            width: 90,
            render: (v) =>
              v ? (
                <Tag color="blue">有原文</Tag>
              ) : (
                <Tooltip title="未存简历原文，只能用已录入字段比对，评分依据较弱">
                  <Tag>仅字段</Tag>
                </Tooltip>
              ),
          },
        ]}
      />
    </Modal>
  );
}
