import { useEffect, useState } from "react";
import {
  Modal, Table, Tag, Button, Space, Empty, Typography, Tooltip, message,
} from "antd";
import { ReloadOutlined, HistoryOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { ImportBatch, ImportBatchItem } from "../types";
import { useAsyncData } from "../hooks/useAsyncData";
import { fmtDateTime } from "../utils/time";

/**
 * 导入记录 —— 回答「上次那 20 份为什么只进来 13 份」。
 *
 * 为什么要这个页面：导入是纯前端编排的（每份简历单独调一次接口），解析失败、
 * 去重跳过、录入报错这些状态原本只活在 React state 里，弹窗一关就没了。
 * 用户唯一能感知的结果就是「列表里少了几个人」，却完全不知道少的是谁、为什么。
 *
 * 计数口径（四数相加恒等于上传份数）：
 *   上传 = 已录入 + 重复跳过 + 失败 + 未处理
 * 「重复跳过」不算失败——那是判重在正常工作；「未处理」也不是失败——
 * 是用户自己放弃的（中途关弹窗 / 点了移除）。混成一个数字会让用户误判数据质量。
 *
 * 明细按需加载：展开某一行才去拉那一批的逐份记录，不在列表里一次拉全量。
 */

const STATUS_META: Record<string, { label: string; color: string }> = {
  imported: { label: "已录入", color: "green" },
  duplicate: { label: "重复跳过", color: "gold" },
  failed: { label: "失败", color: "red" },
  pending: { label: "未处理", color: "default" },
};

function fmtSize(n: number | null): string {
  if (!n || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function ImportHistoryModal({ open, onClose }: Props) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  // 展开的批次（手风琴式，同时只展开一个：逐份明细不短，展开多个要滚很久）
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 明细缓存：展开时才拉。key 为批次 id，值为 "loading" 或已拉到的数据
  const [details, setDetails] = useState<Record<string, { batch: ImportBatch; items: ImportBatchItem[] } | "loading">>({});

  const { data, loading, reload } = useAsyncData(
    () => api.getImportBatches({ page, limit: pageSize }),
    [page, pageSize],
    { enabled: open, keepOnError: true }
  );

  // 每次打开都回到第一页、收起展开行、丢掉上次的明细缓存
  useEffect(() => {
    if (!open) return;
    setPage(1);
    setExpandedId(null);
    setDetails({});
  }, [open]);

  const loadDetail = async (id: string) => {
    if (details[id]) return;
    setDetails((d) => ({ ...d, [id]: "loading" }));
    try {
      const res = await api.getImportBatch(id);
      setDetails((d) => ({ ...d, [id]: res }));
    } catch (e) {
      // 失败就把 loading 占位撤掉，让用户可以重试
      setDetails((d) => {
        const next = { ...d };
        delete next[id];
        return next;
      });
      message.error((e as Error).message);
    }
  };

  const onExpand = (expanded: boolean, record: ImportBatch) => {
    setExpandedId(expanded ? record.id : null);
    if (expanded) loadDetail(record.id);
  };

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  // 当前页合计：直接回答用户「上传几份、录入几份、失败几份」的原始问题。
  // 只统计本页（全部批次要另发一次聚合查询，而用户真正关心的是最近这几批）。
  const sum = items.reduce(
    (a, b) => ({
      total: a.total + b.total,
      imported: a.imported + b.imported,
      duplicate: a.duplicate + b.duplicate,
      failed: a.failed + b.failed,
      pending: a.pending + b.pending,
    }),
    { total: 0, imported: 0, duplicate: 0, failed: 0, pending: 0 }
  );

  const batchColumns = [
    {
      title: "时间",
      dataIndex: "started_at",
      width: 130,
      render: (v: string, r: ImportBatch) => (
        <div>
          <div>{fmtDateTime(v)}</div>
          {/* 没结束说明中途关了浏览器：这本身是用户想知道的信息 */}
          {!r.finished_at && (
            <Tooltip title="没有正常结束：可能中途关闭了页面，未处理的简历留在了「未处理」">
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>未结束</Typography.Text>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      title: "操作人",
      dataIndex: "user_name",
      width: 90,
      render: (v: string | null) => v || "—",
    },
    {
      title: "来源渠道",
      dataIndex: "source",
      width: 100,
      render: (v: string | null) => v || <Typography.Text type="secondary">未记录</Typography.Text>,
    },
    {
      title: "上传",
      dataIndex: "total",
      width: 64,
      align: "right" as const,
      render: (v: number) => <b>{v}</b>,
    },
    {
      title: "录入",
      dataIndex: "imported",
      width: 64,
      align: "right" as const,
      render: (v: number) => <span style={{ color: v > 0 ? "#389e0d" : undefined }}>{v}</span>,
    },
    {
      title: "重复",
      dataIndex: "duplicate",
      width: 64,
      align: "right" as const,
      render: (v: number) => (v > 0 ? v : <Typography.Text type="secondary">0</Typography.Text>),
    },
    {
      title: "失败",
      dataIndex: "failed",
      width: 64,
      align: "right" as const,
      render: (v: number) => (v > 0 ? <span style={{ color: "#cf1322", fontWeight: 600 }}>{v}</span> : <Typography.Text type="secondary">0</Typography.Text>),
    },
    {
      title: "未处理",
      dataIndex: "pending",
      width: 74,
      align: "right" as const,
      render: (v: number) => (v > 0 ? v : <Typography.Text type="secondary">0</Typography.Text>),
    },
  ];

  const itemColumns = [
    {
      title: "文件",
      dataIndex: "file_name",
      ellipsis: true,
      render: (v: string | null) => v || "—",
    },
    {
      title: "大小",
      dataIndex: "file_size",
      width: 80,
      render: (v: number | null) => <Typography.Text type="secondary">{fmtSize(v)}</Typography.Text>,
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 96,
      render: (v: string) => {
        const m = STATUS_META[v] || { label: v, color: "default" };
        return <Tag color={m.color}>{m.label}</Tag>;
      },
    },
    {
      title: "人才",
      dataIndex: "talent_name",
      width: 110,
      ellipsis: true,
      render: (v: string | null, r: ImportBatchItem) => {
        if (!v) return "—";
        // 人才被删了就不给链接：点进去只会看到「人才不存在」，比不给链接更让人困惑
        return r.talent_id && r.talent_alive
          ? <Link to={`/talents/${r.talent_id}`}>{v}</Link>
          : <span>{v}<Typography.Text type="secondary" style={{ fontSize: 12 }}>（已删除）</Typography.Text></span>;
      },
    },
    {
      title: "说明",
      dataIndex: "error",
      render: (v: string | null, r: ImportBatchItem) => {
        if (v) return <Typography.Text type="danger" style={{ fontSize: 12 }}>{v}</Typography.Text>;
        if (r.parse_source === "ai") return <Typography.Text type="secondary" style={{ fontSize: 12 }}>AI 解析</Typography.Text>;
        if (r.parse_source === "local") return <Typography.Text type="secondary" style={{ fontSize: 12 }}>本地规则解析</Typography.Text>;
        return <Typography.Text type="secondary" style={{ fontSize: 12 }}>—</Typography.Text>;
      },
    },
  ];

  return (
    <Modal
      title={<Space><HistoryOutlined />导入记录</Space>}
      open={open}
      onCancel={onClose}
      footer={null}
      width={960}
      destroyOnClose
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12, fontSize: 13 }}>
        每次「导入简历」会记一个批次，逐份记录解析与录入结果，保留 180 天。
        <b>上传 = 已录入 + 重复跳过 + 失败 + 未处理</b>，四个数相加对不上说明有记录还没回写（刷新即可）。
      </Typography.Paragraph>

      {/* 当前页合计：直接给「上传几份、录入几份、失败几份」这三个数 */}
      {items.length > 0 && (
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 12, fontSize: 13 }}>
          <span>本页批次 <b>{items.length}</b></span>
          <span>上传 <b>{sum.total}</b> 份</span>
          <span>录入 <b style={{ color: "#389e0d" }}>{sum.imported}</b> 份</span>
          <span>重复跳过 <b>{sum.duplicate}</b> 份</span>
          <span>失败 <b style={{ color: sum.failed > 0 ? "#cf1322" : undefined }}>{sum.failed}</b> 份</span>
          <span>未处理 <b>{sum.pending}</b> 份</span>
        </div>
      )}

      <Table<ImportBatch>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={items}
        columns={batchColumns}
        scroll={{ x: 760 }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="还没有导入记录。点人才库的「导入」上传简历后，这里会有逐份结果。"
            />
          ),
        }}
        expandable={{
          expandedRowKeys: expandedId ? [expandedId] : [],
          onExpand: (expanded, record) => onExpand(expanded, record),
          expandedRowRender: (record) => {
            const d = details[record.id];
            if (!d || d === "loading") {
              return <Typography.Text type="secondary">正在加载逐份明细…</Typography.Text>;
            }
            return (
              <Table<ImportBatchItem>
                rowKey="id"
                size="small"
                dataSource={d.items}
                columns={itemColumns}
                pagination={d.items.length > 10 ? { pageSize: 10, size: "small" } : false}
                locale={{ emptyText: "这一批没有任何文件记录" }}
              />
            );
          },
        }}
        pagination={{
          current: page,
          pageSize,
          total,
          size: "small",
          showSizeChanger: true,
          pageSizeOptions: [10, 20, 50],
          showTotal: (n) => `共 ${n} 个批次`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
            setExpandedId(null);
          },
        }}
      />

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
        <Button size="small" icon={<ReloadOutlined />} onClick={() => { setDetails({}); void reload(); }}>
          刷新
        </Button>
      </div>
    </Modal>
  );
}
