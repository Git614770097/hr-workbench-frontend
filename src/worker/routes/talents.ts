import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../index";
import { getSession } from "./auth";
import { genId } from "../helpers";
import { STAGES, syncTalentStage } from "./pipeline";
import { deepseekJson } from "../ai";
import { shiftToWorkday } from "../utils/workday";

const talents = new Hono<{ Bindings: Env }>();

/** 日期字段只接受 YYYY-MM-DD（或带时间的 ISO），其余一律置 NULL，避免脏数据入库。
 *  新增与批量导入共用，别在两处各写一份。 */
function dateOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// 录入方式归一化：只允许 manual/import/sync，未知或缺失回落 fallback
function normalizeEntryType(v: unknown, fallback = "manual"): string {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return ["manual", "import", "sync"].includes(s) ? s : fallback;
}

// ---- 合同/试用期到期 → 待办提醒（幂等同步）----
// 规则：pending 的「合同到期：X」「试用期到期：X」待办与人才当前日期对齐——
// 有日期且无待办 → 新建（priority high、source system）；日期变更 → 更新待办 due；
// 日期被清空 → 取消残留提醒。编辑保存（PUT）与批量同步（/contracts/sync-tasks）共用。
type TalentContractRow = { id: string; owner_id: string; name: string; contract_end: string | null; probation_end: string | null; next_follow_at?: string | null };
type ExistingTask = { id: string; title: string; due_date: string | null };

function contractTaskStmts(db: any, t: TalentContractRow, existing: ExistingTask[]) {
  const kinds = [
    {
      prefix: "合同到期",
      due: t.contract_end,
      content: `${t.name} 的劳动合同将于 ${t.contract_end} 到期，请及时安排续签评估或离职交接。`,
    },
    {
      prefix: "试用期到期",
      due: t.probation_end,
      content: `${t.name} 的试用期将于 ${t.probation_end} 到期，请提前完成转正评估。`,
    },
    {
      // 录入表单填的「下次跟进时间」：提醒自己（推到负责人），由 PushPlus 推微信
      prefix: "跟进提醒",
      due: t.next_follow_at ? String(t.next_follow_at).slice(0, 10) : null,
      content: `${t.name} 的跟进时间已到（${t.next_follow_at}），请及时联系候选人并推进流程。`,
      priority: "normal" as const,
    },
  ];
  const stmts: any[] = [];
  let created = 0, updated = 0, cancelled = 0;
  for (const { prefix, due, content } of kinds) {
    const title = `${prefix}：${t.name}`;
    const dup = existing.find((x) => x.title === title);
    if (!due) {
      if (dup) { stmts.push(db.prepare(`UPDATE talent_tasks SET status = 'cancelled' WHERE id = ?`).bind(dup.id)); cancelled++; }
      continue;
    }
    const sh = shiftToWorkday(due);
    const pr = (kinds.find((x) => x.prefix === prefix) as any)?.priority || 'high';
    if (!dup) {
      stmts.push(db.prepare(`INSERT INTO talent_tasks (id, owner_id, talent_id, title, content, due_date, priority, status, source, original_due, shifted) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'system', ?, ?)`).bind(genId(), t.owner_id, t.id, title, content, sh.due, pr, sh.original, sh.shifted ? 1 : 0));
      created++;
      continue;
    }
    if (dup.due_date !== sh.due) {
      stmts.push(db.prepare(`UPDATE talent_tasks SET due_date = ?, content = ?, original_due = ?, shifted = ? WHERE id = ?`).bind(sh.due, content, sh.original, sh.shifted ? 1 : 0, dup.id));
      updated++;
    }
  }
  return { stmts, created, updated, cancelled };
}

// ---- 社保增减员 → 待办提醒（幂等同步，与合同到期同套路）----
// 规则：已入职（status=placed 或填了 hire_date）且未参保 → 「社保增员：X」；
// 填了离职日期且仍在缴 → 「社保减员：X」。参保/停缴状态变化即对齐待办。
type SocialTalentRow = {
  id: string; owner_id: string; name: string;
  status: string; hire_date: string | null; resignation_date: string | null;
  si_status: string | null;  // LEFT JOIN talent_social，无记录为 null
};

function socialTaskStmts(db: any, t: SocialTalentRow, existing: ExistingTask[]) {
  const si = t.si_status || "none";
  const onboarded = t.status === "placed" || !!t.hire_date;
  const kinds = [
    {
      prefix: "社保增员",
      active: onboarded && si === "none",
      due: t.hire_date || null,
      content: `${t.name} 已入职${t.hire_date ? `（${t.hire_date}）` : ""}，尚未办理社保参保登记，请及时办理社保增员。`,
    },
    {
      prefix: "社保减员",
      active: !!t.resignation_date && si === "active",
      due: t.resignation_date,
      content: `${t.name} 将于 ${t.resignation_date} 离职，社保仍在缴，请在离职当月及时办理社保减员（停缴）。`,
    },
  ];
  const stmts: any[] = [];
  let created = 0, updated = 0, cancelled = 0;
  for (const { prefix, active, due, content } of kinds) {
    const title = `${prefix}：${t.name}`;
    const dup = existing.find((x) => x.title === title);
    if (!active) {
      if (dup) { stmts.push(db.prepare(`UPDATE talent_tasks SET status = 'cancelled' WHERE id = ?`).bind(dup.id)); cancelled++; }
      continue;
    }
    const sh = shiftToWorkday(due || new Date().toISOString().slice(0, 10));
    const effectiveDue = sh.due;
    if (!dup) {
      stmts.push(db.prepare(`INSERT INTO talent_tasks (id, owner_id, talent_id, title, content, due_date, priority, status, source, original_due, shifted) VALUES (?, ?, ?, ?, ?, ?, 'high', 'pending', 'system', ?, ?)`).bind(genId(), t.owner_id, t.id, title, content, effectiveDue, sh.original, sh.shifted ? 1 : 0));
      created++;
      continue;
    }
    if (dup.due_date !== effectiveDue) {
      stmts.push(db.prepare(`UPDATE talent_tasks SET due_date = ?, content = ?, original_due = ?, shifted = ? WHERE id = ?`).bind(effectiveDue, content, sh.original, sh.shifted ? 1 : 0, dup.id));
      updated++;
    }
  }
  return { stmts, created, updated, cancelled };
}

