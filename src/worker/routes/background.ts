import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../index";
import { getSession } from "./auth";
import type { SessionInfo } from "./auth";
import { scopeConds, scopeParams, canTouch } from "../scope";
import { genId, arrayBufferToBase64, base64ToArrayBuffer } from "../helpers";
import { writeAudit } from "../audit";
import { moveStageForward } from "../talentFlow";
import { LEFT_JOIN_JOB_J } from "../sqlFragments";
import { deepseekJsonWithUsage } from "../ai";
import { resolveAiKey } from "../aiKey";
import { checkQuota } from "../aiGuard";

const background = new Hono<{ Bindings: Env }>();

// ============ 常量与标签 ============

export const BG_STATUS = ["pending", "processing", "completed", "passed", "failed", "cancelled"] as const;
export const BG_CONSENT = ["none", "requested", "granted", "declined"] as const;
const ITEM_STATUS = ["pending", "pass", "fail"] as const;

export const BG_STATUS_LABEL: Record<string, string> = {
  pending: "待发起",
  processing: "核验中",
  completed: "已出报告",
  passed: "已通过",
  failed: "未通过",
  cancelled: "已取消",
};

export const BG_CONSENT_LABEL: Record<string, string> = {
  none: "未授权",
  requested: "已发授权请求",
  granted: "已授权",
  declined: "候选人拒绝",
};

export const ITEM_STATUS_LABEL: Record<string, string> = {
  pending: "待核验",
  pass: "一致",
  fail: "异常",
};

/** 默认核验项（最小必要原则：身份 / 学历 / 工作履历 / 竞业限制） */
const DEFAULT_ITEMS: BgItem[] = [
  { type: "identity", label: "身份核验", status: "pending", note: "" },
  { type: "education", label: "学历核验", status: "pending", note: "" },
  { type: "employment", label: "工作履历核验", status: "pending", note: "" },
  { type: "noncompete", label: "竞业限制核查", status: "pending", note: "" },
];

/** 高敏项（犯罪记录 / 征信）：仅在 high_risk=1 时加入，授权需二次明示确认 */
const HIGH_RISK_ITEMS: BgItem[] = [
  { type: "criminal", label: "犯罪记录核查", status: "pending", note: "" },
  { type: "credit", label: "征信核查", status: "pending", note: "" },
];

interface BgItem {
  type: string;
  label: string;
  status: string;
  note: string;
}

function parseItems(raw: string | null | undefined): BgItem[] {
  try {
    const arr = JSON.parse(raw || "[]");
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => x && typeof x.type === "string" && typeof x.label === "string")
      .map((x) => ({
        type: x.type,
        label: x.label,
        status: ITEM_STATUS.includes(x.status) ? x.status : "pending",
        note: typeof x.note === "string" ? x.note : "",
      }));
  } catch {
    return [];
  }
}

