import { useEffect, useState } from "react";
import { Segmented, Tag, Drawer, Button, Input, Select, DatePicker, message, Spin, Popconfirm } from "antd";
import { CheckOutlined, DeleteOutlined, StopOutlined, PlusOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { api } from "../api";
import type { Task } from "../types";
import { PRIORITY_LABELS } from "../types";

const SCOPES = [
  { label: "未完成", value: "todo" },
  { label: "已完成", value: "done" },
  { label: "全部", value: "all" },
];

const PRIORITY_OPTIONS = Object.entries(PRIORITY_LABELS).map(([k, v]) => ({ label: v, value: k }));

export default function MTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [summary, setSummary] = useState({ pending: 0, overdue: 0, today: 0 });
  const [scope, setScope] = useState("todo");
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Task | null>(null);

  // 新建待办：手机上最容易冒出来的动作（面完随手记一条），所以做成悬浮按钮 + 底部抽屉
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<{
    title: string;
    due_date: dayjs.Dayjs | null;
    priority: string;
    content: string;
  }>({ title: "", due_date: null, priority: "normal", content: "" });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.getTasks({ scope });
      // 逾期排最前，其次按到期日升序，无日期的沉底
      const items = (res.items || []).slice().sort((a, b) => {
        if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
        if (!a.due_date) return 1;
        if (!b.due_date) return -1;
        return a.due_date < b.due_date ? -1 : 1;
      });
      setTasks(items);
      const s = await api.getTaskSummary();
      setSummary(s);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [scope]);

  const toggleDone = async (t: Task) => {
    const next = t.status === "done" ? "pending" : "done";
    try {
      await api.updateTaskStatus(t.id, next);
      message.success(next === "done" ? "已完成" : "已恢复未完成");
      setDetail(null);
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const remove = async (t: Task) => {
    try {
      await api.deleteTask(t.id);
      message.success("已删除");
      setDetail(null);
      load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const submit = async () => {
    if (!draft.title.trim()) {
      message.warning("先写点什么");
      return;
    }
    setSaving(true);
    try {
      await api.createTask({
        title: draft.title.trim(),
        content: draft.content.trim() || null,
        due_date: draft.due_date ? draft.due_date.format("YYYY-MM-DD") : null,
        priority: draft.priority,
        source: "manual",
      });
      message.success("待办已添加");
      setCreateOpen(false);
      setDraft({ title: "", due_date: null, priority: "normal", content: "" });
      // 新建后回到「未完成」视图，否则新待办可能不在当前筛选里，看着像没加上
      setScope("todo");
      load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const dueText = (t: Task) => {
    if (!t.due_date) return "无截止日期";
    const d = t.due_date.slice(0, 10);
    if (t.overdue) return `逾期 · ${d}`;
    if (t.due_today) return `今天到期 · ${d}`;
    return d;
  };

  return (
    // 底部留白：给悬浮新建按钮让位，否则它会盖住最后一张卡
    <div style={{ paddingBottom: 80 }}>
      <div className="m-stats">
        <div className={`m-stat${summary.overdue > 0 ? " is-bad" : ""}`}>
          <div className="m-stat-num">{summary.overdue}</div>
          <div className="m-stat-label">逾期</div>
        </div>
        <div className={`m-stat${summary.today > 0 ? " is-warn" : ""}`}>
          <div className="m-stat-num">{summary.today}</div>
          <div className="m-stat-label">今日</div>
        </div>
        <div className="m-stat">
          <div className="m-stat-num">{summary.pending}</div>
          <div className="m-stat-label">未完成</div>
        </div>
      </div>

      <Segmented
        block
        value={scope}
        onChange={(v) => setScope(v as string)}
        options={SCOPES}
        style={{ marginBottom: 12 }}
      />

      {loading ? (
        <div style={{ textAlign: "center", padding: "40px 0" }}>
          <Spin />
        </div>
      ) : tasks.length === 0 ? (
        <div className="m-empty">暂无待办</div>
      ) : (
        tasks.map((t) => (
          <div key={t.id} className="m-card m-card-row">
            <div style={{ flex: 1, minWidth: 0 }} onClick={() => setDetail(t)}>
              <div className="m-card-title" style={{ textDecoration: t.status === "done" ? "line-through" : undefined }}>
                {t.title}
              </div>
              <div className="m-card-meta">
                {[t.talent_name, t.job_title].filter(Boolean).join(" · ") || "无关联对象"}
              </div>
              <div className="m-card-meta">
                <span style={t.overdue && t.status !== "done" ? { color: "#ef4444" } : undefined}>
                  {dueText(t)}
                </span>
                {t.priority === "high" ? (
                  <Tag color="red" style={{ marginLeft: 8 }}>
                    {PRIORITY_LABELS[t.priority]}
                  </Tag>
                ) : null}
              </div>
            </div>
            <button
              className={`m-done-btn${t.status === "done" ? " done" : ""}`}
              onClick={() => toggleDone(t)}
              aria-label={t.status === "done" ? "恢复未完成" : "标记完成"}
            >
              <CheckOutlined />
            </button>
          </div>
        ))
      )}

      {/* 新建入口：悬浮在右下角，避开底部 TabBar */}
      <button className="m-fab" onClick={() => setCreateOpen(true)} aria-label="新建待办">
        <PlusOutlined />
      </button>

      <Drawer
        rootClassName="m-drawer"
        title="新建待办"
        placement="bottom"
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        height="auto"
        styles={{ body: { paddingBottom: 20 } }}
      >
        <div className="m-field-label">待办事项</div>
        <Input
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          placeholder="如：确认张三的复试时间"
        />

        <div className="m-field-label">到期日（可不填）</div>
        <DatePicker
          value={draft.due_date}
          onChange={(v) => setDraft({ ...draft, due_date: v })}
          style={{ width: "100%" }}
          placeholder="不限时"
        />

        <div className="m-field-label">优先级</div>
        <Select
          value={draft.priority}
          onChange={(v) => setDraft({ ...draft, priority: v })}
          options={PRIORITY_OPTIONS}
          style={{ width: "100%" }}
        />

        <div className="m-field-label">备注（可不填）</div>
        <Input.TextArea
          value={draft.content}
          onChange={(e) => setDraft({ ...draft, content: e.target.value })}
          rows={2}
          placeholder="补充说明…"
        />

        <div className="m-actions">
          <Button block type="primary" loading={saving} onClick={submit}>
            添加
          </Button>
          <Button block onClick={() => setCreateOpen(false)}>
            取消
          </Button>
        </div>
      </Drawer>

      <Drawer
        rootClassName="m-drawer"
        placement="bottom"
        open={!!detail}
        onClose={() => setDetail(null)}
        height="auto"
        styles={{ body: { paddingBottom: 20 } }}
      >
        {detail ? (
          <div>
            <div className="m-sheet-title">{detail.title}</div>
            <div className="m-sheet-sub">{dueText(detail)}</div>
            {detail.content ? <div style={{ fontSize: 14, lineHeight: 1.7 }}>{detail.content}</div> : null}
            <div className="m-actions">
              <Button block type="primary" icon={<CheckOutlined />} onClick={() => toggleDone(detail)}>
                {detail.status === "done" ? "恢复为未完成" : "标记完成"}
              </Button>
              <Popconfirm title="确定删除这条待办？" onConfirm={() => remove(detail)} okText="删除" cancelText="取消">
                <Button block danger icon={<DeleteOutlined />}>
                  删除
                </Button>
              </Popconfirm>
              {detail.status === "pending" ? (
                <Button
                  block
                  icon={<StopOutlined />}
                  onClick={async () => {
                    await api.updateTaskStatus(detail.id, "cancelled");
                    message.success("已取消");
                    setDetail(null);
                    load();
                  }}
                >
                  取消这条待办
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
