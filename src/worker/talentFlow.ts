/**
 * 招聘链路联动模块：把「阶段推进」及其副作用收成一处，供看板 / 面试 / 审批 / 入职复用。
 *
 * 收敛这里的原因：阶段推进不只是改 talent_jobs.stage，还牵动
 *   ① job_stage_logs 阶段日志（漏斗「曾到达」口径的唯一真源）
 *   ② talents.stage / status / hire_date 派生缓存（syncTalentStage）
 *   ③ 推进到 hired 时：试用期跟进待办 + 入职材料清单自动生成
 * 之前这几件事散落在看板各种入口里，审批通过 / 面试通过这类「系统自动推进」
 * 就没有任何联动，链路是断的。
 */
import { genId } from "./helpers";

export type Stage =
  | "screening" | "interview1" | "interview2" | "offer" | "hired" | "rejected" | "withdrawn";

/** 正向推进顺序（终态不参与排序） */
export const PROGRESS_ORDER: Stage[] = ["screening", "interview1", "interview2", "offer", "hired"];

const TERMINAL: Stage[] = ["hired", "rejected", "withdrawn"];

function todayCn(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/** 生成 YYYY-MM-DD（本地时区） */
function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 同步人才全局阶段 talents.stage —— 该字段是冗余缓存，唯一真源是 talent_jobs.stage
 * （一个人在不同岗位可以处于不同阶段，全局阶段表示「整体推进到哪一步」）。
 * 规则：任一投递已入职 → hired 且 status='placed'，同时补上入职日期；否则取所有进行中投递里最靠前的阶段；
 *      全部为终态（淘汰/放弃）→ archived。任何阶段变更后调用，避免出现「A 岗位已入职、
 *      全局却还是初试」这类双轨不一致。
 */
export async function syncTalentStage(db: D1Database, talentId: string): Promise<void> {
  const rows = await db.prepare("SELECT stage FROM talent_jobs WHERE talent_id = ?")
    .bind(talentId).all<{ stage: string }>();
  const stages = ((rows.results || []) as { stage: string }[]).map((r) => r.stage);
  if (stages.length === 0) return;

  if (stages.includes("hired")) {
    // 入职日期在这里兜底写入：社保模块靠 hire_date 判断「谁该办增员」。
    // 用 COALESCE 保证不覆盖 HR 手工填的真实入职日期（补录历史数据时很常见）。
    await db.prepare(
      "UPDATE talents SET stage = 'hired', status = 'placed', hire_date = COALESCE(hire_date, ?), updated_at = datetime('now') WHERE id = ?"
    ).bind(todayCn(), talentId).run();
    return;
  }

  const active = stages.filter((s) => (PROGRESS_ORDER as string[]).includes(s));
  if (active.length === 0) {
    // 全部终态（淘汰 / 放弃）：回到人才库待激活状态
    await db.prepare("UPDATE talents SET stage = 'archived', updated_at = datetime('now') WHERE id = ?")
      .bind(talentId).run();
    return;
  }

  const furthest = active.reduce((a, b) =>
    PROGRESS_ORDER.indexOf(b as Stage) > PROGRESS_ORDER.indexOf(a as Stage) ? b : a);
  await db.prepare("UPDATE talents SET stage = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(furthest, talentId).run();
}

/** 默认入职材料模板（用户可增删改，这里只作首次自动生成的初稿） */
export const DEFAULT_ONBOARDING_ITEMS: { name: string; category: string; required: number }[] = [
  { name: "身份证正反面复印件", category: "身份材料", required: 1 },
  { name: "学历学位证书", category: "身份材料", required: 1 },
  { name: "离职证明", category: "身份材料", required: 0 },
  { name: "银行卡信息（工资卡）", category: "财务材料", required: 1 },
  { name: "薪资确认单（已签字）", category: "财务材料", required: 1 },
  { name: "劳动合同", category: "合同材料", required: 1 },
  { name: "入职体检报告", category: "公司材料", required: 0 },
  { name: "社保 / 公积金开户信息", category: "公司材料", required: 0 },
];

/**
 * 确保某条投递已有入职材料清单（幂等）：已存在则跳过，返回本次新建条数。
 * 被「推进到已入职」和「审批通过」两处复用 —— 这是入职办理能被自动触发的关键。
 */
export async function ensureOnboardingItems(
  db: D1Database,
  opts: { ownerId: string; talentId: string; talentJobId?: string | null }
): Promise<number> {
  const exist = await db.prepare(
    "SELECT COUNT(*) as n FROM onboarding_items WHERE talent_id = ? AND talent_job_id IS ?"
  ).bind(opts.talentId, opts.talentJobId || null).first<{ n: number }>();
  if ((exist?.n ?? 0) > 0) return 0;

  const stmts = DEFAULT_ONBOARDING_ITEMS.map((it, i) =>
    db.prepare(`
      INSERT INTO onboarding_items (id, owner_id, talent_id, talent_job_id, name, category, required, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(genId(), opts.ownerId, opts.talentId, opts.talentJobId || null, it.name, it.category, it.required, i)
  );
  await db.batch(stmts);
  return DEFAULT_ONBOARDING_ITEMS.length;
}

/** 推进到「已入职」时的副作用：试用期跟进待办（同人才已有未完成的同前缀待办则跳过） */
async function createProbationTask(
  db: D1Database,
  opts: { ownerId: string; talentId: string; jobId: string | null; talentName: string }
): Promise<boolean> {
  const dup = await db.prepare(
    "SELECT id FROM talent_tasks WHERE talent_id = ? AND status = 'pending' AND title LIKE '试用期跟进%'"
  ).bind(opts.talentId).first();
  if (dup) return false;

  await db.prepare(
    "INSERT INTO talent_tasks (id, owner_id, talent_id, job_id, title, content, due_date, priority, status, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'normal', 'pending', 'system')"
  ).bind(
    genId(), opts.ownerId, opts.talentId, opts.jobId,
    `试用期跟进：${opts.talentName}`,
    "候选人已入职，关注试用期表现与融入情况，到期前完成转正评估。",
    ymd(new Date(Date.now() + 90 * 86400000))
  ).run();
  return true;
}

/**
 * 系统自动正向推进某条投递的阶段（只前进、不后退）。
 *
 * 使用场景：面试通过、Offer 审批通过。
 * 之所以只允许前进：自动逻辑不该把「已淘汰 / 已入职」的人拉回来，
 * 也不该把已经推进到 Offer 的人退回初试 —— 那种操作一律由人在看板上手动完成。
 *
 * @returns moved=false 时 reason 说明原因（not_found / same / no_forward）
 */
export async function moveStageForward(
  db: D1Database,
  opts: { linkId: string; toStage: Stage; userId: string; remark?: string | null; hireDate?: string | null }
): Promise<{ moved: boolean; reason?: string; talentId?: string; talentName?: string }> {
  const link = await db.prepare(`
    SELECT tj.id, tj.stage as old_stage, tj.talent_id, tj.job_id, t.name as talent_name, t.owner_id
    FROM talent_jobs tj JOIN talents t ON tj.talent_id = t.id WHERE tj.id = ?
  `).bind(opts.linkId).first<any>();
  if (!link) return { moved: false, reason: "not_found" };

  const old = link.old_stage as Stage;
  if (old === opts.toStage) return { moved: false, reason: "same", talentId: link.talent_id };

  const oi = PROGRESS_ORDER.indexOf(old);
  const ni = PROGRESS_ORDER.indexOf(opts.toStage);
  if (TERMINAL.includes(old) || oi < 0 || ni < 0 || ni <= oi) {
    return { moved: false, reason: "no_forward", talentId: link.talent_id };
  }

  await db.prepare("UPDATE talent_jobs SET stage = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(opts.toStage, opts.linkId).run();

  await db.prepare(
    "INSERT INTO job_stage_logs (id, talent_job_id, from_stage, to_stage, user_id, remark) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(genId(), opts.linkId, old, opts.toStage, opts.userId, opts.remark || null).run();

  if (opts.toStage === "hired") {
    // Offer 里填的入职日期优先落库；COALESCE 不覆盖 HR 已手工填写的真实日期
    if (opts.hireDate) {
      await db.prepare("UPDATE talents SET hire_date = COALESCE(hire_date, ?) WHERE id = ?")
        .bind(opts.hireDate, link.talent_id).run();
    }
    await createProbationTask(db, {
      ownerId: link.owner_id,
      talentId: link.talent_id,
      jobId: link.job_id,
      talentName: link.talent_name,
    });
    // 入职办理自动化：流转到已入职即自动生成材料清单（幂等）
    await ensureOnboardingItems(db, {
      ownerId: link.owner_id,
      talentId: link.talent_id,
      talentJobId: opts.linkId,
    });
  }

  await syncTalentStage(db, link.talent_id);
  return { moved: true, talentId: link.talent_id, talentName: link.talent_name };
}
