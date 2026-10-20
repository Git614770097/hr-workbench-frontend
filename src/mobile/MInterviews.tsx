import { useEffect, useMemo, useState } from "react";
import { Segmented, Drawer, Button, Tag, Rate, message, Spin, Popconfirm, Empty } from "antd";
import { PhoneOutlined, LinkOutlined, CheckCircleOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api";
import type { Interview } from "../types";
import { INTERVIEW_ROUND_LABELS, INTERVIEW_STATUS_LABELS } from "../types";

/**
 * 移动端面试页。
 *
 * 为什么值得单独做：HR 在手机上最高频的动作就是「今天有哪几场面试、几点、谁来」，
 * 其次是面完顺手把状态改一下。桌面端的面试管理页是按面试表组织的，在手机上要左右滚动，
 * 信息密度反而不如一张张卡片。
 * 这里只做「看 + 轻操作」（拨电话 / 复制会议链接 / 标记完成），复杂操作仍引导到完整版。
 */

const SCOPES = [
  { label: "待面试", value: "upcoming" },
  { label: "已完成", value: "done" },
  { label: "全部", value: "all" },
];

const STATUS_COLOR: Record<string, string> = {
  scheduled: "blue",
  done: "green",
  cancelled: "default",
  no_show: "red",
};

const MODE_LABEL: Record<string, string> = { online: "线上", onsite: "线下", phone: "电话" };

export default function MInterviews() {
  const [scope, setScope] = useState("upcoming");
  const [list, setList] = useState<Interview[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Interview | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.getInterviews();
      // 只看还没有明确结论的（status 未定）不算完，前端按 scheduled 归类
      const items = r.items || [];
      setList(
        items.slice().sort((a, b) => {
          const ta = a.scheduled_at || "";
          const tb = b.scheduled_at || "";
          if (scope === "upcoming") {
            // 待面试：按时间正序，无时间的沉底
            if (a.status === "scheduled" && b.status !== "scheduled") return -1;
            if (a.status !== "scheduled" && b.status === "scheduled") return 1;
          } else if (ta > tb) return -1;
          return ta > tb ? -1 : 1;
        })
      );
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const view = useMemo(() => {
    if (scope === "all") return list;
    if (scope === "done") return list.filter((i) => i.status === "done");
    return list.filter((i) => i.status === "scheduled");
  }, [list, scope]);

  // 按日期分组：今天 / 明天 / 更早或更晚
  const groups = useMemo(() => {
    const today = dayjs().format("YYYY-MM-DD");
    const tomorrow = dayjs().add(1, "day").format("YYYY-MM-DD");
    const buckets: { key: string; label: string; items: Interview[] }[] = [
      { key: "today", label: "今天", items: [] },
      { key: "tomorrow", label: "明天", items: [] },
      { key: "later", label: "最近", items: [] },
    ];
    for (const it of view) {
      const d = (it.scheduled_at || "").slice(0, 10);
      if (d === today) buckets[0].items.push(it);
      else if (d === tomorrow) buckets[1].items.push(it);
      else buckets[2].items.push(it);
    }
    return buckets.filter((b) => b.items.length > 0);
  }, [view]);

  const markDone = async (it: Interview) => {
    setSaving(true);
    try {
      await api.quickUpdateInterview(it.id, { status: "done" });
      message.success("已标记为已完成");
      setDetail(null);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="m-filter">
        <Segmented
          block
          value={scope}
          onChange={(v) => setScope(v as string)}
          options={SCOPES}
        />
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "40px 0" }}>
          <Spin />
        </div>
      ) : groups.length === 0 ? (
        <Empty style={{ marginTop: 40 }} description="暂无面试安排" />
      ) : (
        groups.map((g) => (
          <div key={g.key}>
            <div className="m-field-label" style={{ padding: "8px 12px 4px" }}>{g.label}</div>
            {g.items.map((it) => {
              const overdue =
                it.status === "scheduled" &&
                it.scheduled_at &&
                dayjs(it.scheduled_at).isBefore(dayjs());
              return (
                <div key={it.id} className="m-card" onClick={() => setDetail(it)}>
                  <div className="m-card-row" style={{ justifyContent: "space-between" }}>
                    <span className="m-card-title">{it.talent_name || "未命名候选人"}</span>
                    {overdue ? (
                      <Tag color="red" style={{ marginInlineEnd: 0 }}>已过时间</Tag>
                    ) : (
                      <Tag color={STATUS_COLOR[it.status] || "blue"} style={{ marginInlineEnd: 0 }}>
                        {INTERVIEW_STATUS_LABELS[it.status] || it.status}
                      </Tag>
                    )}
                  </div>
                  <div className="m-card-meta">
                    {it.scheduled_at ? `${it.scheduled_at.slice(5, 16).replace("T", " ")}` : "未定时间"}
                    {` · ${it.duration || 60} 分钟`}
                  </div>
                  <div className="m-card-meta">
                    {INTERVIEW_ROUND_LABELS[it.round] || it.round} · {MODE_LABEL[it.mode] || it.mode}
                    {it.job_title ? ` · ${it.job_title}` : ""}
                  </div>
                </div>
              );
            })}
          </div>
        ))
      )}

      <Drawer
        rootClassName="m-drawer"
        placement="bottom"
        open={!!detail}
        onClose={() => setDetail(null)}
        height="auto"
        styles={{ body: { paddingBottom: 20, maxHeight: "72vh", overflowY: "auto" } }}
      >
        {detail ? (
          <div>
            <div className="m-sheet-title">{detail.talent_name}</div>
            <div className="m-sheet-sub">
              {detail.job_title || "未关联岗位"}
              {detail.job_department ? ` · ${detail.job_department}` : ""}
            </div>

            <div style={{ margin: "8px 0 12px", display: "flex", flexWrap: "wrap", gap: 6 }}>
              <Tag color="blue">{INTERVIEW_ROUND_LABELS[detail.round] || detail.round}</Tag>
              <Tag>{MODE_LABEL[detail.mode] || detail.mode}</Tag>
              <Tag color={STATUS_COLOR[detail.status] || "blue"}>
                {INTERVIEW_STATUS_LABELS[detail.status] || detail.status}
              </Tag>
              {detail.result ? <Tag color={detail.result === "pass" ? "green" : "red"}>
                {detail.result === "pass" ? "通过" : "不通过"}
              </Tag> : null}
            </div>

            {detail.scheduled_at ? (
              <>
                <div className="m-field-label">时间</div>
                <div className="m-card-meta" style={{ padding: "0 0 8px" }}>
                  {detail.scheduled_at.replace("T", " ")} · {detail.duration || 60} 分钟
                </div>
              </>
            ) : null}

            {detail.interviewer ? (
              <>
                <div className="m-field-label">面试官</div>
                <div className="m-card-meta" style={{ padding: "0 0 8px" }}>{detail.interviewer}</div>
              </>
            ) : null}

            {detail.mode === "online" && detail.meeting_url ? (
              <>
                <div className="m-field-label">会议链接</div>
                <div className="m-card-meta" style={{ padding: "0 0 8px", wordBreak: "break-all" }}>
                  {detail.meeting_url}
                </div>
              </>
            ) : null}

            {detail.mode === "onsite" && detail.location ? (
              <>
                <div className="m-field-label">地点</div>
                <div className="m-card-meta" style={{ padding: "0 0 8px" }}>{detail.location}</div>
              </>
            ) : null}

            {detail.evaluation ? (
              <>
                <div className="m-field-label">面试评价</div>
                <div className="m-card-meta" style={{ padding: "0 0 8px", whiteSpace: "pre-wrap" }}>
                  {detail.evaluation}
                </div>
              </>
            ) : null}

            {detail.score ? <Rate disabled value={detail.score} style={{ fontSize: 16 }} /> : null}

            <div className="m-actions">
              {detail.talent_phone ? (
                <Button block icon={<PhoneOutlined />} href={`tel:${detail.talent_phone}`}>
                  拨打 {detail.talent_phone}
                </Button>
              ) : null}
              {detail.mode === "online" && detail.meeting_url ? (
                <Button
                  block
                  icon={<LinkOutlined />}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(detail.meeting_url || "");
                      message.success("会议链接已复制");
                    } catch {
                      message.error("复制失败，请手动选择");
                    }
                  }}
                >
                  复制会议链接
                </Button>
              ) : null}

              {detail.status === "scheduled" ? (
                <Popconfirm title="标记为已完成？" okText="标记" cancelText="取消" onConfirm={() => markDone(detail)}>
                  <Button block type="primary" icon={<CheckCircleOutlined />} loading={saving}>
                    标记已完成
                  </Button>
                </Popconfirm>
              ) : null}

              <Button block type="text" onClick={() => setDetail(null)}>
                关闭
              </Button>
            </div>

            <div style={{ marginTop: 12, textAlign: "center" }}>
              <span style={{ fontSize: 12, color: "var(--m-text-sub)" }}>
                填写面试评价与结论，请切换到完整版操作
              </span>
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