function todayCn(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

// ============ 行加载与权限 ============

interface BgRow {
  id: string;
  owner_id: string;
  talent_id: string;
  talent_job_id: string | null;
  status: string;
  consent_status: string;
  consent_at: string | null;
  consent_method: string | null;
  provider: string;
  high_risk: number;
  items_json: string | null;
  report_kv_key: string | null;
  report_name: string | null;
  summary: string | null;
  result: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  talent_name: string;
  talent_phone: string | null;
  job_title: string | null;
  owner_name: string;
}

/** 取一行背调 + 关联人才/岗位名（用于列表与详情） */
async function loadBg(env: Env, id: string): Promise<BgRow | null> {
  return env.DB.prepare(`
    SELECT bc.*, t.name as talent_name, t.phone as talent_phone,
           j.title as job_title, u.name as owner_name
    FROM background_checks bc
    JOIN talents t ON bc.talent_id = t.id
    LEFT JOIN talent_jobs tj ON bc.talent_job_id = tj.id
    ${LEFT_JOIN_JOB_J}
    LEFT JOIN users u ON bc.owner_id = u.id
    WHERE bc.id = ?
  `).bind(id).first<BgRow>();
}

/** 把 DB 行转成前端友好的详情对象（含解析后的 items） */
function toDetail(r: BgRow) {
  return {
    ...r,
    high_risk: !!r.high_risk,
    has_report: !!r.report_kv_key,
    items: parseItems(r.items_json),
    status_label: BG_STATUS_LABEL[r.status] || r.status,
    consent_label: BG_CONSENT_LABEL[r.consent_status] || r.consent_status,
  };
}

// ============ 列表 ============
background.get("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const conditions: string[] = [];
  const params: string[] = [];
  conditions.push(...scopeConds(session, "bc.owner_id"));
  params.push(...scopeParams(session));

  const status = c.req.query("status");
  if (status && BG_STATUS.includes(status as any)) {
    conditions.push("bc.status = ?");
    params.push(status);
  }
  const consent = c.req.query("consent");
  if (consent && BG_CONSENT.includes(consent as any)) {
    conditions.push("bc.consent_status = ?");
    params.push(consent);
  }
  const talentId = c.req.query("talent_id");
  if (talentId) {
    conditions.push("bc.talent_id = ?");
    params.push(talentId);
  }
  const q = (c.req.query("q") || "").trim();
  if (q) {
    conditions.push("(t.name LIKE ? OR j.title LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
  const rows = await c.env.DB.prepare(`
    SELECT bc.*, t.name as talent_name, t.phone as talent_phone,
           j.title as job_title, u.name as owner_name
    FROM background_checks bc
    JOIN talents t ON bc.talent_id = t.id
    LEFT JOIN talent_jobs tj ON bc.talent_job_id = tj.id
    ${LEFT_JOIN_JOB_J}
    LEFT JOIN users u ON bc.owner_id = u.id
    ${where}
    ORDER BY (bc.status IN ('pending','processing','completed')) DESC, bc.created_at DESC
  `).bind(...params).all<BgRow>();

  const items = (rows.results || []).map((r) => ({
    ...r,
    high_risk: !!r.high_risk,
    has_report: !!r.report_kv_key,
    item_count: parseItems(r.items_json).length,
    status_label: BG_STATUS_LABEL[r.status] || r.status,
    consent_label: BG_CONSENT_LABEL[r.consent_status] || r.consent_status,
  }));
  return c.json({ items });
});

// ============ 详情 ============
background.get("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  const row = await loadBg(c.env, id);
  if (!row) return c.json({ error: "背调记录不存在" }, 404);
  if (!(await canTouch(c.env, session, row.owner_id))) return c.json({ error: "无权查看该背调记录" }, 403);
  return c.json({ bg: toDetail(row) });
});

// ============ 发起背调（新建草稿）============
background.post("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  let b: any;
  try { b = await c.req.json(); } catch { return c.json({ error: "请求参数格式不正确" }, 400); }

  const talentId = String(b.talent_id || "").trim();
  if (!talentId) return c.json({ error: "请选择候选人" }, 400);

  // 候选人权属校验
  const talent = await c.env.DB.prepare("SELECT id, owner_id, name FROM talents WHERE id = ?")
    .bind(talentId).first<{ id: string; owner_id: string; name: string }>();
  if (!talent) return c.json({ error: "候选人不存在" }, 404);
  if (!(await canTouch(c.env, session, talent.owner_id))) return c.json({ error: "无权为该候选人发起背调" }, 403);

  let jobId: string | null = null;
  if (b.talent_job_id) {
    const tj = await c.env.DB.prepare(
      "SELECT id, talent_id FROM talent_jobs WHERE id = ?"
    ).bind(b.talent_job_id).first<{ id: string; talent_id: string }>();
    if (!tj || tj.talent_id !== talentId) return c.json({ error: "投递记录与候选人不匹配" }, 400);
    jobId = tj.id;
  }

  const highRisk = b.high_risk ? 1 : 0;
  const items = highRisk ? [...DEFAULT_ITEMS, ...HIGH_RISK_ITEMS] : DEFAULT_ITEMS;
  const provider = String(b.provider || "").trim() || "manual";

  const id = genId();
  await c.env.DB.prepare(`
    INSERT INTO background_checks
      (id, owner_id, talent_id, talent_job_id, status, consent_status, provider, high_risk, items_json)
    VALUES (?, ?, ?, ?, 'pending', 'none', ?, ?, ?)
  `).bind(id, session.userId, talentId, jobId, provider, highRisk, JSON.stringify(items)).run();

  const row = await loadBg(c.env, id);
  return c.json({ bg: row ? toDetail(row) : null });
});

