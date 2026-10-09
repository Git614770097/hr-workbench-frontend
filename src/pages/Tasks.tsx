import { useState, useEffect, useCallback, useMemo, useRef, type DragEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Card, Button, Space, Tag, Input, Select, Checkbox, Popconfirm, message,
  Modal, Form, DatePicker, Empty, Spin, Tooltip, Dropdown, Calendar,
} from "antd";
import type { CalendarProps } from "antd";
import {
  PlusOutlined, DeleteOutlined, EditOutlined, ClockCircleOutlined,
  CheckCircleOutlined, CheckOutlined, MoreOutlined, LinkOutlined, UserOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import type { Dayjs } from "dayjs";
import type { MenuProps } from "antd";
import { api } from "../api";
import type { Task, User } from "../types";
import { PRIORITY_LABELS, PRIORITY_COLORS, TASK_SOURCE_LABELS } from "../types";
import { dayInfo, hasHolidayData, knownYears } from "../utils/holidays";
import { useIdentityProfile } from "../useIdentity";
import { termFor } from "../identityProfiles";

const todayYmd = () => dayjs().format("YYYY-MM-DD");

/** 日期类型 → 展示文案与配色 */
const DAY_TYPE_TEXT: Record<string, { label: string; color: string }> = {
  holiday: { label: "法定节假日", color: "#cf1322" },
  makeup: { label: "调休上班", color: "#595959" },
  weekend: { label: "周末", color: "#8c8c8c" },
  workday: { label: "工作日", color: "#595959" },
};

// 日历格子的角标类型：今天（今/蓝）> 法定节假日（休/红）> 补班（班/灰）> 周末（休/浅灰）
type DayKind = "today" | "holiday" | "makeup" | "weekend" | "workday";

const dayKind = (ymd: string): { kind: DayKind; text: string; name?: string } => {
  if (ymd === todayYmd()) return { kind: "today", text: "今" };
  const d = dayInfo(ymd);
  if (d.type === "holiday") return { kind: "holiday", text: "休", name: d.name };
  if (d.type === "makeup") return { kind: "makeup", text: "班" };
  if (d.type === "weekend") return { kind: "weekend", text: "休" };
  return { kind: "workday", text: "" };
};

const KIND_TITLE: Record<Exclude<DayKind, "workday">, string> = {
  today: "今天",
  holiday: "法定节假日",
  makeup: "调休上班（需上班）",
  weekend: "周末",
};

/** 日历格子内最多展示几条待办（一条一行），超出折叠为「+N 项」 */
const CAL_LINE_MAX = 2;

/** 优先级归一化：后端是自由字符串，非预期值一律按「中」处理 */
const prioOf = (p: string) => (p === "high" ? "high" : p === "low" ? "low" : "normal");

export default function Tasks() {
  const profile = useIdentityProfile();
  const [searchParams, setSearchParams] = useSearchParams();
  const talentFilter = searchParams.get("talent_id") || "";

  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [talents, setTalents] = useState<{ id: string; name: string }[]>([]);
  const [jobs, setJobs] = useState<{ id: string; title: string }[]>([]);

  // 日历状态：viewMonth 控制显示哪个月，selected 为选中日期（null = 看未指定日期）
  const [viewMonth, setViewMonth] = useState<Dayjs>(() => dayjs().startOf("month"));
  const [selected, setSelected] = useState<string | null>(todayYmd());

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const currentUser: User | null = (() => {
    try { return JSON.parse(localStorage.getItem("user") || "null"); } catch { return null; }
  })();
  const isAdmin = currentUser?.role === "admin";

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getTasks({
        scope: "all",
        talent_id: talentFilter || undefined,
      });
      setTasks(res.items);
    } catch (err) {
      message.error((err as Error).message);
    }
    setLoading(false);
  }, [talentFilter]);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  useEffect(() => {
    api.getTalents({ page: 1, limit: 500 })
      .then((r) => setTalents(r.items.map((t) => ({ id: t.id, name: t.name }))))
      .catch(() => {});
    api.getJobOptions().then((r) => setJobs(r.map((j) => ({ id: j.id, title: j.title })))).catch(() => {});
  }, []);

  // 按到期日分组（日历格子用）；无到期日的单独放一组
  const byDate = useMemo(() => {
    const m: Record<string, Task[]> = {};
    for (const t of tasks) {
      if (!t.due_date) continue;
      (m[t.due_date] = m[t.due_date] || []).push(t);
    }
    return m;
  }, [tasks]);
  const undated = useMemo(() => tasks.filter((t) => !t.due_date), [tasks]);

  const openCreate = (ymd?: string | null) => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      priority: "normal",
      talent_id: talentFilter || undefined,
      due_date: ymd ? dayjs(ymd) : null,
    });
    setModalOpen(true);
  };

  const openEdit = (t: Task) => {
    setEditing(t);
    form.setFieldsValue({ ...t, due_date: t.due_date ? dayjs(t.due_date) : null });
    setModalOpen(true);
  };

  const handleSubmit = async (values: any) => {
    setSaving(true);
    try {
      const data = { ...values, due_date: values.due_date ? values.due_date.format("YYYY-MM-DD") : null };
      if (editing) {
        await api.updateTask(editing.id, data);
        message.success("待办已更新");
      } else {
        await api.createTask({ ...data, source: "manual" });
        message.success("待办已创建");
      }
      form.resetFields();
      setModalOpen(false);
      fetchTasks();
    } catch (err) {
      message.error((err as Error).message);
    }
    setSaving(false);
  };

  const toggleDone = async (t: Task) => {
    try {
      await api.updateTaskStatus(t.id, t.status === "done" ? "pending" : "done");
      fetchTasks();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const handleDelete = async (t: Task) => {
    try {
      await api.deleteTask(t.id);
      message.success("已删除");
      fetchTasks();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  // ===== 拖拽改期：从右侧列表拖待办到日历格子松手即改期 =====
  // 高亮与落点解析都用 DOM class 操作，避免 dragover 高频触发导致重渲。
  const dndRef = useRef<HTMLDivElement>(null);
  const clearDropTarget = () => {
    dndRef.current?.querySelector(".task-drop-target")?.classList.remove("task-drop-target");
  };
  const onCalDragOver = (e: DragEvent<HTMLDivElement>) => {
    const cell = (e.target as HTMLElement).closest(".ant-picker-cell");
    if (!(cell instanceof HTMLElement) || !dndRef.current?.contains(cell)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    clearDropTarget();
    cell.classList.add("task-drop-target");
  };
  const onCalDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!dndRef.current?.contains(e.relatedTarget as Node | null)) clearDropTarget();
  };
  const onCalDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    clearDropTarget();
    const id = e.dataTransfer.getData("text/plain");
    // 落点优先取自内容区的 data-ymd；落在日期数字上时向上找格子再取其内的 data-ymd
    const el = e.target as HTMLElement;
    const host = el.closest<HTMLElement>("[data-ymd]")
      || el.closest(".ant-picker-cell")?.querySelector<HTMLElement>("[data-ymd]");
    const ymd = host?.getAttribute("data-ymd") || "";
    const t = tasks.find((x) => x.id === id);
    if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(ymd) || t.due_date === ymd) return;
    try {
      await api.updateTask(t.id, { due_date: ymd });
      message.success(`「${t.title.slice(0, 12)}${t.title.length > 12 ? "…" : ""}」已改期至 ${dayjs(ymd).format("M月D日")}`);
      fetchTasks();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const moreMenu = (t: Task): MenuProps["items"] => [
    { key: "edit", label: "编辑待办", icon: <EditOutlined /> },
    {
      key: "cancel",
      label: t.status === "cancelled" ? "恢复为待办" : "标记为已取消",
      icon: <ClockCircleOutlined />,
    },
    { type: "divider" },
    { key: "delete", label: "删除", icon: <DeleteOutlined />, danger: true },
  ];

  const onMoreClick = async (t: Task, key: string) => {
    if (key === "edit") return openEdit(t);
    if (key === "delete") return handleDelete(t);
    if (key === "cancel") {
      try {
        await api.updateTaskStatus(t.id, t.status === "cancelled" ? "pending" : "cancelled");
        fetchTasks();
      } catch (err) {
        message.error((err as Error).message);
      }
    }
  };

  // 到期文案
  const dueText = (t: Task) => {
    if (!t.due_date) return "不限时";
    if (t.status !== "pending") return t.due_date;
    if (t.days_left === null) return t.due_date;
    if (t.days_left < 0) return `${t.due_date}（逾期 ${-t.days_left} 天）`;
    if (t.days_left === 0) return `${t.due_date}（今天）`;
    return `${t.due_date}（还剩 ${t.days_left} 天）`;
  };

  const dueColor = (t: Task) => {
    if (t.status !== "pending") return "#8c8c8c";
    if (t.overdue) return "#ff4d4f";
    if (t.due_today) return "#faad14";
    return "#8c8c8c";
  };

  // 日历格子内容：antd 会把返回值放进日期数字下方的内容区，
  // 这里只返回标记本身，不能再带上 info.originNode（否则日期数字会渲染两遍）。
  const cellRender: CalendarProps<Dayjs>["cellRender"] = (current, info) => {
    if (info.type !== "date") return info.originNode;
    const ymd = current.format("YYYY-MM-DD");
    const k = dayKind(ymd);
    const list = byDate[ymd] || [];
    return (
      <div className="task-cal-cell" data-ymd={ymd}>
        {k.kind !== "workday" && (
          <>
            {/* 整格同色色块（铺满格子，数字与角标浮在其上） */}
            <span className={`task-cal-flag is-${k.kind}`} />
            <span
              className={`task-cal-corner is-${k.kind}`}
              title={k.kind === "holiday" && k.name ? `${k.name}（${KIND_TITLE.holiday}）` : KIND_TITLE[k.kind]}
            >
              {k.text}
            </span>
          </>
        )}
        {list.length > 0 && (
          <div className="task-cal-lines">
            {/* 一条待办一行；超过 CAL_LINE_MAX 行后折叠为「+N 项」，避免撑高整行格子 */}
            {list.slice(0, CAL_LINE_MAX).map((t) => {
              const closed = t.status !== "pending";
              return (
                <div
                  key={t.id}
                  className="task-cal-line"
                  title={`${t.title}（点击编辑）`}
                  onClick={(e) => { e.stopPropagation(); openEdit(t); }}
                >
                  <i className={`task-cal-dot p-${prioOf(t.priority)}${closed ? " is-closed" : ""}`} />
                  <span className={`task-cal-line-text${closed ? " is-closed" : ""}`}>{t.title}</span>
                  {!closed && (
                    <span
                      className="task-cal-check"
                      title="标记完成"
                      onClick={(e) => { e.stopPropagation(); toggleDone(t); }}
                    >
                      <CheckOutlined />
                    </span>
                  )}
                </div>
              );
            })}
            {list.length > CAL_LINE_MAX && (
              <div
                className="task-cal-more"
                title={list.slice(CAL_LINE_MAX).map((t) => t.title).join("、")}
              >
                +{list.length - CAL_LINE_MAX} 项
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const selectedDate = selected ? dayjs(selected) : null;
  const selectedInfo = selected ? dayInfo(selected) : null;
  // selected 为 null 表示正在看「未指定日期」那一组
  const selectedTasks = selected ? byDate[selected] || [] : undated;
  const viewYear = viewMonth.year();
  const missingHoliday = !hasHolidayData(viewYear);

  // 单条待办的渲染（日历右侧列表与「未指定日期」分组共用）
  const renderTask = (t: Task) => (
    <div
      key={t.id}
      className={`task-item${t.overdue ? " is-overdue" : ""}${t.due_today ? " is-today" : ""}${t.status === "done" ? " is-done" : ""}`}
      draggable
      title="拖到左侧日历可改期"
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", t.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={clearDropTarget}
    >
      <Checkbox
        checked={t.status === "done"}
        onChange={() => toggleDone(t)}
        style={{ marginTop: 3 }}
      />
      <div className="task-main">
        <div className="task-title">{t.title}</div>
        <div className="task-meta">
          <span style={{ color: dueColor(t), fontWeight: t.overdue || t.due_today ? 600 : 400 }}>
            <ClockCircleOutlined /> {dueText(t)}
          </span>
          <Tag color={PRIORITY_COLORS[t.priority] || "default"} style={{ marginInlineEnd: 0 }}>
            {PRIORITY_LABELS[t.priority] || t.priority}
          </Tag>
          {t.talent_id && (
            <Link to={`/talents/${t.talent_id}`} style={{ color: "#3b82f6" }}>
              <UserOutlined /> {t.talent_name || "关联人才"}
            </Link>
          )}
          {t.job_title && (
            <span><LinkOutlined /> {t.job_title}</span>
          )}
          {t.status === "cancelled" && <Tag style={{ marginInlineEnd: 0 }}>已取消</Tag>}
          {t.status === "done" && <Tag color="green" style={{ marginInlineEnd: 0 }}>已完成</Tag>}
          <span style={{ color: "#c2c6cc" }}>
            {TASK_SOURCE_LABELS[t.source] || t.source}
            {isAdmin && t.owner_name ? ` · ${t.owner_name}` : ""}
          </span>
        </div>
        {t.content && <div className="task-content">{t.content}</div>}
      </div>
      <div className="task-actions">
        {t.status !== "done" && (
          <Tooltip title="标记完成">
            <Button type="text" size="small" icon={<CheckCircleOutlined />} onClick={() => toggleDone(t)} />
          </Tooltip>
        )}
        <Dropdown
          menu={{ items: moreMenu(t), onClick: ({ key }) => onMoreClick(t, key) }}
          trigger={["click"]}
        >
          <Button type="text" size="small" icon={<MoreOutlined />} />
        </Dropdown>
      </div>
    </div>
  );

  return (
    <div className="tasks-page">
      <div className="tasks-layout">
        {/* ===== 日历 ===== */}
        <Card
          className="task-calendar-card"
          styles={{ body: { padding: "12px 16px 16px" } }}
          title={
            <Button
              className="task-new-btn"
              size="small"
              icon={<PlusOutlined />}
              data-onb-action="new-task"
              onClick={() => openCreate(selected)}
            >
              新建待办
            </Button>
          }
          extra={
            <Space size={12} wrap style={{ fontSize: 12, color: "#8c8c8c" }}>
              <Space size={4}>
                <span className="task-cal-badge is-today">今</span>
                <span className="task-cal-badge is-holiday">休</span>
                <span className="task-cal-badge is-makeup">班</span>
              </Space>
              <Space size={8}>
                <span className="task-legend"><i className="task-cal-dot p-high" />高</span>
                <span className="task-legend"><i className="task-cal-dot p-normal" />中</span>
                <span className="task-legend"><i className="task-cal-dot p-low" />低</span>
              </Space>
            </Space>
          }
        >
          {missingHoliday && (
            <div className="task-cal-tip">
              未内置 {viewYear} 年节假日安排，当前节假日标记仅按周六周日判断
              {knownYears().length > 0 && `（已内置：${knownYears().join("、")} 年）`}
            </div>
          )}
          <div
            className="task-cal-dnd"
            ref={dndRef}
            onDragOver={onCalDragOver}
            onDragLeave={onCalDragLeave}
            onDrop={onCalDrop}
          >
            <Calendar
              className="task-calendar"
              // 非受控：选中态交给组件内部，翻月不会受外部 value 干扰
              defaultValue={dayjs()}
              onSelect={(d, info) => {
                if (info.source !== "date") return;
                const ymd = d.format("YYYY-MM-DD");
                setSelected(ymd);
                // 这天一条待办都没有 → 直接弹「新建待办」并预填该日期（空白格点击即建，少一步）
                if (!(byDate[ymd] || []).length) openCreate(ymd);
              }}
              onPanelChange={(d) => setViewMonth(d.startOf("month"))}
              cellRender={cellRender}
            />
          </div>
        </Card>

        {/* ===== 选中日期的待办 ===== */}
        <Card
          className="task-day-card"
          styles={{ body: { padding: "14px 16px" } }}
          title={
            <Space size={8}>
              <span>
                {selectedDate ? selectedDate.format("M 月 D 日 dddd") : "未指定日期"}
              </span>
              {selected === todayYmd() && <span className="task-cal-badge is-today">今</span>}
              {selectedInfo && (
                <span style={{ fontSize: 12, color: DAY_TYPE_TEXT[selectedInfo.type].color }}>
                  {selectedInfo.type === "holiday"
                    ? `${DAY_TYPE_TEXT.holiday.label} · ${selectedInfo.name}`
                    : DAY_TYPE_TEXT[selectedInfo.type].label}
                </span>
              )}
            </Space>
          }
        >
          {loading ? (
            <div style={{ textAlign: "center", padding: "3rem" }}><Spin /></div>
          ) : selectedTasks.length > 0 ? (
            <div>{selectedTasks.map(renderTask)}</div>
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={selected ? "这一天没有待办" : "没有未指定日期的待办"}
            />
          )}

          {/* 未指定日期的待办：单独一个入口，避免它们无处安放 */}
          {selected !== null && undated.length > 0 && (
            <div className="task-undated">
              <div className="task-undated-head">
                <span>未指定日期 · {undated.length} 项</span>
                <Button type="link" size="small" onClick={() => setSelected(null)}>查看</Button>
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* 新建 / 编辑待办 */}
      <Modal
        title={editing ? "编辑待办" : "新建待办"}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        footer={null}
        width={560}
        destroyOnClose
      >
        <Form form={form} layout="horizontal" className="form-horizontal" labelCol={{ flex: "88px" }} onFinish={handleSubmit}>
          <Form.Item name="title" label="待办事项" rules={[{ required: true, message: "请输入待办内容" }]}>
            <Input placeholder="如：跟进张三维的面试时间确认" />
          </Form.Item>

          <div className="form-grid">
            <Form.Item name="due_date" label="到期日">
              <DatePicker style={{ width: "100%" }} placeholder="不限时可不填" />
            </Form.Item>
            <Form.Item name="priority" label="优先级">
              <Select options={Object.entries(PRIORITY_LABELS).map(([k, v]) => ({ label: v, value: k }))} />
            </Form.Item>

            <Form.Item name="talent_id" label="关联人才">
              <Select
                showSearch allowClear placeholder="可选"
                optionFilterProp="label"
                options={talents.map((t) => ({ label: t.name, value: t.id }))}
              />
            </Form.Item>
            <Form.Item name="job_id" label={termFor(profile, "关联岗位")}>
              <Select
                showSearch allowClear placeholder="可选"
                optionFilterProp="label"
                options={jobs.map((j) => ({ label: j.title, value: j.id }))}
              />
            </Form.Item>
          </div>

          <Form.Item name="content" label="备注">
            <Input.TextArea rows={3} placeholder="补充说明…" />
          </Form.Item>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button onClick={() => setModalOpen(false)}>取消</Button>
            <Button type="primary" htmlType="submit" loading={saving}>
              {editing ? "保存修改" : "创建待办"}
            </Button>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