/** 单个人才的社保待办即时同步：查该人才行 + 现存待办 → batch 执行 */
async function syncSocialTasksForTalent(db: any, talentId: string) {
  const t = (await db.prepare(
    `SELECT t.id, t.owner_id, t.name, t.status, t.hire_date, t.resignation_date, s.si_status
       FROM talents t LEFT JOIN talent_social s ON s.talent_id = t.id
      WHERE t.id = ?`
  ).bind(talentId).first()) as SocialTalentRow | undefined;
  if (!t) return;
  const tasks = (await db.prepare(
    `SELECT id, title, due_date FROM talent_tasks WHERE talent_id = ? AND status = 'pending' AND (title LIKE '社保增员：%' OR title LIKE '社保减员：%')`
  ).bind(talentId).all()) as { results: ExistingTask[] };
  const { stmts } = socialTaskStmts(db, t, tasks.results || []);
  if (stmts.length) await db.batch(stmts);
}

// Base64 <-> ArrayBuffer 转换（用于 KV 存储二进制文件）
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ---- 人才列表（搜索/筛选/分页）----
talents.get("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const q = (c.req.query("q") || "").trim();
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  const status = c.req.query("status");
  const group = c.req.query("group");
  const city = c.req.query("city");
  const ownerId = c.req.query("owner_id");
  // 分字段筛选
  const name = (c.req.query("name") || "").trim();
  const phone = (c.req.query("phone") || "").trim();
  const email = (c.req.query("email") || "").trim();
  const age = c.req.query("age");
  const education = (c.req.query("education") || "").trim();
  const school = (c.req.query("school") || "").trim();
  const years = c.req.query("years");
  const title = (c.req.query("title") || "").trim();
  const entryType = c.req.query("entry_type");

  const offset = (page - 1) * limit;
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (session.role === "admin") {
    if (ownerId) { conditions.push("t.owner_id = ?"); params.push(ownerId); }
  } else {
    conditions.push("t.owner_id = ?");
    params.push(session.userId);
  }

  if (q) {
    conditions.push("(t.name LIKE ? OR t.current_company LIKE ? OR t.current_title LIKE ? OR t.skills LIKE ? OR t.industry LIKE ? OR t.notes LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }
  if (name) { conditions.push("t.name LIKE ?"); params.push(`%${name}%`); }
  if (phone) { conditions.push("t.phone LIKE ?"); params.push(`%${phone}%`); }
  if (email) { conditions.push("t.email LIKE ?"); params.push(`%${email}%`); }
  if (age && !isNaN(parseInt(age, 10))) { conditions.push("t.age = ?"); params.push(parseInt(age, 10)); }
  if (education) { conditions.push("t.education LIKE ?"); params.push(`%${education}%`); }
  if (school) { conditions.push("t.school LIKE ?"); params.push(`%${school}%`); }
  if (years && !isNaN(parseInt(years, 10))) { conditions.push("t.years_experience = ?"); params.push(parseInt(years, 10)); }
  if (title) { conditions.push("t.current_title LIKE ?"); params.push(`%${title}%`); }
  if (status && !group) { conditions.push("t.status = ?"); params.push(status); }
  if (entryType) { conditions.push("t.entry_type = ?"); params.push(entryType); }
  // 人才库快捷分组：与单值 status 互斥（前端点分组会清空 status）。
  // 各分组基于招聘流程阶段 / 面试记录 / 入职状态 / 离职日期，复用同一列表查询。
  if (group) {
    if (group === "active_pipeline") {
      // 招聘进行中：在流程里且未结束（初筛~Offer）
      conditions.push("EXISTS (SELECT 1 FROM talent_jobs tj WHERE tj.talent_id = t.id AND tj.stage IN ('screening','interview1','interview2','offer'))");
    } else if (group === "interviewed") {
      // 面试过的：安排过面试记录，或阶段到过面试轮
      conditions.push("EXISTS (SELECT 1 FROM interviews iv JOIN talent_jobs tj ON iv.talent_job_id = tj.id WHERE tj.talent_id = t.id) OR EXISTS (SELECT 1 FROM talent_jobs tj WHERE tj.talent_id = t.id AND tj.stage IN ('interview1','interview2'))");
    } else if (group === "placed") {
      // 已入职（在职）：status=placed 或 全局阶段 hired
      conditions.push("(t.status = 'placed' OR t.stage = 'hired')");
    } else if (group === "left") {
      // 已离职：录了离职日期（resignation_date 非空）
      conditions.push("(t.resignation_date IS NOT NULL AND t.resignation_date <> '')");
    } else if (group === "ended") {
      // 已淘汰·放弃：流程终态
      conditions.push("t.stage IN ('rejected','withdrawn')");
    } else if (group === "inactive") {
      // 待激活：没进任何流程，且未入职、未离职
      conditions.push("((t.stage = 'archived' OR NOT EXISTS (SELECT 1 FROM talent_jobs tj WHERE tj.talent_id = t.id)) AND t.status <> 'placed' AND (t.resignation_date IS NULL OR t.resignation_date = ''))");
    }
  }
  if (city) { conditions.push("t.city LIKE ?"); params.push(`%${city}%`); }
  // 标签筛选：tags 是 JSON 数组字符串，模糊匹配包含该标签的记录
  const tag = (c.req.query("tags") || "").trim();
  if (tag) { conditions.push("t.tags LIKE ?"); params.push(`%${tag}%`); }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  const countResult = await c.env.DB.prepare(`SELECT COUNT(*) as total FROM talents t ${where}`).bind(...params).first<{ total: number }>();
  const rows = await c.env.DB.prepare(`SELECT t.*, u.name as owner_name FROM talents t JOIN users u ON t.owner_id = u.id ${where} ORDER BY t.updated_at DESC LIMIT ? OFFSET ?`).bind(...params, limit, offset).all();

  const items = rows.results.map((r: any) => ({
    ...r, skills: r.skills ? JSON.parse(r.skills) : [], tags: r.tags ? JSON.parse(r.tags) : [],
  }));

  return c.json({ items, total: countResult?.total || 0, page, limit, pages: Math.ceil((countResult?.total || 0) / limit) });
});

// ---- 合规到期扫描：合同 / 试用期 30 天内到期（含已过期未更新）----
// 静态路由必须注册在 GET /:id 之前，否则 "compliance" 会被当成人才 id。
talents.get("/compliance", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  // 两个 SELECT 各自做 owner 隔离（UNION ALL 前后各绑定一次）
  const ownerCond = session.role !== "admin" ? " AND t.owner_id = ?" : "";
  const params: string[] = session.role !== "admin" ? [session.userId, session.userId] : [];

  const sql = `
    SELECT t.id AS talent_id, t.name, t.contract_end AS due_date,
           CAST(julianday(t.contract_end) - julianday(date('now')) AS INTEGER) AS days_left,
           'contract' AS type
      FROM talents t
     WHERE t.contract_end IS NOT NULL AND t.contract_end <= date('now', '+30 day')${ownerCond}
    UNION ALL
    SELECT t.id, t.name, t.probation_end,
           CAST(julianday(t.probation_end) - julianday(date('now')) AS INTEGER),
           'probation'
      FROM talents t
     WHERE t.probation_end IS NOT NULL AND t.probation_end <= date('now', '+30 day')${ownerCond}
    ORDER BY days_left ASC
    LIMIT 100`;

  const rows = (await c.env.DB.prepare(sql).bind(...params).all<any>()).results;
  return c.json({
    items: rows,
    contract_count: rows.filter((r) => r.type === "contract").length,
    probation_count: rows.filter((r) => r.type === "probation").length,
  });
});

