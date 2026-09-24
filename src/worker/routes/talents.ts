import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../index";
import { getSession } from "./auth";
import { genId } from "../helpers";

const talents = new Hono<{ Bindings: Env }>();

/** 日期字段只接受 YYYY-MM-DD（或带时间的 ISO），其余一律置 NULL，避免脏数据入库。
 *  新增与批量导入共用，别在两处各写一份。 */
function dateOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
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
  if (status) { conditions.push("t.status = ?"); params.push(status); }
  if (city) { conditions.push("t.city LIKE ?"); params.push(`%${city}%`); }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  const countResult = await c.env.DB.prepare(`SELECT COUNT(*) as total FROM talents t ${where}`).bind(...params).first<{ total: number }>();
  const rows = await c.env.DB.prepare(`SELECT t.*, u.name as owner_name FROM talents t JOIN users u ON t.owner_id = u.id ${where} ORDER BY t.updated_at DESC LIMIT ? OFFSET ?`).bind(...params, limit, offset).all();

  const items = rows.results.map((r: any) => ({
    ...r, skills: r.skills ? JSON.parse(r.skills) : [],
  }));

  return c.json({ items, total: countResult?.total || 0, page, limit, pages: Math.ceil((countResult?.total || 0) / limit) });
});

// ---- 人才详情（聚合：本体 + 相关待办 + 投递进程 + 阶段日志）----
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
  await c.env.DB.prepare(`INSERT INTO talents (id, owner_id, name, phone, email, age, gender, education, school, current_company, current_title, years_experience, city, skills, industry, expected_salary, expected_city, status, resume_url, notes, birth_date, contract_end, probation_end, resignation_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, session.userId, body.name || "", body.phone || null, body.email || null, body.age ?? null, body.gender || null, body.education || null, body.school || null, body.current_company || null, body.current_title || null, body.years_experience || null, body.city || null, skills, body.industry || null, body.expected_salary || null, body.expected_city || null, body.status || "active", body.resume_url || null, body.notes || null, dateOrNull(body.birth_date), dateOrNull(body.contract_end), dateOrNull(body.probation_end), dateOrNull(body.resignation_date)).run();

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
  const dateFields = ["birth_date", "contract_end", "probation_end", "resignation_date"] as const;
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
    body.city, skills, body.industry, body.expected_salary, body.expected_city,
    body.status, body.resume_url, body.notes,
  ].map((v) => (v === undefined ? null : v));
  await c.env.DB.prepare(`UPDATE talents SET name = COALESCE(?, name), phone = COALESCE(?, phone), email = COALESCE(?, email), age = COALESCE(?, age), gender = COALESCE(?, gender), education = COALESCE(?, education), school = COALESCE(?, school), current_company = COALESCE(?, current_company), current_title = COALESCE(?, current_title), years_experience = COALESCE(?, years_experience), city = COALESCE(?, city), skills = COALESCE(?, skills), industry = COALESCE(?, industry), expected_salary = COALESCE(?, expected_salary), expected_city = COALESCE(?, expected_city), status = COALESCE(?, status), resume_url = COALESCE(?, resume_url), notes = COALESCE(?, notes)${dateSet}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...scalars, ...dateParams, id).run();

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

  // 先清所有关联数据，再删人才本体。
  // talents 被 talent_jobs / talent_tasks / communications 三张表外键引用，
  // 顺序反了（或漏清某张表）会触发外键约束直接 500。
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM job_stage_logs WHERE talent_job_id IN (SELECT id FROM talent_jobs WHERE talent_id = ?)").bind(id),
    c.env.DB.prepare("DELETE FROM talent_jobs WHERE talent_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM communications WHERE talent_id = ?").bind(id),
    // 待办属于用户，不静默删除，只解除与人才的关联
    c.env.DB.prepare("UPDATE talent_tasks SET talent_id = NULL WHERE talent_id = ?").bind(id),
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
    await c.env.DB.prepare(`INSERT INTO talents (id, owner_id, name, phone, email, age, gender, education, school, current_company, current_title, years_experience, city, skills, industry, expected_salary, expected_city, status, resume_url, notes, birth_date, contract_end, probation_end, resignation_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, session.userId, item.name || "", item.phone || null, item.email || null, item.age ?? null, item.gender || null, item.education || null, item.school || null, item.current_company || null, item.current_title || null, item.years_experience || null, item.city || null, skills, item.industry || null, item.expected_salary || null, item.expected_city || null, item.status || "active", item.resume_url || null, item.notes || null, dateOrNull(item.birth_date), dateOrNull(item.contract_end), dateOrNull(item.probation_end), dateOrNull(item.resignation_date)).run();
    count++;
    created.push({ id, name: item.name || "" });
  }
  return c.json({ imported: count, items: created });
});

export { talents as talentRoutes };
