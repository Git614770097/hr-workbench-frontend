import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { genId } from "../helpers";
import { ensureOnboardingItems } from "../talentFlow";

const onboarding = new Hono<{ Bindings: Env }>();

const ITEM_STATUS_LABEL: Record<string, string> = {
  pending: "待提交",
  submitted: "已提交",
  verified: "已核验",
};

function decorate(r: any) {
  return { ...r, status_label: ITEM_STATUS_LABEL[r.status] || r.status };
}

/** 入职清单列表（含进度统计） */
onboarding.get("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const conditions: string[] = [];
  const params: string[] = [];
  if (session.role !== "admin") {
    conditions.push("i.owner_id = ?");
    params.push(session.userId);
  }
  const talentId = c.req.query("talent_id");
  if (talentId) { conditions.push("i.talent_id = ?"); params.push(talentId); }
  const talentJobId = c.req.query("talent_job_id");
  if (talentJobId) { conditions.push("i.talent_job_id = ?"); params.push(talentJobId); }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
  const rows = await c.env.DB.prepare(`
    SELECT i.*, t.name as talent_name, j.title as job_title
    FROM onboarding_items i
    JOIN talents t ON i.talent_id = t.id
    LEFT JOIN talent_jobs tj ON tj.id = i.talent_job_id
    LEFT JOIN jobs j ON j.id = tj.job_id
    ${where}
    ORDER BY i.sort_order ASC, i.created_at ASC
  `).bind(...params).all();

  const items = (rows.results || []).map(decorate);
  // 进度：已提交(submitted) + 已核验(verified) 视为完成
  const done = items.filter((r: any) => r.status === "submitted" || r.status === "verified").length;
  return c.json({
    items,
    progress: { total: items.length, done, percent: items.length ? Math.round((done / items.length) * 100) : 0 },
  });
});

/** 一键生成默认材料清单（已存在则不重复生成） */
onboarding.post("/init", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  let b: any;
  try { b = await c.req.json(); } catch { return c.json({ error: "请求参数格式不正确" }, 400); }
  if (!b.talent_id) return c.json({ error: "缺少候选人" }, 400);

  // 已有清单则直接报错（避免一键生成出两套）；实际写入复用 talentFlow 的幂等实现
  const created = await ensureOnboardingItems(c.env.DB, {
    ownerId: session.userId,
    talentId: b.talent_id,
    talentJobId: b.talent_job_id || null,
  });
  if (created === 0) return c.json({ error: "该候选人已生成过材料清单" }, 400);
  return c.json({ ok: true, created });
});

/** 新增单项材料 */
onboarding.post("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  let b: any;
  try { b = await c.req.json(); } catch { return c.json({ error: "请求参数格式不正确" }, 400); }
  if (!b.name || !String(b.name).trim()) return c.json({ error: "请填写材料名称" }, 400);
  if (!b.talent_id) return c.json({ error: "缺少候选人" }, 400);

  const id = genId();
  await c.env.DB.prepare(`
    INSERT INTO onboarding_items (id, owner_id, talent_id, talent_job_id, name, category, required, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, session.userId, b.talent_id, b.talent_job_id || null,
    String(b.name).trim(), b.category || null, b.required === false ? 0 : 1, b.sort_order ?? 99).run();
  return c.json({ ok: true, id });
});

/** 更新材料状态 / 备注 */
onboarding.put("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT owner_id FROM onboarding_items WHERE id = ?").bind(id).first<{ owner_id: string }>();
  if (!row) return c.json({ error: "材料项不存在" }, 404);
  if (row.owner_id !== session.userId && session.role !== "admin") return c.json({ error: "无权操作" }, 403);

  let b: any;
  try { b = await c.req.json(); } catch { return c.json({ error: "请求参数格式不正确" }, 400); }
  await c.env.DB.prepare(`
    UPDATE onboarding_items SET status = ?, remark = ?, required = ?,
      submitted_at = CASE WHEN ? = 'pending' THEN NULL ELSE COALESCE(submitted_at, datetime('now')) END,
      updated_at = datetime('now')
    WHERE id = ?
  `).bind(
    b.status || "pending",
    b.remark ?? null,
    b.required === false ? 0 : 1,
    b.status || "pending",
    id
  ).run();
  return c.json({ ok: true });
});

/** 删除材料项 */
onboarding.delete("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT owner_id FROM onboarding_items WHERE id = ?").bind(id).first<{ owner_id: string }>();
  if (!row) return c.json({ error: "材料项不存在" }, 404);
  if (row.owner_id !== session.userId && session.role !== "admin") return c.json({ error: "无权操作" }, 403);
  await c.env.DB.prepare("DELETE FROM onboarding_items WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

export { onboarding as onboardingRoutes };
