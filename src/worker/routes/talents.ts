import { Hono } from "hono";
import type { Env } from "../index";
import { getUserId } from "./auth";

const talents = new Hono<{ Bindings: Env }>();

function genId(): string { return crypto.randomUUID(); }

talents.get("/", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: "未登录" }, 401);

  const q = (c.req.query("q") || "").trim();
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  const status = c.req.query("status");
  const city = c.req.query("city");
  const tagId = c.req.query("tag_id");

  const offset = (page - 1) * limit;
  const conditions: string[] = ["t.owner_id = ?"];
  const params: (string | number)[] = [userId];

  if (q) {
    conditions.push("(t.name LIKE ? OR t.current_company LIKE ? OR t.current_title LIKE ? OR t.skills LIKE ? OR t.industry LIKE ? OR t.notes LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }
  if (status) { conditions.push("t.status = ?"); params.push(status); }
  if (city) { conditions.push("t.city LIKE ?"); params.push(`%${city}%`); }
  if (tagId) { conditions.push("t.id IN (SELECT talent_id FROM talent_tags WHERE tag_id = ?)"); params.push(tagId); }

  const where = conditions.join(" AND ");
  const countResult = await c.env.DB.prepare(`SELECT COUNT(*) as total FROM talents t WHERE ${where}`).bind(...params).first<{ total: number }>();
  const rows = await c.env.DB.prepare(`SELECT t.* FROM talents t WHERE ${where} ORDER BY t.updated_at DESC LIMIT ? OFFSET ?`).bind(...params, limit, offset).all();

  const talentIds = rows.results.map((r: any) => r.id);
  let tagsMap: Record<string, any[]> = {};
  if (talentIds.length > 0) {
    const placeholders = talentIds.map(() => "?").join(",");
    const tagRows = await c.env.DB.prepare(`SELECT tt.talent_id, t.id as tag_id, t.name, t.color FROM talent_tags tt JOIN tags t ON tt.tag_id = t.id WHERE tt.talent_id IN (${placeholders})`).bind(...talentIds).all();
    for (const tr of tagRows.results as any[]) {
      if (!tagsMap[tr.talent_id]) tagsMap[tr.talent_id] = [];
      tagsMap[tr.talent_id].push({ id: tr.tag_id, name: tr.name, color: tr.color });
    }
  }

  const items = rows.results.map((r: any) => ({
    ...r, skills: r.skills ? JSON.parse(r.skills) : [], tags: tagsMap[r.id] || [],
  }));

  return c.json({ items, total: countResult?.total || 0, page, limit, pages: Math.ceil((countResult?.total || 0) / limit) });
});

talents.get("/:id", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT * FROM talents WHERE id = ? AND owner_id = ?").bind(id, userId).first();
  if (!row) return c.json({ error: "人才不存在" }, 404);
  const tagRows = await c.env.DB.prepare(`SELECT t.id, t.name, t.color FROM talent_tags tt JOIN tags t ON tt.tag_id = t.id WHERE tt.talent_id = ?`).bind(id).all();
  return c.json({ ...(row as any), skills: (row as any).skills ? JSON.parse((row as any).skills) : [], tags: tagRows.results });
});

talents.post("/", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const body = await c.req.json<any>();
  const id = genId();
  const skills = body.skills ? JSON.stringify(body.skills) : null;
  await c.env.DB.prepare(`INSERT INTO talents (id, owner_id, name, phone, email, current_company, current_title, years_experience, city, skills, industry, expected_salary, expected_city, status, resume_url, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, userId, body.name || "", body.phone || null, body.email || null, body.current_company || null, body.current_title || null, body.years_experience || null, body.city || null, skills, body.industry || null, body.expected_salary || null, body.expected_city || null, body.status || "active", body.resume_url || null, body.notes || null).run();
  if (body.tag_ids && body.tag_ids.length > 0) {
    for (const tagId of body.tag_ids) {
      await c.env.DB.prepare("INSERT OR IGNORE INTO talent_tags (talent_id, tag_id) VALUES (?, ?)").bind(id, tagId).run();
    }
  }
  return c.json({ id, ...body });
});

talents.put("/:id", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  const body = await c.req.json<any>();
  const existing = await c.env.DB.prepare("SELECT id FROM talents WHERE id = ? AND owner_id = ?").bind(id, userId).first();
  if (!existing) return c.json({ error: "人才不存在" }, 404);
  const skills = body.skills ? JSON.stringify(body.skills) : undefined;
  await c.env.DB.prepare(`UPDATE talents SET name = COALESCE(?, name), phone = COALESCE(?, phone), email = COALESCE(?, email), current_company = COALESCE(?, current_company), current_title = COALESCE(?, current_title), years_experience = COALESCE(?, years_experience), city = COALESCE(?, city), skills = COALESCE(?, skills), industry = COALESCE(?, industry), expected_salary = COALESCE(?, expected_salary), expected_city = COALESCE(?, expected_city), status = COALESCE(?, status), resume_url = COALESCE(?, resume_url), notes = COALESCE(?, notes), updated_at = datetime('now') WHERE id = ? AND owner_id = ?`).bind(body.name, body.phone, body.email, body.current_company, body.current_title, body.years_experience, body.city, skills, body.industry, body.expected_salary, body.expected_city, body.status, body.resume_url, body.notes, id, userId).run();
  if (body.tag_ids !== undefined) {
    await c.env.DB.prepare("DELETE FROM talent_tags WHERE talent_id = ?").bind(id).run();
    for (const tagId of body.tag_ids) {
      await c.env.DB.prepare("INSERT OR IGNORE INTO talent_tags (talent_id, tag_id) VALUES (?, ?)").bind(id, tagId).run();
    }
  }
  return c.json({ id, ...body });
});

talents.delete("/:id", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM talents WHERE id = ? AND owner_id = ?").bind(id, userId).run();
  await c.env.DB.prepare("DELETE FROM talent_tags WHERE talent_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM communications WHERE talent_id = ?").bind(id).run();
  return c.json({ ok: true });
});

talents.post("/import", async (c) => {
  const userId = await getUserId(c);
  if (!userId) return c.json({ error: "未登录" }, 401);
  const items = await c.req.json<any[]>();
  let count = 0;
  for (const item of items) {
    const id = genId();
    const skills = item.skills ? JSON.stringify(item.skills) : null;
    await c.env.DB.prepare(`INSERT INTO talents (id, owner_id, name, phone, email, current_company, current_title, years_experience, city, skills, industry, expected_salary, expected_city, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, userId, item.name || "", item.phone || null, item.email || null, item.current_company || null, item.current_title || null, item.years_experience || null, item.city || null, skills, item.industry || null, item.expected_salary || null, item.expected_city || null, item.status || "active").run();
    count++;
  }
  return c.json({ imported: count });
});

export { talents as talentRoutes };
