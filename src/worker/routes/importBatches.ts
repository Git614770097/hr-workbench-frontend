// 导入记录：一次「导入简历」会话 = 一个批次，每个上传的文件 = 一条明细。
//
// 为什么需要这套东西（而不是从现有数据推）：
// 导入是纯前端编排的——每份简历单独调一次 /talents/import，解析失败、去重跳过、
// 录入报错这些状态只活在 React state 里，弹窗一关就没了。audit_logs 只记「成功写入」
// 的 talent，既不知道解析失败过几份，也没法把一次上传会话归成一个批次。
// 结果是用户永远答不上「上次那 20 份为什么只进来 13 份」。
//
// 设计取舍：
//  - 表头不冗余存计数，一律从明细 GROUP BY 现算。宁可多一次聚合，也不要
//    「显示录入 13 份但详情里只有 11 行」这种对不上的情况——这种表一旦对不上，
//    用户就再也不信它了。
//  - 明细状态原地 UPDATE，不追加历史版本。导入过程是一次性的，没有回溯中间态的需求。
//  - 可见范围跟随人才库：admin 全量 / 同队 / 仅本人。导入记录里全是候选人姓名，
//    不该跨队可见。

import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { genId } from "../helpers";
import { ownerScope } from "../scope";
import type { SessionInfo } from "./auth";

type Ctx = Context<{ Bindings: Env }>;

export const importBatchRoutes = new Hono<{ Bindings: Env }>();

/** 明细合法状态。前端传错一律落成 failed，不能悄悄变成 pending 骗过统计 */
const ITEM_STATUS = ["pending", "imported", "duplicate", "failed"] as const;
type ItemStatus = (typeof ITEM_STATUS)[number];

const normStatus = (v: unknown): ItemStatus =>
  (ITEM_STATUS as readonly string[]).includes(String(v)) ? (String(v) as ItemStatus) : "failed";

/** 单次最多提交多少条明细：一次导入几十份是常态，但别让它成为写放大入口 */
const MAX_ITEMS_PER_POST = 200;

/** 导入记录保留天数，与审计日志一致（180 天）。合规追溯一般要 6 个月 */
const RETENTION_DAYS = 180;

/**
 * 清理超期导入记录。
 *
 * ⚠️ 边界用 SQLite 的 `datetime('now','-180 days')` 算，不要用 JS 的 toISOString()：
 * 写入走的是 `datetime('now')`（`YYYY-MM-DD HH:MM:SS`，空格分隔），ISO 串是
 * `YYYY-MM-DDTHH:MM:SS.sssZ`，字符串比较里 `'2026-10-27T…' > '2026-10-27 …'`，
 * 混用会把「今天」的数据判成超期（audit_logs 那边踩过同样的坑）。
 *
 * 分三步且每步都有界：明细可能远多于批次，单条 DELETE 撞上 D1 的执行限制会整批失败；
 * 最后再做一次孤儿清扫，覆盖「明细没删完但批次已删」的中间态，跑几次就收敛。
 */
export async function purgeOldImportBatches(env: Env): Promise<void> {
  const expired = `SELECT id FROM import_batches WHERE started_at < datetime('now','-${RETENTION_DAYS} days')`;
  try {
    // 1. 分批删明细（每批 2000 行，最多 10 批）
    for (let i = 0; i < 10; i++) {
      const r = await env.DB.prepare(
        `DELETE FROM import_batch_items WHERE rowid IN (
           SELECT rowid FROM import_batch_items WHERE batch_id IN (${expired}) LIMIT 2000)`
      ).run();
      if (!(r.meta?.changes ?? 0)) break;
    }
    // 2. 删批次表头
    await env.DB.prepare(`DELETE FROM import_batches WHERE started_at < datetime('now','-${RETENTION_DAYS} days')`).run();
    // 3. 孤儿明细清扫（明细未删完但表头已删的中间态）
    await env.DB.prepare(
      "DELETE FROM import_batch_items WHERE batch_id NOT IN (SELECT id FROM import_batches)"
    ).run();
  } catch {
    /* 清理失败不影响定时任务的其他工作，下次再跑 */
  }
}