// ============ 更新（基础字段 / 结论 / 状态）============
// 敏感字段（items_json / result / summary / 推进状态）需已获授权；provider / high_risk 等设置项不受限。
background.patch("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  const row = await loadBg(c.env, id);
  if (!row) return c.json({ error: "背调记录不存在" }, 404);
  if (!(await canTouch(c.env, session, row.owner_id))) return c.json({ error: "无权修改该背调记录" }, 403);

  let b: any;
  try { b = await c.req.json(); } catch { return c.json({ error: "请求参数格式不正确" }, 400); }

  // 授权闸门：涉及敏感数据（结论/小结/分项/推进）的操作必须先拿到候选人授权
  const sensitiveField = ["items_json", "result", "summary", "status"].filter((k) => k in b);
  if (sensitiveField.length > 0 && row.consent_status !== "granted") {
    return c.json({ error: "请先取得候选人授权后再填写核验结论" }, 403);
  }

  const sets: string[] = [];
  const params: string[] = [];

  if ("provider" in b) { sets.push("provider = ?"); params.push(String(b.provider || "").trim() || "manual"); }
  if ("high_risk" in b) {
    const hr = b.high_risk ? 1 : 0;
    sets.push("high_risk = ?");
    params.push(String(hr));
    // 高敏开关变化：同步增减高敏核验项（保持与发起时一致的默认集合）
    const cur = parseItems(row.items_json);
    const hasHigh = cur.some((x) => x.type === "criminal" || x.type === "credit");
    if (hr === 1 && !hasHigh) { cur.push(...HIGH_RISK_ITEMS); sets.push("items_json = ?"); params.push(JSON.stringify(cur)); }
    if (hr === 0 && hasHigh) { sets.push("items_json = ?"); params.push(JSON.stringify(cur.filter((x) => x.type !== "criminal" && x.type !== "credit"))); }
  }
  if ("summary" in b) { sets.push("summary = ?"); params.push(String(b.summary ?? "").trim()); }
  if ("result" in b) {
    const result = b.result === "pass" || b.result === "fail" ? b.result : null;
    sets.push("result = ?");
    params.push(result || "");
    // 结论为「不通过」→ 状态落到 failed；为「通过」→ 不自动推进（由「通过并入职」动作推进）
    if (result === "fail") { sets.push("status = ?"); params.push("failed"); }
  }
  if ("status" in b && BG_STATUS.includes(b.status)) {
    sets.push("status = ?");
    params.push(b.status);
    if (b.status === "completed" && !row.completed_at) { sets.push("completed_at = ?"); params.push(todayCn()); }
    if (b.status === "processing" && !row.started_at) { sets.push("started_at = ?"); params.push(todayCn()); }
  }

  if (sets.length === 0) return c.json({ ok: true });
  sets.push("updated_at = datetime('now')");
  await c.env.DB.prepare(`UPDATE background_checks SET ${sets.join(", ")} WHERE id = ?`).bind(...params, id).run();

  const updated = await loadBg(c.env, id);
  return c.json({ ok: true, bg: updated ? toDetail(updated) : null });
});

// ============ 授权闸门（合规核心）============
background.post("/:id/consent", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  const row = await loadBg(c.env, id);
  if (!row) return c.json({ error: "背调记录不存在" }, 404);
  if (!(await canTouch(c.env, session, row.owner_id))) return c.json({ error: "无权操作该背调记录" }, 403);

  let b: any;
  try { b = await c.req.json(); } catch { return c.json({ error: "请求参数格式不正确" }, 400); }
  const action = b.action as string;
  if (!["request", "grant", "decline"].includes(action)) return c.json({ error: "非法的授权操作" }, 400);

  if (action === "request") {
    await c.env.DB.prepare(
      "UPDATE background_checks SET consent_status = 'requested', consent_at = NULL, updated_at = datetime('now') WHERE id = ?"
    ).bind(id).run();
    return c.json({ ok: true, consent_status: "requested" });
  }

  if (action === "decline") {
    await c.env.DB.prepare(
      "UPDATE background_checks SET consent_status = 'declined', status = 'cancelled', updated_at = datetime('now') WHERE id = ?"
    ).bind(id).run();
    return c.json({ ok: true, consent_status: "declined" });
  }

  // grant：涉及高敏信息必须二次明示确认
  if (row.high_risk && !b.confirm_high_risk) {
    return c.json({ error: "该背调涉及犯罪记录 / 征信等高敏信息，请确认已取得候选人二次明示授权" }, 400);
  }
  const method = String(b.method || "").trim() || null;
  // 授权即进入「核验中」；若此前为草稿(pending)也一并推进
  await c.env.DB.prepare(
    `UPDATE background_checks
     SET consent_status = 'granted', consent_at = datetime('now'), consent_method = ?,
         status = CASE WHEN status = 'pending' THEN 'processing' ELSE status END,
         started_at = CASE WHEN started_at IS NULL THEN datetime('now') ELSE started_at END,
         updated_at = datetime('now')
     WHERE id = ?`
  ).bind(method, id).run();
  return c.json({ ok: true, consent_status: "granted" });
});

