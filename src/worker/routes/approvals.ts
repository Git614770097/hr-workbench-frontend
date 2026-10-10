import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { genId } from "../helpers";
import { moveStageForward, ensureOnboardingItems } from "../talentFlow";

const approvals = new Hono<{ Bindings: Env }>();

const INSTANCE_STATUS_LABEL: Record<string, string> = {
  pending: "审批中",
  approved: "已通过",
  rejected: "已驳回",
  cancelled: "已取消",
};

function todayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

interface Step { name: string; approver_id?: string }

function parseSteps(raw: string | null | undefined): Step[] {
  try {
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr.filter((s) => s && typeof s.name === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 审批通过后的下游动作 —— 这是整条招聘链路的接缝。
 * 之前审批通过只是把实例状态改成 approved，看板、入职办理都不会有任何反应，
 * 链路到这里就断了，HR 还得手工再做一遍。
 *
 *   scene = offer  → 投递自动推进到「已入职」；连带生成试用期跟进待办 + 入职材料清单
 *                    （入职日期取发起审批时填的 entry_date，没填则由 syncTalentStage 兜底为当天）
 *   scene = onboard → 直接生成入职材料清单
 */
async function runApprovalDownstream(
  env: Env,
  inst: { scene: string; talent_id: string; talent_job_id: string | null; payload: string | null },
  userId: string
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { downstream: [] as string[] };
  const notes = result.downstream as string[];

  try {
    if (inst.scene === "offer" && inst.talent_job_id) {
      let hireDate: string | null = null;
      try {
        const p = JSON.parse(inst.payload || "{}") as { entry_date?: string };
        if (p.entry_date && /^\d{4}-\d{2}-\d{2}$/.test(p.entry_date)) hireDate = p.entry_date;
      } catch { /* payload 非 JSON 时忽略 */ }

      const mv = await moveStageForward(env.DB, {
        linkId: inst.talent_job_id,
        toStage: "hired",
        userId,
        remark: "Offer 审批通过，系统自动流转到已入职",
        hireDate,
      });
      if (mv.moved) notes.push("已自动流转到「已入职」");
      else if (mv.reason === "no_forward") notes.push("投递已在更靠后阶段，未改动");
      else if (mv.reason === "not_found") notes.push("投递不存在，未能自动流转");

      // moveStageForward 内部已幂等生成清单；这里兜住「阶段已是最新、没走进搬迁分支」的情况
      const created = await ensureOnboardingItems(env.DB, {
        ownerId: userId, talentId: inst.talent_id, talentJobId: inst.talent_job_id,
      });
      if (created > 0) notes.push(`已生成入职材料清单 ${created} 项`);
    } else if (inst.scene === "onboard") {
      const created = await ensureOnboardingItems(env.DB, {
        ownerId: userId, talentId: inst.talent_id, talentJobId: inst.talent_job_id,
      });
      if (created > 0) notes.push(`已生成入职材料清单 ${created} 项`);
    }
  } catch (e) {
    // 下游联动失败不能把审批结果回滚掉——审批本身已经落库通过，
    // 这里只回报提示，由 HR 到对应页面手工补一步。
    notes.push(`下游联动未完成：${(e as Error).message}`);
  }

  return result;
}

// ============ 流程模板（可自建）============

/** 流程模板列表 */
approvals.get("/flows", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const rows = await c.env.DB.prepare(
    "SELECT * FROM approval_flows WHERE owner_id = ? ORDER BY created_at DESC"
  ).bind(session.userId).all();
  return c.json({
    items: (rows.results || []).map((r: any) => ({ ...r, steps: parseSteps(r.flow_steps) })),
  });
});

/** 新建流程模板 */
approvals.post("/flows", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  let b: any;
  try { b = await c.req.json(); } catch { return c.json({ error: "请求参数格式不正确" }, 400); }

  const name = String(b.name || "").trim();
  const steps = parseSteps(JSON.stringify(b.steps || []));
  if (!name) return c.json({ error: "请填写流程名称" }, 400);
  if (steps.length === 0) return c.json({ error: "至少配置一个审批步骤" }, 400);

  const id = genId();
  await c.env.DB.prepare(
    "INSERT INTO approval_flows (id, owner_id, name, scene, flow_steps, enabled) VALUES (?, ?, ?, ?, ?, 1)"
  ).bind(id, session.userId, name, b.scene || "offer", JSON.stringify(steps)).run();
  return c.json({ ok: true, id });
});

/** 删除流程模板（仅自己创建的；不影响已发起的实例） */
approvals.delete("/flows/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT owner_id FROM approval_flows WHERE id = ?").bind(id).first<{ owner_id: string }>();
  if (!row) return c.json({ error: "流程不存在" }, 404);
  // admin 可管理全部流程模板，普通用户仅能删自己创建的
  if (session.role !== "admin" && row.owner_id !== session.userId) return c.json({ error: "无权删除该流程" }, 403);
  await c.env.DB.prepare("DELETE FROM approval_flows WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ============ 审批实例 ============

/** 发起审批：按所选流程逐步推进 */
approvals.post("/instances", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  let b: any;
  try { b = await c.req.json(); } catch { return c.json({ error: "请求参数格式不正确" }, 400); }

  if (!b.talent_job_id) return c.json({ error: "缺少投递信息" }, 400);

  const link = await c.env.DB.prepare(`
    SELECT tj.id, tj.talent_id, tj.stage, t.name as talent_name, t.owner_id, j.title as job_title
    FROM talent_jobs tj
    JOIN talents t ON tj.talent_id = t.id
    LEFT JOIN jobs j ON tj.job_id = j.id
    WHERE tj.id = ?
  `).bind(b.talent_job_id).first<any>();
  if (!link) return c.json({ error: "投递不存在" }, 404);
  // admin 可为任意候选人发起审批，普通用户仅限自己的候选人
  if (session.role !== "admin" && link.owner_id !== session.userId) return c.json({ error: "无权对该候选人发起审批" }, 403);

  // 同一投递同一场景进行中只允许一个实例，避免重复发起
  const dup = await c.env.DB.prepare(
    "SELECT id FROM approval_instances WHERE talent_job_id = ? AND scene = ? AND status = 'pending'"
  ).bind(b.talent_job_id, b.scene || "offer").first();
  if (dup) return c.json({ error: "该候选人已有进行中的同类审批，请先处理完" }, 400);

  // 取流程步骤：指定 flow_id 则用该流程，否则用该场景下第一个启用的流程；都没有则默认一步
  let steps: Step[] = [];
  if (b.flow_id) {
    const f = await c.env.DB.prepare("SELECT flow_steps FROM approval_flows WHERE id = ? AND owner_id = ?")
      .bind(b.flow_id, session.userId).first<{ flow_steps: string }>();
    if (!f) return c.json({ error: "审批流程不存在" }, 404);
    steps = parseSteps(f.flow_steps);
  } else {
    const f = await c.env.DB.prepare(
      "SELECT flow_steps FROM approval_flows WHERE owner_id = ? AND scene = ? AND enabled = 1 ORDER BY created_at DESC LIMIT 1"
    ).bind(session.userId, b.scene || "offer").first<{ flow_steps: string }>();
    steps = f ? parseSteps(f.flow_steps) : [{ name: "审批" }];
  }

  const id = genId();
  const title = String(b.title || "").trim() || `${link.talent_name} · ${link.job_title || "候选人"}`;
  await c.env.DB.prepare(`
    INSERT INTO approval_instances (id, owner_id, flow_id, scene, talent_id, talent_job_id, title, current_step, status, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?)
  `).bind(id, session.userId, b.flow_id || null, b.scene || "offer", link.talent_id, link.talent_job_id, title,
    b.payload ? JSON.stringify(b.payload) : null).run();

  // 落第一步的待处理记录
  await c.env.DB.prepare(
    "INSERT INTO approval_steps (id, instance_id, step_index, step_name, approver_id) VALUES (?, ?, 0, ?, ?)"
  ).bind(genId(), id, steps[0].name, steps[0].approver_id || null).run();

  return c.json({ ok: true, id, total_steps: steps.length });
});

/** 审批列表：pending_only=1 只看待我处理 */
approvals.get("/instances", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const conditions: string[] = [];
  const params: string[] = [];
  if (session.role !== "admin") {
    conditions.push("i.owner_id = ?");
    params.push(session.userId);
  }
  if (c.req.query("status")) { conditions.push("i.status = ?"); params.push(c.req.query("status")!); }
  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  const rows = await c.env.DB.prepare(`
    SELECT i.*, t.name as talent_name, t.phone as talent_phone,
           j.title as job_title, u.name as owner_name
    FROM approval_instances i
    JOIN talents t ON i.talent_id = t.id
    LEFT JOIN talent_jobs tj ON tj.id = i.talent_job_id
    LEFT JOIN jobs j ON j.id = tj.job_id
    LEFT JOIN users u ON i.owner_id = u.id
    ${where}
    ORDER BY (i.status='pending') DESC, i.created_at DESC
  `).bind(...params).all();

  // 取每个实例的步骤明细
  const items = [];
  for (const r of rows.results as any[]) {
    const steps = await c.env.DB.prepare(
      "SELECT * FROM approval_steps WHERE instance_id = ? ORDER BY step_index ASC"
    ).bind(r.id).all();
    items.push({
      ...r,
      steps: steps.results || [],
      status_label: INSTANCE_STATUS_LABEL[r.status] || r.status,
    });
  }
  return c.json({ items });
});