// ---- 合同管理：有合同/试用期日期的人才清单（按最近到期日排序）----
talents.get("/contracts", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const q = (c.req.query("q") || "").trim();
  let sql = `SELECT id, name, phone, email, status, contract_end, probation_end FROM talents WHERE (contract_end IS NOT NULL OR probation_end IS NOT NULL)`;
  const params: string[] = [];
  if (session.role !== "admin") { sql += ` AND owner_id = ?`; params.push(session.userId); }
  if (q) { sql += ` AND name LIKE ?`; params.push(`%${q}%`); }
  sql += ` ORDER BY COALESCE(contract_end, probation_end) IS NULL, COALESCE(contract_end, probation_end) ASC LIMIT 500`;

  const rows = (await c.env.DB.prepare(sql).bind(...params).all<any>()).results;
  return c.json(rows);
});

// ---- 合同到期提醒批量同步：扫描全部有日期的人才，幂等生成/更新/取消待办 ----
// 触发时机：合同管理页加载时自动调用一次；单条编辑保存时在 PUT /:id 里即时同步。
talents.post("/contracts/sync-tasks", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const ownerCond = session.role !== "admin" ? " AND owner_id = ?" : "";
  const ownerParams: string[] = session.role !== "admin" ? [session.userId] : [];
  const talentsRows = (await c.env.DB.prepare(
    `SELECT id, owner_id, name, contract_end, probation_end FROM talents WHERE (contract_end IS NOT NULL OR probation_end IS NOT NULL)${ownerCond} LIMIT 500`
  ).bind(...ownerParams).all<TalentContractRow>()).results;
  if (!talentsRows.length) return c.json({ checked: 0, created: 0, updated: 0, cancelled: 0 });

  const ids = talentsRows.map((t) => t.id);
  const placeholders = ids.map(() => "?").join(",");
  const tasksRows = (await c.env.DB.prepare(
    `SELECT id, talent_id, title, due_date FROM talent_tasks WHERE talent_id IN (${placeholders}) AND status = 'pending' AND (title LIKE '合同到期：%' OR title LIKE '试用期到期：%')`
  ).bind(...ids).all<ExistingTask & { talent_id: string }>()).results;

  const byTalent: Record<string, ExistingTask[]> = {};
  for (const tk of tasksRows) (byTalent[tk.talent_id] ||= []).push(tk);

  const stmts: any[] = [];
  let created = 0, updated = 0, cancelled = 0;
  for (const t of talentsRows) {
    const r = contractTaskStmts(c.env.DB, t, byTalent[t.id] || []);
    stmts.push(...r.stmts);
    created += r.created; updated += r.updated; cancelled += r.cancelled;
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ checked: talentsRows.length, created, updated, cancelled });
});

// ---- 合同文件：上传（含 AI 日期识别）/ 列表 / 下载 / 删除 ----
// 文件本体存 KV（复用 RESUMES 命名空间，contract: 前缀与简历隔离），
// 元数据存 D1 contract_files。文本抽取在前端完成（pdfjs/mammoth，与简历导入同链路），
// 后端只负责：存文件 → 调 DeepSeek 从文本抽日期 → 返回识别结果。
// 识别结果仅作记录与预填，档案日期以 talents.contract_end / probation_end 为准。

const CONTRACT_EXTRACT_SYSTEM = `你是一份劳动合同的信息提取助手。请从合同文本中提取以下两个日期，并以严格的 JSON 对象返回（不要输出任何解释，不要 markdown 代码块）：
- contract_end: 劳动合同到期日。固定期限合同一般写作「本合同自 X 年 X 月 X 日起至 Y 年 Y 月 Y 日止」，取终止日期 Y，格式 YYYY-MM-DD。无固定期限合同（无终止日期）返回 null。
- probation_end: 试用期到期日。若合同写了试用期时长和起始日，请推算（如 2025 年 3 月 1 日起试用 3 个月，试用期为 2025-03-01 至 2025-05-31，取 2025-05-31）；没有试用期信息返回 null。
注意：
1. 文本中若出现多份合同或续签条款，以最后（最新）一份合同的日期为准。
2. 拿不准就返回 null，绝不要编造日期。
3. 只返回 {"contract_end": "YYYY-MM-DD" 或 null, "probation_end": "YYYY-MM-DD" 或 null}`;

/** AI 返回的日期 → 合法 YYYY-MM-DD（2000-2100 年区间），脏值一律置 null */
function contractDateOrNull(v: unknown): string | null {
  const d = dateOrNull(v);
  if (!d) return null;
  const y = parseInt(d.slice(0, 4), 10);
  return y >= 2000 && y <= 2100 ? d : null;
}

function normContractDates(raw: Record<string, unknown> | null) {
  if (!raw) return null;
  const contract_end = contractDateOrNull(raw.contract_end);
  const probation_end = contractDateOrNull(raw.probation_end);
  if (!contract_end && !probation_end) return null;
  return { contract_end, probation_end };
}

type ContractFileRow = {
  id: string; talent_id: string; filename: string; mime: string; size: number;
  kv_key: string; extracted_contract_end: string | null; extracted_probation_end: string | null;
  applied: number; created_at: string;
};