// ============ 分项核验更新（需授权）============
background.post("/:id/items", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  const row = await loadBg(c.env, id);
  if (!row) return c.json({ error: "背调记录不存在" }, 404);
  if (!(await canTouch(c.env, session, row.owner_id))) return c.json({ error: "无权操作该背调记录" }, 403);
  if (row.consent_status !== "granted") return c.json({ error: "请先取得候选人授权后再填写核验项" }, 403);

  let b: any;
  try { b = await c.req.json(); } catch { return c.json({ error: "请求参数格式不正确" }, 400); }
  if (!Array.isArray(b.items)) return c.json({ error: "items 必须是数组" }, 400);

  // 仅允许更新已有项的 status/note（不允许凭空新增/删除项，保持与授权范围一致）
  const cur = parseItems(row.items_json);
  const byType = new Map(cur.map((x) => [x.type, x]));
  const next = b.items.map((x: any) => {
    const base = byType.get(x?.type);
    if (!base) return null;
    return {
      type: base.type,
      label: base.label,
      status: ITEM_STATUS.includes(x?.status) ? x.status : "pending",
      note: typeof x?.note === "string" ? x.note.slice(0, 2000) : "",
    };
  }).filter(Boolean);
  if (next.length === 0) return c.json({ error: "没有可更新的核验项" }, 400);

  await c.env.DB.prepare("UPDATE background_checks SET items_json = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(JSON.stringify(next), id).run();
  return c.json({ ok: true, items: next });
});

// ============ 上传报告原件（需授权，存 KV bgcheck: 前缀）============
background.post("/:id/report", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  const row = await loadBg(c.env, id);
  if (!row) return c.json({ error: "背调记录不存在" }, 404);
  if (!(await canTouch(c.env, session, row.owner_id))) return c.json({ error: "无权操作该背调记录" }, 403);
  if (row.consent_status !== "granted") return c.json({ error: "请先取得候选人授权后再上传报告" }, 403);

  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: "缺少文件" }, 400);
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  if (!["pdf", "docx", "doc", "jpg", "jpeg", "png"].includes(ext)) {
    return c.json({ error: "仅支持 PDF / Word / 图片（.jpg/.png）文件" }, 400);
  }
  if (file.size > 25 * 1024 * 1024) return c.json({ error: "文件过大，最大支持 25MB" }, 400);

  // 旧报告先清理（同一条记录只保留最新一份原件）
  if (row.report_kv_key) {
    try { await c.env.RESUMES.delete(row.report_kv_key); } catch { /* 忽略 */ }
  }

  const mime = file.type || "application/octet-stream";
  const kvKey = `bgcheck:${id}:${crypto.randomUUID()}.${ext}`;
  await c.env.RESUMES.put(kvKey, JSON.stringify({
    data: arrayBufferToBase64(await file.arrayBuffer()),
    name: file.name,
    type: mime,
  }));

  // 上传报告即视为核验完成（进入待判定状态）
  await c.env.DB.prepare(
    `UPDATE background_checks
     SET report_kv_key = ?, report_name = ?, status = CASE WHEN status = 'pending' OR status = 'processing' THEN 'completed' ELSE status END,
         completed_at = CASE WHEN completed_at IS NULL THEN datetime('now') ELSE completed_at END,
         updated_at = datetime('now')
     WHERE id = ?`
  ).bind(kvKey, file.name, id).run();

  const updated = await loadBg(c.env, id);
  return c.json({ ok: true, bg: updated ? toDetail(updated) : null });
});

