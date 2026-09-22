import { useState, useEffect } from "react";
import { Modal, Input, Table, Button, Tag, Space, Typography, Tooltip, message } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { api } from "../api";
import type { Talent } from "../types";

interface Props {
  open: boolean;
  /** 已经在比选列表里的库内人才 id，避免重复添加 */
  excludeIds: string[];
  onCancel: () => void;
  onOk: (rows: Talent[]) => void;
}

const PAGE_SIZE = 20;

/**
 * 从人才库勾选已有人选参与智能匹配。
 * 只负责"选人"：简历原文的抽取由调用方做（那里才有解析管线），本组件不碰文件。
 */
export default function TalentPickerModal({ open, excludeIds, onCancel, onOk }: Props) {
  const [rows, setRows] = useState<Talent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [kw, setKw] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Talent[]>([]);

  // 常驻挂载时 open 再次变 true 必须重置，否则上次的搜索词/选中项会残留
  useEffect(() => {
    if (!open) return;
    setPage(1);
    setKw("");
    setQuery("");
    setSelected([]);
    load(1, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const load = async (p: number, q: string) => {
    setLoading(true);
    try {
      const res = await api.getTalents({ q, page: p, limit: PAGE_SIZE });
      setRows(res.items || []);
      setTotal(res.total || 0);
    } catch (err) {
      message.error((err as Error).message);
    }
    setLoading(false);
  };

  const handleSearch = () => {
    setPage(1);
    setQuery(kw.trim());
    load(1, kw.trim());
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
      title="从人才库添加人选"
      open={open}
      onCancel={onCancel}
      width={900}
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
      <Space style={{ marginBottom: 12 }}>
        <Input
          style={{ width: 260 }}
          allowClear
          value={kw}
          placeholder="姓名 / 公司 / 职位 / 技能"
          onChange={(e) => setKw(e.target.value)}
          onPressEnter={handleSearch}
        />
        <Button icon={<SearchOutlined />} onClick={handleSearch}>查询</Button>
      </Space>

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
          { title: "公司", dataIndex: "current_company", ellipsis: true, render: (v) => v || "-" },
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
