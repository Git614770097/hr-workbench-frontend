import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { genId } from "../helpers";
import { writeAudit } from "../audit";

/**
 * 使用日志（上报明细）—— 上报 + 查询。
 *
 * 两个入口的权限刻意不同：
 * - `POST /report`：**任何已登录用户**都要上报（否则只统计到管理员就失真了），
 *   所以不走 index.ts 的 menuGuard，仅校验会话。前端用 sendBeacon 发送，
 *   同源请求自动带 httpOnly 的 token cookie。
 * - `GET /events`：仅管理员，照 roles.ts 的 requireAdmin 写法。
 *
 * 写入策略：前端已按 30 秒窗口在本地合并计数，这里收到的是增量，
 * 直接 UPSERT 聚合表（同时按批次落一条明细）。**不要**改成逐次写，会放大写入计费。
 * 2026-10-24 精简后聚合表 usage_daily 暂无读方（原 /overview 已删），继续写入是留底，
 * 万一以后恢复趋势统计还有历史数据；明细表 usage_events 是日志管理页的数据源。
 */

// 合法菜单白名单：与前端 src/usageMeta.ts 的 MENU_LABELS 同步。
// 不在表内的上报一律丢弃，避免有人往库里灌垃圾 key。
const USAGE_MENUS = [
  "tasks", "jobs", "pipeline", "interviews", "funnel", "talents", "profiles", "match",
  "contracts", "social", "templates", "roles", "users", "settings", "logs", "help", "team",
] as const;

const MAX_EVENTS_PER_REPORT = 50;
const MAX_VIEWS_PER_EVENT = 10_000;
const MAX_DWELL_MS = 10 * 60_000;

const p2 = (n: number) => String(n).padStart(2, "0");

/** 归日按 UTC+8（业务全在国内），offsetDays 用于取历史某天 */
export function cnDay(offsetDays = 0): string {
  const d = new Date(Date.now() + 8 * 3600_000 + offsetDays * 86_400_000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/** 明细表保留天数（滚动清理，见 purgeOldUsage） */
const RETENTION_DAYS = 30;

/** 清理超期明细。聚合表不动（留底：/overview 删除后暂无读方，保留历史以备恢复统计）。 */
export async function purgeOldUsage(env: Env): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM usage_events WHERE day < ?").bind(cnDay(-RETENTION_DAYS)).run();
  } catch {
    /* 清理失败不影响定时任务的其他工作 */
  }
}

const logs = new Hono<{ Bindings: Env }>();

/**
 * 前端错误上报（**无需登录**）：渲染崩溃 / 未捕获异常统一落 audit_logs（action=client_error），
 * 管理员在「日志管理 → 操作审计」可见。允许匿名是刻意的——登录页白屏正是最需要留痕的场景。
 * 字段长度已在前端截断，这里再截一次防伪造超长串灌表。
 */
logs.post("/client-error", async (c) => {
  let body: { message?: string; stack?: string; component_stack?: string; url?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求参数格式不正确" }, 400);
  }
  const message = (body.message || "").trim().slice(0, 300);
  if (!message) return c.json({ error: "message 必填" }, 400);
  const session = await getSession(c); // 可能为 null（未登录），writeAudit 兼容
  await writeAudit(c.env, session, {
    action: "client_error",
    targetType: "system",
    targetName: message.slice(0, 100),
    detail: {
      stack: (body.stack || "").slice(0, 2000),
      component_stack: (body.component_stack || "").slice(0, 2000),
      url: (body.url || "").slice(0, 200),
    },
    ip: c.req.header("cf-connecting-ip") || "",
    ua: (c.req.header("user-agent") || "").slice(0, 200),
  });
  return c.json({ ok: true });
});

async function requireAdmin(c: any) {
  const session = await getSession(c);
  if (!session) return { error: "未登录", status: 401 };
  if (session.role !== "admin") return { error: "无权限，仅管理员可操作", status: 403 };
  return { session };
}