// ============ 下载 / 预览报告（需授权）============
background.get("/:id/report", async (c) => {
  const token = getCookie(c, "token") || c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return c.json({ error: "未登录" }, 401);
  const sessionStr = await c.env.SESSIONS.get(token);
  if (!sessionStr) return c.json({ error: "未登录" }, 401);
  const session = JSON.parse(sessionStr) as SessionInfo;

  const id = c.req.param("id");
  const row = await loadBg(c.env, id);
  if (!row) return c.json({ error: "背调记录不存在" }, 404);
  if (!(await canTouch(c.env, session, row.owner_id))) return c.json({ error: "无权查看该报告" }, 403);
  if (row.consent_status !== "granted") return c.json({ error: "候选人尚未授权，无法查看报告" }, 403);
  if (!row.report_kv_key) return c.json({ error: "报告文件不存在" }, 404);

  const stored = await c.env.RESUMES.get(row.report_kv_key);
  if (!stored) return c.json({ error: "报告文件不存在" }, 404);

  const meta = JSON.parse(stored) as { data: string; name: string; type: string };
  const bytes = base64ToArrayBuffer(meta.data);
  const isDownload = c.req.query("download") === "1";
  // 背调报告是高敏材料（含犯罪/征信项），虽已有授权闸门，仍需留痕访问记录
  await writeAudit(c.env, session, {
    action: isDownload ? "export" : "view",
    targetType: "bgcheck",
    targetId: id,
    targetName: row.report_name,
    detail: { download: isDownload, high_risk: row.high_risk },
  });

  const headers = new Headers();
  headers.set("Content-Type", meta.type || "application/octet-stream");
  headers.set("Content-Disposition", `${isDownload ? "attachment" : "inline"}; filename="${encodeURIComponent(row.report_name || "report")}"`);
  return new Response(bytes, { headers });
});

// ============ 删除报告（需授权）============
background.delete("/:id/report", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  const row = await loadBg(c.env, id);
  if (!row) return c.json({ error: "背调记录不存在" }, 404);
  if (!(await canTouch(c.env, session, row.owner_id))) return c.json({ error: "无权操作该背调记录" }, 403);
  if (row.consent_status !== "granted") return c.json({ error: "请先取得候选人授权" }, 403);
  if (row.report_kv_key) { try { await c.env.RESUMES.delete(row.report_kv_key); } catch { /* 忽略 */ } }
  await c.env.DB.prepare(
    "UPDATE background_checks SET report_kv_key = NULL, report_name = NULL, status = CASE WHEN status = 'completed' THEN 'processing' ELSE status END, updated_at = datetime('now') WHERE id = ?"
  ).bind(id).run();
  return c.json({ ok: true });
});

// ============ AI 背调小结（需授权）============
const BG_SUMMARY_SYSTEM = `你是一名合规背景调查助理。请基于已核验的背调分项结果，生成一份客观、审慎的背调小结。
要求：
1. summary：2-4 句话概述核验总体情况，措辞中立，不夸大、不臆断。
2. risks：0-3 条风险点（引用具体核验项结论，如「工作履历核验异常」「学历核验异常」）；若无风险返回空数组。
3. 所有结论必须基于输入的分项结论，不得编造未核验的信息。
只返回 JSON：{"summary": "…", "risks": ["…"]}`;