/** 处理某一步：通过 / 驳回 */
approvals.post("/instances/:id/decide", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  const inst = await c.env.DB.prepare("SELECT * FROM approval_instances WHERE id = ?").bind(id).first<any>();
  if (!inst) return c.json({ error: "审批不存在" }, 404);
  // admin 可处理任何人的；普通用户仅能处理自己发起的
  if (session.role !== "admin" && inst.owner_id !== session.userId) {
    return c.json({ error: "无权处理该审批" }, 403);
  }
  if (inst.status !== "pending") return c.json({ error: "该审批已结束" }, 400);

  let b: any;
  try { b = await c.req.json(); } catch { return c.json({ error: "请求参数格式不正确" }, 400); }
  const decision = b.decision === "approve" ? "approve" : b.decision === "reject" ? "reject" : null;
  if (!decision) return c.json({ error: "请选择通过或驳回" }, 400);

  // 记录当前步骤的处理结果
  await c.env.DB.prepare(`
    UPDATE approval_steps SET decision = ?, comment = ?, acted_at = datetime('now')
    WHERE instance_id = ? AND step_index = ? AND decision IS NULL
  `).bind(decision, b.comment || null, id, inst.current_step).run();

  if (decision === "reject") {
    await c.env.DB.prepare(
      "UPDATE approval_instances SET status='rejected', updated_at=datetime('now') WHERE id=?"
    ).bind(id).run();
    return c.json({ ok: true, status: "rejected" });
  }

  // 通过：看还有没有下一步
  const next = await c.env.DB.prepare(
    "SELECT COUNT(*) as n FROM approval_steps WHERE instance_id = ?"
  ).bind(id).first<{ n: number }>();
  const totalSteps = next?.n ?? 1;
  const nextIndex = inst.current_step + 1;

  if (nextIndex < totalSteps) {
    await c.env.DB.prepare(
      "UPDATE approval_instances SET current_step = ?, updated_at=datetime('now') WHERE id=?"
    ).bind(nextIndex, id).run();
    // 取下一步骤名（来自流程模板或兜底）
    const flow = inst.flow_id
      ? await c.env.DB.prepare("SELECT flow_steps FROM approval_flows WHERE id = ?").bind(inst.flow_id).first<{ flow_steps: string }>()
      : null;
    const steps = parseSteps(flow?.flow_steps);
    await c.env.DB.prepare(
      "INSERT INTO approval_steps (id, instance_id, step_index, step_name, approver_id) VALUES (?, ?, ?, ?, ?)"
    ).bind(genId(), id, nextIndex, steps[nextIndex]?.name || "审批", steps[nextIndex]?.approver_id || null).run();
    return c.json({ ok: true, status: "pending", step: nextIndex + 1, total: totalSteps });
  }

  // 最后一步通过 → 整个流程通过
  await c.env.DB.prepare(
    "UPDATE approval_instances SET status='approved', updated_at=datetime('now') WHERE id=?"
  ).bind(id).run();

  // 通过后自动往下走：推阶段 / 生成入职材料清单（失败不回滚审批结果）
  const downstream = await runApprovalDownstream(c.env, inst, session.userId);
  return c.json({ ok: true, status: "approved", ...downstream });
});

/** 取消我发起的审批 */
approvals.post("/instances/:id/cancel", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  const inst = await c.env.DB.prepare("SELECT owner_id, status FROM approval_instances WHERE id = ?").bind(id).first<any>();
  if (!inst) return c.json({ error: "审批不存在" }, 404);
  // admin 可取消任意审批，普通用户仅限自己发起的
  if (session.role !== "admin" && inst.owner_id !== session.userId) return c.json({ error: "无权取消该审批" }, 403);
  if (inst.status !== "pending") return c.json({ error: "该审批已结束" }, 400);
  await c.env.DB.prepare(
    "UPDATE approval_instances SET status='cancelled', updated_at=datetime('now') WHERE id=?"
  ).bind(id).run();
  return c.json({ ok: true });
});

export { approvals as approvalRoutes };