/** 批次行（SELECT * 的真实形状，loadOwnedBatch 用它给返回值兜住类型） */
interface BatchRow {
  id: string;
  user_id: string;
  user_name: string | null;
  source: string | null;
  dedup: number;
  started_at: string;
  finished_at: string | null;
}

/**
 * 校验批次归属：只有本会话可见范围内的批次才能读写。
 * 用 SELECT * 而非只取 id，是因为详情接口要把表头原样返回，少查一次。
 */
async function loadOwnedBatch(c: Ctx, session: SessionInfo, id: string): Promise<BatchRow | null> {
  const sc = ownerScope(session, "user_id");
  return await c.env.DB.prepare(`SELECT * FROM import_batches WHERE id = ?${sc.sql}`)
    .bind(id, ...sc.params)
    .first<BatchRow>();
}

// ---- 建批次 ----
// 在用户第一次选中文件时调用（不是打开弹窗时），避免留下一堆 0 份的空批次。
importBatchRoutes.post("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const body = await c.req
    .json<{ source?: string | null; dedup?: boolean }>()
    .catch(() => ({} as { source?: string | null; dedup?: boolean }));
  const id = genId();
  await c.env.DB.prepare(
    "INSERT INTO import_batches (id, user_id, user_name, source, dedup) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(id, session.userId, session.name ?? null, body.source || null, body.dedup === false ? 0 : 1)
    .run();
  return c.json({ id });
});