background.post("/:id/ai-summary", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  const row = await loadBg(c.env, id);
  if (!row) return c.json({ error: "背调记录不存在" }, 404);
  if (!(await canTouch(c.env, session, row.owner_id))) return c.json({ error: "无权操作该背调记录" }, 403);
  if (row.consent_status !== "granted") return c.json({ error: "请先取得候选人授权后再生成小结" }, 403);

  // 自有 Key 优先（用户配额用完时靠自己的 Key 继续用，不占系统配额）
  const { key } = await resolveAiKey(c.env, session.userId);
  if (!key) return c.json({ error: "未配置 AI 密钥，无法生成小结" }, 400);

  const items = parseItems(row.items_json);
  const itemText = items.map((x) => `- ${x.label}：${ITEM_STATUS_LABEL[x.status] || x.status}${x.note ? `（${x.note}）` : ""}`).join("\n");
  const user = `候选人：${row.talent_name}\n授权方式：${row.consent_method || "已授权"}\n\n核验分项：\n${itemText}\n${row.summary ? `\n人工补充：${row.summary}` : ""}`;

  try {
    const gen = await deepseekJsonWithUsage(key, BG_SUMMARY_SYSTEM, user, { maxTokens: 400 });
    if (!gen) return c.json({ error: "AI 未能生成小结，请手动填写" }, 400);
    const raw = gen.data;
    const summary = typeof raw.summary === "string" ? raw.summary : "";
    const risks = Array.isArray(raw.risks) ? raw.risks.filter((x) => typeof x === "string").slice(0, 3) : [];
    if (!summary) return c.json({ error: "AI 未能生成小结，请手动填写" }, 400);
    return c.json({ summary, risks, _usage: gen.usage ?? null });
  } catch (e) {
    return c.json({ error: "AI 生成失败：" + (e as Error).message }, 500);
  }
});

// ============ AI 简历核查清单（需授权）：喂简历文本，生成待核查建议 ============
// AI 只做「核查规划」：基于简历文本产出待核查项 + 建议渠道 + 需收集材料，
// 外部事实须 HR 线下或经第三方核验；AI 不联网、不编造核实结果。
const BG_RESUME_CHECK_SYSTEM = `你是一名合规背景调查助理。请基于候选人简历原文，生成一份「待核查清单」，帮助 HR 线下或经第三方核验外部事实。
要求：
1. items：3-8 条待核查项，每条含：
   - category（类别，如 学历 / 工作履历 / 竞业限制 / 身份 / 其他）
   - item（具体核查事项，如「核实 XX 大学 XX 专业 XX 学位真伪」）
   - channel（建议核查渠道，如 学信网/学位网、前雇主 HR、社保系统、原劳动合同）
   - material（需收集的证明材料，如 毕业证扫描件、离职证明、社保缴纳记录）
   - priority（优先级 high / medium / low）
2. gaps：简历中缺失或含糊、需要向候选人补充确认的信息点（0-5 条）。
3. notes：2-3 句整体建议（优先核查哪些、注意哪些风险）。
重要：你只能基于简历文本生成「待核查建议」，不得编造任何外部核实结果；所有结论仅作参考，外部事实须人工或第三方核验。
只返回 JSON：{"items":[{"category":"…","item":"…","channel":"…","material":"…","priority":"high|medium|low"}],"gaps":["…"],"notes":"…"}`;

// 复用 ai_artifacts 做 10 分钟缓存，避免重复烧 token（与 aiAssist 同源表）
async function loadBgArtifact(db: any, ownerId: string, bizId: string) {
  const row = await db.prepare(
    `SELECT content FROM ai_artifacts WHERE owner_id = ? AND biz_type = 'resume_bgcheck' AND biz_id = ? AND created_at > datetime('now','-10 minutes') ORDER BY created_at DESC LIMIT 1`
  ).bind(ownerId, bizId).first() as { content?: string } | null;
  return row && row.content ? JSON.parse(row.content) : null;
}
async function saveBgArtifact(db: any, ownerId: string, bizId: string, content: unknown) {
  await db.prepare(
    `INSERT INTO ai_artifacts (id, owner_id, biz_type, biz_id, content, created_at) VALUES (?, ?, 'resume_bgcheck', ?, ?, datetime('now'))`
  ).bind(genId(), ownerId, bizId, JSON.stringify(content)).run();
}