// ---- 上报（任意登录用户）----
logs.post("/report", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  let body: { platform?: string; events?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "请求参数格式不正确" }, 400);
  }
  if (!Array.isArray(body.events)) return c.json({ error: "events 需为数组" }, 400);

  const platform = body.platform === "mobile" ? "mobile" : "desktop";
  const day = cnDay();
  const ts = new Date().toISOString();

  const daily: D1PreparedStatement[] = [];
  const details: D1PreparedStatement[] = [];

  for (const raw of body.events.slice(0, MAX_EVENTS_PER_REPORT)) {
    const e = raw as { menu?: unknown; views?: unknown; dwell_ms?: unknown };
    const menu = String(e.menu || "");
    if (!(USAGE_MENUS as readonly string[]).includes(menu)) continue;

    const views = Math.max(0, Math.min(Math.round(Number(e.views) || 0), MAX_VIEWS_PER_EVENT));
    const dwell = Math.max(0, Math.min(Math.round(Number(e.dwell_ms) || 0), MAX_DWELL_MS));
    if (!views && dwell < 1000) continue;

    daily.push(
      c.env.DB.prepare(
        `INSERT INTO usage_daily (day, menu, user_id, views, actions, dwell_ms, last_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(day, menu, user_id) DO UPDATE SET
           views = views + excluded.views,
           dwell_ms = dwell_ms + excluded.dwell_ms,
           last_at = excluded.last_at`
      ).bind(day, menu, session.userId, views, dwell, ts)
    );

    // 明细只记「有访问」的批次，纯停留心跳不落行（否则行数被心跳撑大）
    if (views > 0) {
      details.push(
        c.env.DB.prepare(
          `INSERT INTO usage_events (id, ts, day, user_id, role, menu, action, detail, platform)
           VALUES (?, ?, ?, ?, ?, ?, 'view', ?, ?)`
        ).bind(genId(), ts, day, session.userId, session.role, menu, JSON.stringify({ views, dwell_ms: dwell }), platform)
      );
    }
  }

  if (daily.length) {
    try {
      await c.env.DB.batch(daily);
      if (details.length) await c.env.DB.batch(details);
    } catch {
      // 埋点写入失败不能影响用户——前端本来就忽略响应
      return c.json({ ok: false }, 200);
    }
  }
  return c.json({ ok: true, recorded: daily.length }, 200);
});

// ---- 明细（审计用，分页）----
logs.get("/events", async (c) => {
  const admin = await requireAdmin(c);
  if ("error" in admin) return c.json({ error: admin.error }, admin.status as any);

  const days = Math.min(Math.max(Number(c.req.query("days")) || 7, 1), 30);
  const menu = c.req.query("menu") || "";
  const userId = c.req.query("user_id") || "";
  const page = Math.max(Number(c.req.query("page")) || 1, 1);
  const pageSize = Math.min(Math.max(Number(c.req.query("page_size")) || 20, 1), 100);

  const where: string[] = ["e.day BETWEEN ? AND ?"];
  const params: (string | number)[] = [cnDay(-(days - 1)), cnDay()];
  if (menu) { where.push("e.menu = ?"); params.push(menu); }
  if (userId) { where.push("e.user_id = ?"); params.push(userId); }
  const whereSql = where.join(" AND ");

  const [countRes, listRes] = await c.env.DB.batch<any>([
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM usage_events e WHERE ${whereSql}`).bind(...params),
    c.env.DB.prepare(
      `SELECT e.id, e.ts, e.menu, e.action, e.detail, e.platform, e.user_id, u.name AS user_name, u.role
       FROM usage_events e LEFT JOIN users u ON u.id = e.user_id
       WHERE ${whereSql} ORDER BY e.ts DESC LIMIT ? OFFSET ?`
    ).bind(...params, pageSize, (page - 1) * pageSize),
  ]);

  return c.json({
    total: Number(countRes.results?.[0]?.total) || 0,
    page,
    page_size: pageSize,
    items: (listRes.results || []).map((r: any) => ({
      id: r.id,
      ts: r.ts,
      menu: r.menu,
      action: r.action,
      detail: r.detail,
      platform: r.platform,
      user_id: r.user_id,
      user_name: r.user_name || "已删除用户",
      role: r.role,
    })),
  });
});

export default logs;