// 上传合同文件：multipart（file + talent_id + text 可选）
talents.post("/contracts/files", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const talentId = formData.get("talent_id") as string | null;
  const text = ((formData.get("text") as string | null) || "").trim();
  if (!file || !talentId) return c.json({ error: "缺少文件或人才ID" }, 400);

  // 权限检查 + 取人才姓名
  let checkSql = "SELECT id, owner_id, name FROM talents WHERE id = ?";
  const checkParams: string[] = [talentId];
  if (session.role !== "admin") { checkSql += " AND owner_id = ?"; checkParams.push(session.userId); }
  const talent = await c.env.DB.prepare(checkSql).bind(...checkParams).first<{ id: string; owner_id: string; name: string }>();
  if (!talent) return c.json({ error: "人才不存在" }, 404);

  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  if (!["pdf", "docx", "doc"].includes(ext)) {
    return c.json({ error: "仅支持 PDF 或 Word（.docx/.doc）文件" }, 400);
  }
  // KV 单值上限 25MB（与简历文件一致）
  if (file.size > 25 * 1024 * 1024) return c.json({ error: "文件过大，最大支持 25MB" }, 400);

  // 文件本体 → KV；元数据 → D1
  const mime = file.type || (ext === "pdf" ? "application/pdf" : "application/octet-stream");
  const kvKey = `contract:${talentId}:${crypto.randomUUID()}.${ext}`;
  await c.env.RESUMES.put(kvKey, JSON.stringify({
    data: arrayBufferToBase64(await file.arrayBuffer()),
    name: file.name,
    type: mime,
  }));

  const fileId = genId();
  await c.env.DB.prepare(
    `INSERT INTO contract_files (id, owner_id, talent_id, filename, mime, size, kv_key) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(fileId, session.userId, talentId, file.name, mime, file.size, kvKey).run();

  // AI 识别日期：失败不阻断上传（文件已存好，日期可手动填）
  let extracted: { contract_end: string | null; probation_end: string | null } | null = null;
  let warning: string | null = null;
  if (text.length >= 10) {
    try {
      const raw = await deepseekJson(
        c.env.DEEPSEEK_API_KEY!,
        CONTRACT_EXTRACT_SYSTEM,
        `请解析以下劳动合同文本（${talent.name}）：\n\n${text.slice(0, 6000)}`,
        { maxTokens: 200 }
      );
      extracted = normContractDates(raw);
      if (!extracted) warning = "AI 未能从文件中识别出日期，请手动填写";
    } catch {
      warning = "AI 识别失败，请手动填写日期";
    }
  } else {
    warning = "文件没有可提取的文字（可能是扫描件），请手动填写日期";
  }

  if (extracted) {
    await c.env.DB.prepare(`UPDATE contract_files SET extracted_contract_end = ?, extracted_probation_end = ? WHERE id = ?`)
      .bind(extracted.contract_end, extracted.probation_end, fileId).run();
  }

  const row = await c.env.DB.prepare(`SELECT id, talent_id, filename, mime, size, kv_key, extracted_contract_end, extracted_probation_end, applied, created_at FROM contract_files WHERE id = ?`)
    .bind(fileId).first<ContractFileRow>();
  return c.json({ file: row, extracted, warning });
});

// 合同文件列表（按人才）
talents.get("/contracts/files", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const talentId = (c.req.query("talent_id") || "").trim();
  if (!talentId) return c.json({ error: "缺少 talent_id" }, 400);

  let sql = `SELECT id, talent_id, filename, mime, size, extracted_contract_end, extracted_probation_end, applied, created_at FROM contract_files WHERE talent_id = ?`;
  const params: string[] = [talentId];
  if (session.role !== "admin") { sql += ` AND owner_id = ?`; params.push(session.userId); }
  sql += ` ORDER BY created_at DESC LIMIT 50`;

  const rows = (await c.env.DB.prepare(sql).bind(...params).all<ContractFileRow>()).results;
  return c.json(rows);
});

// 合同文件下载/预览（支持 query token，便于 <a>/iframe 直接打开）
talents.get("/contracts/files/:id/file", async (c) => {
  const token = c.req.query("token") || getCookie(c, "token") || c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return c.json({ error: "未登录" }, 401);
  const sessionStr = await c.env.SESSIONS.get(token);
  if (!sessionStr) return c.json({ error: "未登录" }, 401);
  const session = JSON.parse(sessionStr) as { userId: string; role: string };

  const id = c.req.param("id");
  let sql = "SELECT id, filename, mime, kv_key, owner_id FROM contract_files WHERE id = ?";
  const params: string[] = [id];
  if (session.role !== "admin") { sql += " AND owner_id = ?"; params.push(session.userId); }
  const row = await c.env.DB.prepare(sql).bind(...params).first<{ filename: string; mime: string; kv_key: string }>();
  if (!row) return c.json({ error: "合同文件不存在" }, 404);

  const stored = await c.env.RESUMES.get(row.kv_key);
  if (!stored) return c.json({ error: "合同文件不存在" }, 404);

  const meta = JSON.parse(stored) as { data: string; name: string; type: string };
  const bytes = base64ToArrayBuffer(meta.data);

  const isDownload = c.req.query("download") === "1";
  const headers = new Headers();
  headers.set("Content-Type", meta.type || row.mime || "application/octet-stream");
  headers.set("Content-Disposition", `${isDownload ? "attachment" : "inline"}; filename="${encodeURIComponent(row.filename)}"`);
  return new Response(bytes, { headers });
});

// 删除合同文件（KV 本体 + D1 元数据一并清理）
talents.delete("/contracts/files/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  let sql = "SELECT id, kv_key FROM contract_files WHERE id = ?";
  const params: string[] = [id];
  if (session.role !== "admin") { sql += " AND owner_id = ?"; params.push(session.userId); }
  const row = await c.env.DB.prepare(sql).bind(...params).first<{ id: string; kv_key: string }>();
  if (!row) return c.json({ error: "合同文件不存在" }, 404);

  await c.env.RESUMES.delete(row.kv_key);
  await c.env.DB.prepare("DELETE FROM contract_files WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ---- 社保公积金台账 ----
// 清单口径：已入职 / 填了入职或离职日期 / 有参保记录 的人才（待办动作由前端按同规则推导）。
// 基数与比例只记录不校验——各地政策差异大，由用户按参保地自行填写。
talents.get("/social", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const q = (c.req.query("q") || "").trim();
  let sql = `
    SELECT t.id, t.name, t.phone, t.status, t.hire_date, t.resignation_date,
           s.si_status, s.si_city, s.si_base, s.hf_base,
           s.si_rate_personal, s.si_rate_company, s.hf_rate_personal, s.hf_rate_company
      FROM talents t LEFT JOIN talent_social s ON s.talent_id = t.id
     WHERE (t.status = 'placed' OR t.hire_date IS NOT NULL OR t.resignation_date IS NOT NULL OR s.id IS NOT NULL)`;
  const params: string[] = [];
  if (session.role !== "admin") { sql += ` AND t.owner_id = ?`; params.push(session.userId); }
  if (q) { sql += ` AND t.name LIKE ?`; params.push(`%${q}%`); }
  sql += ` LIMIT 500`;

  const rows = (await c.env.DB.prepare(sql).bind(...params).all<any>()).results;
  return c.json(rows);
});

// 编辑参保信息（upsert 一人一条），保存即同步增减员待办
talents.put("/social/:talentId", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const talentId = c.req.param("talentId");
  let checkSql = "SELECT id FROM talents WHERE id = ?";
  const checkParams: string[] = [talentId];
  if (session.role !== "admin") { checkSql += " AND owner_id = ?"; checkParams.push(session.userId); }
  const existing = await c.env.DB.prepare(checkSql).bind(...checkParams).first();
  if (!existing) return c.json({ error: "人才不存在" }, 404);

  const body = await c.req.json<any>();
  const num = (v: unknown) => (typeof v === "number" && !isNaN(v) ? v : null);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const siStatus = ["none", "active", "stopped"].includes(body.si_status) ? body.si_status : "none";

  const values = [
    siStatus, str(body.si_city), num(body.si_base), num(body.hf_base),
    num(body.si_rate_personal), num(body.si_rate_company), num(body.hf_rate_personal), num(body.hf_rate_company),
  ];

  await c.env.DB.prepare(
    `INSERT INTO talent_social (id, owner_id, talent_id, si_status, si_city, si_base, hf_base, si_rate_personal, si_rate_company, hf_rate_personal, hf_rate_company)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(talent_id) DO UPDATE SET
       si_status = excluded.si_status, si_city = excluded.si_city, si_base = excluded.si_base,
       hf_base = excluded.hf_base, si_rate_personal = excluded.si_rate_personal,
       si_rate_company = excluded.si_rate_company, hf_rate_personal = excluded.hf_rate_personal,
       hf_rate_company = excluded.hf_rate_company, updated_at = datetime('now')`
  ).bind(genId(), session.userId, talentId, ...values).run();

  // 台账变化 → 立即对齐增减员待办
  await syncSocialTasksForTalent(c.env.DB, talentId);
  return c.json({ ok: true });
});

// 增减员待办批量同步（幂等）：页面加载时自动调用 + 手动触发
talents.post("/social/sync-tasks", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const ownerCond = session.role !== "admin" ? " AND t.owner_id = ?" : "";
  const ownerParams: string[] = session.role !== "admin" ? [session.userId] : [];
  const talentsRows = (await c.env.DB.prepare(
    `SELECT t.id, t.owner_id, t.name, t.status, t.hire_date, t.resignation_date, s.si_status
       FROM talents t LEFT JOIN talent_social s ON s.talent_id = t.id
      WHERE (t.status = 'placed' OR t.hire_date IS NOT NULL OR t.resignation_date IS NOT NULL OR s.id IS NOT NULL)${ownerCond}
      LIMIT 500`
  ).bind(...ownerParams).all<SocialTalentRow>()).results;
  if (!talentsRows.length) return c.json({ checked: 0, created: 0, updated: 0, cancelled: 0 });

  const ids = talentsRows.map((t) => t.id);
  const placeholders = ids.map(() => "?").join(",");
  const tasksRows = (await c.env.DB.prepare(
    `SELECT id, talent_id, title, due_date FROM talent_tasks WHERE talent_id IN (${placeholders}) AND status = 'pending' AND (title LIKE '社保增员：%' OR title LIKE '社保减员：%')`
  ).bind(...ids).all<ExistingTask & { talent_id: string }>()).results;

  const byTalent: Record<string, ExistingTask[]> = {};
  for (const tk of tasksRows) (byTalent[tk.talent_id] ||= []).push(tk);

  const stmts: any[] = [];
  let created = 0, updated = 0, cancelled = 0;
  for (const t of talentsRows) {
    const r = socialTaskStmts(c.env.DB, t, byTalent[t.id] || []);
    stmts.push(...r.stmts);
    created += r.created; updated += r.updated; cancelled += r.cancelled;
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ checked: talentsRows.length, created, updated, cancelled });
});

// ---- 参保城市费率模板 ----
// 分层沿用模板库的思路：owner_id='system' 是内置参考值（所有人可读），
// 用户自己的同名城市覆盖参考值。这样「选城市自动带出比例」不用每次手填 4 个数字。
talents.get("/social/rates", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const rows = (await c.env.DB.prepare(
    `SELECT id, owner_id, city, si_rate_personal, si_rate_company, hf_rate_personal, hf_rate_company
       FROM social_rate_templates
      WHERE owner_id = 'system' OR owner_id = ?
      ORDER BY city, CASE WHEN owner_id = 'system' THEN 1 ELSE 0 END`
  ).bind(session.userId).all<any>()).results || [];

  // 同城去重：自己的排在系统参考值前面（上面的 ORDER BY 已保证），保留第一条
  const seen = new Set<string>();
  const list: any[] = [];
  for (const r of rows) {
    if (seen.has(r.city)) continue;
    seen.add(r.city);
    list.push({ ...r, is_system: r.owner_id === "system" });
  }
  return c.json(list);
});

// 新增 / 覆盖自己城市下的默认比例（同名城市 upsert）
talents.post("/social/rates", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const body = await c.req.json<any>().catch(() => null);
  const city = typeof body?.city === "string" ? body.city.trim() : "";
  if (!city) return c.json({ error: "请填写参保城市" }, 400);
  if (city.length > 40) return c.json({ error: "城市名称过长" }, 400);

  const num = (v: unknown) => (typeof v === "number" && !isNaN(v) ? v : null);
  const vals = [
    num(body.si_rate_personal), num(body.si_rate_company),
    num(body.hf_rate_personal), num(body.hf_rate_company),
  ];

  await c.env.DB.prepare(
    `INSERT INTO social_rate_templates (id, owner_id, city, si_rate_personal, si_rate_company, hf_rate_personal, hf_rate_company)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, city) DO UPDATE SET
       si_rate_personal = excluded.si_rate_personal, si_rate_company = excluded.si_rate_company,
       hf_rate_personal = excluded.hf_rate_personal, hf_rate_company = excluded.hf_rate_company,
       updated_at = datetime('now')`
  ).bind(genId(), session.userId, city, ...vals).run();

  return c.json({ ok: true, city });
});

// 删除自己维护的模板（系统内置参考值不允许删，只能用自己的同名城市覆盖）
talents.delete("/social/rates/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  const r = await c.env.DB.prepare(
    "DELETE FROM social_rate_templates WHERE id = ? AND owner_id = ?"
  ).bind(id, session.userId).run();
  if (!r.success || (r.meta?.changes ?? 0) === 0) {
    return c.json({ error: "模板不存在，或内置参考值不可删除（可用同名城市覆盖）" }, 404);
  }
  return c.json({ ok: true });
});

// ---- 人才详情（聚合：本体 + 相关待办 + 投递进程 + 阶段日志）----
// ---- 批量打标签：收人才 id，replace=直接设 / add=合并去重 ----
// 静态路由须注册在 GET /:id 之前。一次最多 200 人。
talents.post("/batch/tags", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const body = await c.req.json<{ ids?: string[]; tags?: string[]; mode?: "replace" | "add" }>();
  const ids = [...new Set((body.ids || []).filter(Boolean))];
  const tags = (body.tags || []).filter(Boolean);
  if (ids.length === 0) return c.json({ error: "请选择人才" }, 400);
  if (ids.length > 200) return c.json({ error: "一次最多批量操作 200 人" }, 400);
  const mode = body.mode === "add" ? "add" : "replace";

  const ph = ids.map(() => "?").join(",");
  const rows = await c.env.DB.prepare(`SELECT id, owner_id, tags FROM talents WHERE id IN (${ph})`).bind(...ids).all<any>();
  const targets = (rows.results as any[]).filter((r) => session.role === "admin" || r.owner_id === session.userId);
  const stmts = targets.map((r) => {
    const cur = r.tags ? JSON.parse(r.tags) : [];
    const next = mode === "add" ? [...new Set([...cur, ...tags])] : tags;
    return c.env.DB.prepare("UPDATE talents SET tags = ?, updated_at = datetime('now') WHERE id = ?").bind(JSON.stringify(next), r.id);
  });
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ updated: targets.length, skipped: ids.length - targets.length });
});

// ---- 批量删除：复用单删的级联清理（顺序反了会触发外键 500）----
talents.post("/batch/delete", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const body = await c.req.json<{ ids?: string[] }>();
  const ids = [...new Set((body.ids || []).filter(Boolean))];
  if (ids.length === 0) return c.json({ error: "请选择人才" }, 400);
  if (ids.length > 200) return c.json({ error: "一次最多批量操作 200 人" }, 400);

  let deleted = 0;
  for (const id of ids) {
    let checkSql = "SELECT id, resume_url FROM talents WHERE id = ?";
    const checkParams: string[] = [id];
    if (session.role !== "admin") { checkSql += " AND owner_id = ?"; checkParams.push(session.userId); }
    const existing = await c.env.DB.prepare(checkSql).bind(...checkParams).first<{ id: string; resume_url: string | null }>();
    if (!existing) continue;
    if (existing.resume_url) await c.env.RESUMES.delete(existing.resume_url);
    const contractFileKeys = (await c.env.DB.prepare("SELECT kv_key FROM contract_files WHERE talent_id = ?").bind(id).all<{ kv_key: string }>()).results;
    for (const f of contractFileKeys) await c.env.RESUMES.delete(f.kv_key);
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM job_stage_logs WHERE talent_job_id IN (SELECT id FROM talent_jobs WHERE talent_id = ?)").bind(id),
      c.env.DB.prepare("DELETE FROM talent_jobs WHERE talent_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM communications WHERE talent_id = ?").bind(id),
      c.env.DB.prepare("UPDATE talent_tasks SET talent_id = NULL WHERE talent_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM contract_files WHERE talent_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM talent_social WHERE talent_id = ?").bind(id),
      c.env.DB.prepare("DELETE FROM talents WHERE id = ?").bind(id),
    ]);
    deleted++;
  }
  return c.json({ deleted });
});

// ---- 批量推进阶段：收人才 id，内部查其 talent_jobs 逐个推进 + 写阶段日志 ----
// 复用 syncTalentStage 重算全局阶段（记忆约束：别手写派生缓存）；推进到 hired 时
// 与单卡流转一致地写入「试用期跟进」待办。无招聘流程（无 talent_jobs）的纯人才跳过。
talents.post("/batch/stage", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const body = await c.req.json<{ ids?: string[]; stage?: string }>();
  const ids = [...new Set((body.ids || []).filter(Boolean))];
  const stage = body.stage || "";
  if (ids.length === 0 || !(STAGES as readonly string[]).includes(stage)) return c.json({ error: "参数不合法" }, 400);
  if (ids.length > 200) return c.json({ error: "一次最多批量操作 200 人" }, 400);

  const ph = ids.map(() => "?").join(",");
  const links = (await c.env.DB.prepare(
    `SELECT tj.id, tj.stage as old_stage, tj.talent_id, tj.job_id, t.name as talent_name, t.owner_id
     FROM talent_jobs tj JOIN talents t ON tj.talent_id = t.id WHERE tj.talent_id IN (${ph})`
  ).bind(...ids).all<any>()).results as any[];
  const allowed = links.filter((r: any) => session.role === "admin" || r.owner_id === session.userId);
  const talentIdsWithJob = [...new Set(allowed.map((r: any) => r.talent_id))];
  const skipped = ids.length - talentIdsWithJob.length;

  const stmts: any[] = [];
  const hiredLinks: any[] = [];
  for (const r of allowed) {
    if (r.old_stage === stage) continue; // 已在目标阶段，不重复写日志
    stmts.push(c.env.DB.prepare("UPDATE talent_jobs SET stage = ?, updated_at = datetime('now') WHERE id = ?").bind(stage, r.id));
    stmts.push(c.env.DB.prepare(
      "INSERT INTO job_stage_logs (id, talent_job_id, from_stage, to_stage, user_id, remark) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(genId(), r.id, r.old_stage, stage, session.userId, "批量推进"));
    if (stage === "hired") hiredLinks.push(r);
  }
  if (stmts.length) await c.env.DB.batch(stmts);

  // hired 联动：与单卡流转一致的「试用期跟进」待办（防重）
  for (const h of hiredLinks) {
    const dup = await c.env.DB.prepare(
      "SELECT id FROM talent_tasks WHERE talent_id = ? AND status = 'pending' AND title LIKE '试用期跟进%'"
    ).bind(h.talent_id).first();
    if (!dup) {
      const due = new Date(Date.now() + 90 * 86400000);
      const p = (n: number) => String(n).padStart(2, "0");
      await c.env.DB.prepare(
        "INSERT INTO talent_tasks (id, owner_id, talent_id, job_id, title, content, due_date, priority, status, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'normal', 'pending', 'system')"
      ).bind(
        genId(), h.owner_id, h.talent_id, h.job_id,
        `试用期跟进：${h.talent_name}`,
        "候选人已入职，关注试用期表现与融入情况，到期前完成转正评估。",
        `${due.getFullYear()}-${p(due.getMonth() + 1)}-${p(due.getDate())}`
      ).run();
    }
  }

  for (const tid of talentIdsWithJob) await syncTalentStage(c.env.DB, tid);

  return c.json({ updated: talentIdsWithJob.length, skipped });
});

talents.get("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  let sql = "SELECT t.*, u.name as owner_name FROM talents t JOIN users u ON t.owner_id = u.id WHERE t.id = ?";
  const params: string[] = [id];
  if (session.role !== "admin") { sql += " AND t.owner_id = ?"; params.push(session.userId); }

  const row = await c.env.DB.prepare(sql).bind(...params).first();
  if (!row) return c.json({ error: "人才不存在" }, 404);

  // 相关待办：待办属于创建人，非管理员只看自己创建的；管理员看该人才关联的全部。
  // 已取消的不展示；待办中在前（打勾不往后翻），组内按到期日升序、无到期日靠后。
  let taskSql =
    "SELECT k.*, k2.name as owner_name FROM talent_tasks k JOIN users k2 ON k.owner_id = k2.id WHERE k.talent_id = ? AND k.status != 'cancelled'";
  const taskParams: string[] = [id];
  if (session.role !== "admin") { taskSql += " AND k.owner_id = ?"; taskParams.push(session.userId); }
  taskSql += " ORDER BY k.status = 'done' ASC, k.due_date IS NULL, k.due_date ASC LIMIT 50";
  const tasks = (await c.env.DB.prepare(taskSql).bind(...taskParams).all()).results;

  // 投递进程：人才本体已做过归属校验，其投递记录随人才可见（与 pipeline 路由口径一致）
  const pipeline = (
    await c.env.DB.prepare(
      `SELECT tj.id, tj.job_id, tj.stage, tj.rating, tj.notes, tj.created_at, tj.updated_at,
              j.title as job_title, j.department as job_department, j.city as job_city
         FROM talent_jobs tj JOIN jobs j ON tj.job_id = j.id
        WHERE tj.talent_id = ? ORDER BY tj.updated_at DESC`
    ).bind(id).all()
  ).results;

  // 阶段流转日志：覆盖该人才全部投递，按时间正序，前端按投递分组
  const stageLogs = (
    await c.env.DB.prepare(
      `SELECT l.id, l.talent_job_id, l.from_stage, l.to_stage, l.remark, l.created_at,
              u.name as user_name
         FROM job_stage_logs l LEFT JOIN users u ON l.user_id = u.id
        WHERE l.talent_job_id IN (SELECT id FROM talent_jobs WHERE talent_id = ?)
        ORDER BY l.created_at ASC`
    ).bind(id).all()
  ).results;

  return c.json({
    ...(row as any),
    skills: (row as any).skills ? JSON.parse((row as any).skills) : [],
    tags: (row as any).tags ? JSON.parse((row as any).tags) : [],
    tasks,
    pipeline,
    stage_logs: stageLogs,
  });
});

// ---- 新增人才 ----
talents.post("/", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const body = await c.req.json<any>();
  const id = genId();
  const skills = body.skills ? JSON.stringify(body.skills) : null;
  const tags = body.tags ? JSON.stringify(body.tags) : null;
  await c.env.DB.prepare(`INSERT INTO talents (id, owner_id, name, phone, email, age, gender, education, school, current_company, current_title, years_experience, city, skills, tags, industry, expected_salary, expected_city, status, source, resume_url, notes, birth_date, contract_end, probation_end, resignation_date, hire_date, next_follow_at, entry_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, session.userId, body.name || "", body.phone || null, body.email || null, body.age ?? null, body.gender || null, body.education || null, body.school || null, body.current_company || null, body.current_title || null, body.years_experience || null, body.city || null, skills, tags, body.industry || null, body.expected_salary || null, body.expected_city || null, body.status || "active", body.source || null, body.resume_url || null, body.notes || null, dateOrNull(body.birth_date), dateOrNull(body.contract_end), dateOrNull(body.probation_end), dateOrNull(body.resignation_date), dateOrNull(body.hire_date), dateOrNull(body.next_follow_at), normalizeEntryType(body.entry_type)).run();

  return c.json({ id, ...body });
});