background.post("/:id/ai-resume-check", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  const row = await loadBg(c.env, id);
  if (!row) return c.json({ error: "背调记录不存在" }, 404);
  if (!(await canTouch(c.env, session, row.owner_id))) return c.json({ error: "无权操作该背调记录" }, 403);
  if (row.consent_status !== "granted") return c.json({ error: "请先取得候选人授权后再生成核查清单" }, 403);

  // 共享 AI 配额（系统设置→AI 配额）：超了直接挡，与其他 AI 功能口径一致。
  // 自带 Key 的用户花自己的钱，不占系统配额，直接放行。
  const { key, own } = await resolveAiKey(c.env, session.userId);
  if (!key) return c.json({ error: "未配置 AI 密钥，无法生成核查清单", code: "AI_NO_KEY" }, 400);
  if (!own) {
    const quota = await checkQuota(c.env.DB, session.userId, session.role);
    if (!quota.ok) {
      return c.json(
        {
          error: `今日 AI 次数已用完（${quota.used}/${quota.limit}）——配置自己的 DeepSeek Key 立即可继续使用，不占系统配额`,
          code: "AI_QUOTA",
        },
        429
      );
    }
  }

  let body: any = {};
  try { body = await c.req.json(); } catch { /* ignore */ }
  const resumeText = (typeof body?.resume_text === "string" ? body.resume_text : "").slice(0, 8000).trim();
  if (!resumeText) return c.json({ error: "缺少简历文本" }, 400);

  // 缓存维度是「这条背调」而非候选人：同一候选人可能有多条背调记录，
  // 用 talent_id 会让另一条记录误命中本条的缓存（从而跳过下面的回填逻辑）。
  const cached = await loadBgArtifact(c.env.DB, session.userId, id);
  if (cached) return c.json({ ...cached, _cached: true });

  const user = `候选人：${row.talent_name}\n\n简历原文：\n${resumeText}`;
  try {
    const gen = await deepseekJsonWithUsage(key, BG_RESUME_CHECK_SYSTEM, user, { maxTokens: 1400 });
    if (!gen || !Array.isArray(gen.data.items)) return c.json({ error: "AI 未能生成核查清单，请手动整理" }, 400);
    const raw = gen.data;
    const items = (raw.items as any[]).slice(0, 8)
      .map((x) => ({
        category: String(x?.category || "其他").slice(0, 20),
        item: String(x?.item || "").slice(0, 200),
        channel: String(x?.channel || "").slice(0, 100),
        material: String(x?.material || "").slice(0, 100),
        priority: x?.priority === "high" || x?.priority === "medium" || x?.priority === "low" ? x.priority : "medium",
      }))
      .filter((x) => x.item);
    if (items.length === 0) return c.json({ error: "AI 未能生成有效核查项，请手动整理" }, 400);
    const gaps = Array.isArray(raw.gaps) ? raw.gaps.filter((g: any) => typeof g === "string").slice(0, 5) : [];
    const notes = typeof raw.notes === "string" ? raw.notes : "";
    const result = { items, gaps, notes };

    // 回填：把 AI 建议追加为待核验项（type 用 ai: 前缀，避免覆盖既有核验项）
    const cur = parseItems(row.items_json);
    const addItems = items.map((it, i) => ({
      type: `ai:${it.category}:${i}`,
      label: `${it.item}（核查渠道：${it.channel}｜材料：${it.material}）`,
      status: "pending",
      note: `AI 建议优先级：${it.priority}`,
    }));
    const merged = [...cur, ...addItems];
    const newSummary = row.summary ? row.summary : notes;
    await c.env.DB.prepare(
      `UPDATE background_checks SET items_json = ?, summary = ?, status = CASE WHEN status = 'pending' THEN 'processing' ELSE status END, updated_at = datetime('now') WHERE id = ?`
    ).bind(JSON.stringify(merged), newSummary, id).run();

    await saveBgArtifact(c.env.DB, session.userId, id, result);
    return c.json({ ...result, _usage: gen.usage ?? null });
  } catch (e) {
    return c.json({ error: "AI 生成失败：" + (e as Error).message }, 500);
  }
});