// ---- 批量写明细（解析完成后一次性提交本批全部文件）----
// 返回的 ids 与提交顺序严格一一对应：文件名可能重复，只有下标能可靠映射回前端记录。
importBatchRoutes.post("/:id/items", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const batch = await loadOwnedBatch(c, session, c.req.param("id"));
  if (!batch) return c.json({ error: "导入记录不存在" }, 404);
  if (batch.finished_at) return c.json({ error: "该批次已结束" }, 409);

  const items = await c.req.json<any[]>().catch(() => null);
  if (!Array.isArray(items) || items.length === 0) return c.json({ error: "没有可记录的明细" }, 400);
  if (items.length > MAX_ITEMS_PER_POST) return c.json({ error: `单次最多 ${MAX_ITEMS_PER_POST} 份` }, 400);

  const ids: string[] = [];
  const stmts = items.map((it) => {
    const id = genId();
    ids.push(id);
    return c.env.DB.prepare(
      `INSERT INTO import_batch_items
         (id, batch_id, file_name, file_size, talent_name, status, error, parse_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      batch.id,
      String(it?.file_name || "").slice(0, 260) || null,
      Number.isFinite(it?.file_size) ? Number(it.file_size) : null,
      String(it?.talent_name || "").slice(0, 100) || null,
      normStatus(it?.status),
      String(it?.error || "").slice(0, 500) || null,
      it?.parse_source === "ai" || it?.parse_source === "local" ? it.parse_source : null
    );
  });
  await c.env.DB.batch(stmts);
  return c.json({ ids });
});

// ---- 更新单份明细（录入成功 / 判重跳过 / 录入报错 时各调一次）----
// 故意做成逐份而非批量：录入本身就是逐份的，一份一落盘意味着浏览器中途崩溃时
// 已经处理完的那几份记录不会丢——而这正是「导入记录」存在的意义。
importBatchRoutes.patch("/:id/items/:itemId", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const batch = await loadOwnedBatch(c, session, c.req.param("id"));
  if (!batch) return c.json({ error: "导入记录不存在" }, 404);

  const body = await c.req.json<any>().catch(() => ({}));
  const sets: string[] = [];
  const params: (string | null)[] = [];
  if (body.status !== undefined) {
    sets.push("status = ?");
    params.push(normStatus(body.status));
  }
  if (body.talent_id !== undefined) {
    sets.push("talent_id = ?");
    params.push(body.talent_id ? String(body.talent_id) : null);
  }
  if (body.talent_name !== undefined) {
    sets.push("talent_name = ?");
    params.push(String(body.talent_name || "").slice(0, 100) || null);
  }
  if (body.error !== undefined) {
    sets.push("error = ?");
    params.push(String(body.error || "").slice(0, 500) || null);
  }
  if (sets.length === 0) return c.json({ ok: true });

  // updated_at 用 NULLIF 区分：这里每次都是显式变更，直接写 now 即可
  await c.env.DB.prepare(
    `UPDATE import_batch_items SET ${sets.join(", ")}, updated_at = datetime('now')
     WHERE id = ? AND batch_id = ?`
  )
    .bind(...params, c.req.param("itemId"), batch.id)
    .run();
  return c.json({ ok: true });
});

// ---- 结束批次 ----
importBatchRoutes.post("/:id/finish", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const batch = await loadOwnedBatch(c, session, c.req.param("id"));
  if (!batch) return c.json({ error: "导入记录不存在" }, 404);

  // 幂等：重复调用不覆盖首次结束时间
  if (!batch.finished_at) {
    await c.env.DB.prepare("UPDATE import_batches SET finished_at = datetime('now') WHERE id = ?")
      .bind(batch.id)
      .run();
  }
  return c.json({ ok: true });
});

// ---- 批次列表（带现算的四态计数）----
importBatchRoutes.get("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 20));
  const sc = ownerScope(session, "b.user_id");

  // 两个独立查询，一次 batch 往返（D1 铁律：无依赖查询不要逐条 await）
  //
  // 0 份明细的批次不列出来：它只在「批次建好了但明细没写进去」这种半途而废的情况下
  // 才会存在，对用户是纯噪音（「上传 0 份」看起来像 bug），也查不到任何东西。
  // 内连接 + EXISTS 自动把它们排除，两个查询口径保持一致，total 不会与列表对不上。
  const [countRes, listRes] = await c.env.DB.batch<any>([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM import_batches b
        WHERE EXISTS (SELECT 1 FROM import_batch_items i WHERE i.batch_id = b.id)${sc.sql}`
    ).bind(...sc.params),
    c.env.DB.prepare(
      `SELECT b.id, b.user_name, b.source, b.dedup, b.started_at, b.finished_at,
              COUNT(i.id) AS total,
              COALESCE(SUM(CASE WHEN i.status = 'imported'  THEN 1 ELSE 0 END), 0) AS imported,
              COALESCE(SUM(CASE WHEN i.status = 'duplicate' THEN 1 ELSE 0 END), 0) AS duplicate,
              COALESCE(SUM(CASE WHEN i.status = 'failed'    THEN 1 ELSE 0 END), 0) AS failed,
              COALESCE(SUM(CASE WHEN i.status = 'pending'   THEN 1 ELSE 0 END), 0) AS pending
         FROM import_batches b
         JOIN import_batch_items i ON i.batch_id = b.id
        WHERE 1=1${sc.sql}
        GROUP BY b.id
        ORDER BY b.started_at DESC
        LIMIT ? OFFSET ?`
    ).bind(...sc.params, limit, (page - 1) * limit),
  ]);

  const total = Number(countRes.results?.[0]?.n ?? 0);
  return c.json({
    items: listRes.results ?? [],
    total,
    page,
    limit,
  });
});

// ---- 批次详情（逐份明细）----
importBatchRoutes.get("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const batch = await loadOwnedBatch(c, session, c.req.param("id"));
  if (!batch) return c.json({ error: "导入记录不存在" }, 404);

  // LEFT JOIN talents 判断人才是否还在：被删了就不给前端链接，避免点进去 404
  const res = await c.env.DB.prepare(
    `SELECT i.id, i.file_name, i.file_size, i.talent_id, i.talent_name,
            i.status, i.error, i.parse_source, i.created_at, i.updated_at,
            CASE WHEN t.id IS NULL THEN 0 ELSE 1 END AS talent_alive
       FROM import_batch_items i
       LEFT JOIN talents t ON t.id = i.talent_id
      WHERE i.batch_id = ?
      ORDER BY i.created_at ASC, i.rowid ASC`
  )
    .bind(batch.id)
    .all();

  const items = (res.results ?? []) as any[];
  const count = (s: string) => items.filter((r) => r.status === s).length;
  return c.json({
    batch: {
      ...batch,
      total: items.length,
      imported: count("imported"),
      duplicate: count("duplicate"),
      failed: count("failed"),
      pending: count("pending"),
    },
    items,
  });
});

export default importBatchRoutes;