// ---- 编辑人才 ----
talents.put("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  let checkSql = "SELECT id FROM talents WHERE id = ?";
  const checkParams: string[] = [id];
  if (session.role !== "admin") { checkSql += " AND owner_id = ?"; checkParams.push(session.userId); }
  const existing = await c.env.DB.prepare(checkSql).bind(...checkParams).first();
  if (!existing) return c.json({ error: "人才不存在" }, 404);

  const body = await c.req.json<any>();
  const skills = body.skills ? JSON.stringify(body.skills) : null;
  // 日期字段动态拼 SET：传了才更新（含清空 ""→NULL），未传保持原值——COALESCE 无法区分这两种情况
  const dateFields = ["birth_date", "contract_end", "probation_end", "resignation_date", "hire_date", "next_follow_at"] as const;
  let dateSet = "";
  const dateParams: (string | null)[] = [];
  for (const f of dateFields) {
    if (body[f] !== undefined) {
      dateSet += `, ${f} = ?`;
      dateParams.push(body[f] || null);
    }
  }
  // D1 的 .bind() 不接受 undefined，必须归一化为 null，否则编辑时任意空字段都会 500。
  // 标量字段统一走 undefined → null 转换（name 为 NOT NULL，前端编辑时必传，不会是 null）。
  const scalars: (string | number | null)[] = [
    body.name, body.phone, body.email, body.age, body.gender, body.education,
    body.school, body.current_company, body.current_title, body.years_experience,
    body.city, skills, body.tags ? JSON.stringify(body.tags) : null, body.industry, body.expected_salary, body.expected_city,
    body.status, body.source, body.resume_url, body.notes,
  ].map((v) => (v === undefined ? null : v));
  await c.env.DB.prepare(`UPDATE talents SET name = COALESCE(?, name), phone = COALESCE(?, phone), email = COALESCE(?, email), age = COALESCE(?, age), gender = COALESCE(?, gender), education = COALESCE(?, education), school = COALESCE(?, school), current_company = COALESCE(?, current_company), current_title = COALESCE(?, current_title), years_experience = COALESCE(?, years_experience), city = COALESCE(?, city), skills = COALESCE(?, skills), industry = COALESCE(?, industry), expected_salary = COALESCE(?, expected_salary), expected_city = COALESCE(?, expected_city), status = COALESCE(?, status), source = COALESCE(?, source), resume_url = COALESCE(?, resume_url), notes = COALESCE(?, notes)${dateSet}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...scalars, ...dateParams, id).run();

  // 合同/试用期日期有变更（含清空）→ 立即同步到期提醒待办
  if (body.contract_end !== undefined || body.probation_end !== undefined) {
    const t = await c.env.DB.prepare(`SELECT id, owner_id, name, contract_end, probation_end FROM talents WHERE id = ?`).bind(id).first<TalentContractRow>();
    if (t) {
      const tasks = await c.env.DB.prepare(`SELECT id, title, due_date FROM talent_tasks WHERE talent_id = ? AND status = 'pending' AND (title LIKE '合同到期：%' OR title LIKE '试用期到期：%')`).bind(id).all<ExistingTask>();
      const { stmts } = contractTaskStmts(c.env.DB, t, tasks.results || []);
      if (stmts.length) await c.env.DB.batch(stmts);
    }
  }

  // 入职日期/离职日期/在职状态有变更 → 立即同步社保增减员待办
  if (body.hire_date !== undefined || body.resignation_date !== undefined || body.status !== undefined) {
    await syncSocialTasksForTalent(c.env.DB, id);
  }

  return c.json({ id, ...body });
});

// ---- 删除人才 ----
talents.delete("/:id", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  let checkSql = "SELECT id, resume_url FROM talents WHERE id = ?";
  const checkParams: string[] = [id];
  if (session.role !== "admin") { checkSql += " AND owner_id = ?"; checkParams.push(session.userId); }
  const existing = await c.env.DB.prepare(checkSql).bind(...checkParams).first<{ id: string; resume_url: string | null }>();
  if (!existing) return c.json({ error: "人才不存在" }, 404);

  // 顺带清理 KV 中的简历文件
  if (existing.resume_url) await c.env.RESUMES.delete(existing.resume_url);

  // 顺带清理 KV 中的合同文件本体（元数据在下面 batch 里删）
  const contractFileKeys = (await c.env.DB.prepare(
    "SELECT kv_key FROM contract_files WHERE talent_id = ?"
  ).bind(id).all<{ kv_key: string }>()).results;
  for (const f of contractFileKeys) await c.env.RESUMES.delete(f.kv_key);

  // 先清所有关联数据，再删人才本体。
  // talents 被 talent_jobs / talent_tasks / communications 三张表外键引用，
  // 顺序反了（或漏清某张表）会触发外键约束直接 500。
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM job_stage_logs WHERE talent_job_id IN (SELECT id FROM talent_jobs WHERE talent_id = ?)").bind(id),
    c.env.DB.prepare("DELETE FROM talent_jobs WHERE talent_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM communications WHERE talent_id = ?").bind(id),
    // 待办属于用户，不静默删除，只解除与人才的关联
    c.env.DB.prepare("UPDATE talent_tasks SET talent_id = NULL WHERE talent_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM contract_files WHERE talent_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM talent_social WHERE talent_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM talents WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

// ---- 删除简历文件（保留人才记录）----
talents.delete("/:id/resume", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const id = c.req.param("id");
  let checkSql = "SELECT id, resume_url FROM talents WHERE id = ?";
  const checkParams: string[] = [id];
  if (session.role !== "admin") { checkSql += " AND owner_id = ?"; checkParams.push(session.userId); }
  const existing = await c.env.DB.prepare(checkSql).bind(...checkParams).first<{ id: string; resume_url: string | null }>();
  if (!existing) return c.json({ error: "人才不存在" }, 404);
  if (!existing.resume_url) return c.json({ error: "无简历文件" }, 404);

  await c.env.RESUMES.delete(existing.resume_url);
  await c.env.DB.prepare("UPDATE talents SET resume_url = NULL, updated_at = datetime('now') WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ---- 上传简历文件 ----
// multipart/form-data: file + talent_id
talents.post("/resume", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const formData = await c.req.formData();
  const file = formData.get("file") as File;
  const talentId = formData.get("talent_id") as string;
  if (!file || !talentId) return c.json({ error: "缺少文件或人才ID" }, 400);

  // 权限检查
  let checkSql = "SELECT id FROM talents WHERE id = ?";
  const checkParams: string[] = [talentId];
  if (session.role !== "admin") { checkSql += " AND owner_id = ?"; checkParams.push(session.userId); }
  const existing = await c.env.DB.prepare(checkSql).bind(...checkParams).first();
  if (!existing) return c.json({ error: "人才不存在" }, 404);

  // 文件大小限制：KV 单值上限 25MB
  if (file.size > 25 * 1024 * 1024) return c.json({ error: "文件过大，最大支持 25MB" }, 400);

  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  const key = `resume:${talentId}:${crypto.randomUUID()}.${ext}`;
  const buf = await file.arrayBuffer();

  // 存储文件内容（base64）+ 元信息（文件名、类型）
  const base64 = arrayBufferToBase64(buf);
  await c.env.RESUMES.put(key, JSON.stringify({
    data: base64,
    name: file.name,
    type: file.type || (ext === "pdf" ? "application/pdf" : "application/octet-stream"),
  }));

  // 更新 resume_url 字段（存 KV key）
  await c.env.DB.prepare("UPDATE talents SET resume_url = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(key, talentId).run();

  return c.json({ resume_url: key });
});

// ---- 获取简历文件（用于预览/下载）----
talents.get("/:id/resume", async (c) => {
  // 支持 query param token（用于 iframe 预览）
  const token = c.req.query("token") || getCookie(c, "token") || c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return c.json({ error: "未登录" }, 401);
  const sessionStr = await c.env.SESSIONS.get(token);
  if (!sessionStr) return c.json({ error: "未登录" }, 401);
  const session = JSON.parse(sessionStr);

  const id = c.req.param("id");
  let sql = "SELECT resume_url, owner_id FROM talents WHERE id = ?";
  const params: string[] = [id];
  if (session.role !== "admin") { sql += " AND owner_id = ?"; params.push(session.userId); }
  const row = await c.env.DB.prepare(sql).bind(...params).first<{ resume_url: string | null; owner_id: string }>();
  if (!row) return c.json({ error: "人才不存在" }, 404);
  if (!row.resume_url) return c.json({ error: "无简历文件" }, 404);

  const stored = await c.env.RESUMES.get(row.resume_url);
  if (!stored) return c.json({ error: "简历文件不存在" }, 404);

  const meta = JSON.parse(stored);
  const bytes = base64ToArrayBuffer(meta.data);

  const isDownload = c.req.query("download") === "1";
  const filename = meta.name || "resume";
  const headers = new Headers();
  headers.set("Content-Type", meta.type || "application/octet-stream");
  headers.set("Content-Disposition", `${isDownload ? "attachment" : "inline"}; filename="${encodeURIComponent(filename)}"`);
  return new Response(bytes, { headers });
});

// ---- 批量导入 ----
talents.post("/import", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);

  const items = await c.req.json<any[]>();
  let count = 0;
  const created: { id: string; name: string }[] = [];
  for (const item of items) {
    const id = genId();
    const skills = item.skills ? JSON.stringify(item.skills) : null;
    await c.env.DB.prepare(`INSERT INTO talents (id, owner_id, name, phone, email, age, gender, education, school, current_company, current_title, years_experience, city, skills, industry, expected_salary, expected_city, status, source, resume_url, notes, birth_date, contract_end, probation_end, resignation_date, entry_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, session.userId, item.name || "", item.phone || null, item.email || null, item.age ?? null, item.gender || null, item.education || null, item.school || null, item.current_company || null, item.current_title || null, item.years_experience || null, item.city || null, skills, item.industry || null, item.expected_salary || null, item.expected_city || null, item.status || "active", item.source || null, item.resume_url || null, item.notes || null, dateOrNull(item.birth_date), dateOrNull(item.contract_end), dateOrNull(item.probation_end), dateOrNull(item.resignation_date), normalizeEntryType(item.entry_type, "import")).run();
    count++;
    created.push({ id, name: item.name || "" });
  }
  return c.json({ imported: count, items: created });
});

export { talents as talentRoutes };