// ============ 通过并推进入职（需授权 + 结论为通过）============
background.post("/:id/pass", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  const row = await loadBg(c.env, id);
  if (!row) return c.json({ error: "背调记录不存在" }, 404);
  if (!(await canTouch(c.env, session, row.owner_id))) return c.json({ error: "无权操作该背调记录" }, 403);
  if (row.consent_status !== "granted") return c.json({ error: "请先取得候选人授权" }, 403);
  if (!row.talent_job_id) return c.json({ error: "该背调未关联投递记录，无法推进入职" }, 400);
  if (row.result !== "pass") {
    // 未填结论时不能报「不通过」，否则会把「还没填」误导成「结论为否」
    return c.json(
      { error: row.result === "fail" ? "背调结论为「不通过」，无法推进入职" : "尚未填写背调结论，请先给出结论后再推进" },
      400
    );
  }

  const downstream: string[] = [];
  try {
    const mv = await moveStageForward(c.env.DB, {
      linkId: row.talent_job_id,
      toStage: "hired",
      userId: session.userId,
      remark: "背调通过，系统自动流转到已入职",
    });
    if (mv.moved) downstream.push("已自动流转到「已入职」");
    else if (mv.reason === "no_forward") downstream.push("投递已在更靠后阶段，未改动");
    else if (mv.reason === "not_found") downstream.push("投递不存在，未能流转");
    else if (mv.reason === "same") downstream.push("投递阶段无变化");

    // 入职材料清单已由 moveStageForward 内部幂等生成（见 talentFlow.ts），这里**不能再调一次**
    // ensureOnboardingItems——它会因为「已存在」返回 0，导致下面拿不到真实数量。改为直接读回。
    const ob = await c.env.DB.prepare(
      "SELECT COUNT(*) as n FROM onboarding_items WHERE talent_id = ? AND talent_job_id IS ?"
    ).bind(row.talent_id, row.talent_job_id).first<{ n: number }>();
    if ((ob?.n ?? 0) > 0) downstream.push(`入职材料清单 ${ob!.n} 项已就绪`);
  } catch (e) {
    downstream.push(`下游联动未完成：${(e as Error).message}`);
  }

  await c.env.DB.prepare(
    "UPDATE background_checks SET status = 'passed', completed_at = CASE WHEN completed_at IS NULL THEN datetime('now') ELSE completed_at END, updated_at = datetime('now') WHERE id = ?"
  ).bind(id).run();

  return c.json({ ok: true, status: "passed", downstream });
});

// ============ 删除背调（硬删除）============
// 与「取消」的区别：取消是软终止（保留记录与留痕），删除是整条抹掉。
// 已通过并入职的背调属于合规留痕（证明录用前尽调过），与取消口径一致，不允许删除。
background.delete("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  const row = await loadBg(c.env, id);
  if (!row) return c.json({ error: "背调记录不存在" }, 404);
  if (!(await canTouch(c.env, session, row.owner_id))) return c.json({ error: "无权删除该背调记录" }, 403);
  if (row.status === "passed") return c.json({ error: "背调已通过并入职，无法删除（合规留痕）" }, 400);

  // KV 报告原件一并清理（KV 异常不阻断数据库删除，与人才删除口径一致）
  if (row.report_kv_key) { try { await c.env.RESUMES.delete(row.report_kv_key); } catch { /* 忽略 */ } }
  // AI 简历核查清单的 10 分钟缓存一并清掉，避免删后重开详情又冒出旧结果
  await c.env.DB.prepare(
    "DELETE FROM ai_artifacts WHERE biz_type = 'resume_bgcheck' AND biz_id = ?"
  ).bind(id).run();
  await c.env.DB.prepare("DELETE FROM background_checks WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ============ 取消背调 ============
background.post("/:id/cancel", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  const row = await loadBg(c.env, id);
  if (!row) return c.json({ error: "背调记录不存在" }, 404);
  if (!(await canTouch(c.env, session, row.owner_id))) return c.json({ error: "无权操作该背调记录" }, 403);
  if (row.status === "passed") return c.json({ error: "背调已通过并入职，无法取消" }, 400);

  // 一并清理 KV 报告
  if (row.report_kv_key) { try { await c.env.RESUMES.delete(row.report_kv_key); } catch { /* 忽略 */ } }
  await c.env.DB.prepare(
    "UPDATE background_checks SET status = 'cancelled', report_kv_key = NULL, report_name = NULL, updated_at = datetime('now') WHERE id = ?"
  ).bind(id).run();
  return c.json({ ok: true });
});

export { background as backgroundRoutes };

// 供其他模块（如看板卡片）判断是否处于背调中，按需自行 import
export async function activeBgCheck(env: Env, talentJobId: string): Promise<BgRow | null> {
  return env.DB.prepare(
    "SELECT * FROM background_checks WHERE talent_job_id = ? AND status IN ('pending','processing','completed') LIMIT 1"
  ).bind(talentJobId).first<BgRow>();
}
