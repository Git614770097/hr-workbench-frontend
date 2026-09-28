import { Hono } from "hono";
import type { Env } from "../index";
import { getSession } from "./auth";
import { genId } from "../helpers";

/**
 * 示例数据（演示模式）：一键为当前企业载入一套完整招聘演示数据，
 * 让新用户/试用买家第一眼就能看到"系统长什么样"，而不是一片空白。
 *
 * 设计要点：
 * - 数据全部打 is_demo=1 标记（talents/jobs 两表），可整批一键清除，不碰真实数据
 * - 载入幂等：seed 前先清掉本企业的旧示例数据
 * - 漏斗数据必须连 job_stage_logs 轨迹一起造（漏斗按「曾到达」口径统计），
 *   否则看板有人、漏斗全空，演示效果反而露怯
 * - 时间用相对 now 动态生成：无论何时载入，漏斗平均周期/渠道效果都是合理数字
 */

const app = new Hono<{ Bindings: Env }>();

const DAY = 86400000;

// UTC 时间串（D1 datetime 格式：YYYY-MM-DD HH:MM:SS，无时区后缀）
const dt = (daysAgo: number, hour = 10, min = 30) => {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setUTCHours(hour, min, 0, 0);
  return d.toISOString().slice(0, 19).replace("T", " ");
};

// 上海时区日期（YYYY-MM-DD），用于待办 due_date
const shDate = (daysFromNow: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(
    new Date(Date.now() + daysFromNow * DAY)
  );

// ---- 演示岗位 ----
const DEMO_JOBS = [
  {
    title: "高级 Java 开发工程师", department: "研发部", city: "杭州",
    headcount: 2, priority: "high", status: "open",
    salary_range: "25-40K·14薪", education: "本科", experience: "5年以上",
    description: "负责核心业务系统的设计与开发，参与技术方案评审与性能优化，推动团队工程质量提升。",
    requirements: "精通 Java/Spring 生态，熟悉 MySQL 与 Redis；有高并发系统经验；良好的沟通与协作能力。",
    openedDaysAgo: 45,
  },
  {
    title: "销售代表", department: "销售部", city: "上海",
    headcount: 3, priority: "normal", status: "open",
    salary_range: "8-15K+提成", education: "大专", experience: "1-3年",
    description: "负责 B 端客户的开发与维护，完成销售目标，跟进回款与客户关系。",
    requirements: "沟通表达能力强，有 To B 销售经验优先；抗压性好，结果导向。",
    openedDaysAgo: 30,
  },
  {
    title: "新媒体运营", department: "市场部", city: "杭州",
    headcount: 1, priority: "normal", status: "paused",
    salary_range: "7-12K", education: "本科", experience: "2年以上",
    description: "负责公众号/短视频账号的内容策划与运营，跟踪数据并优化内容策略。",
    requirements: "有爆款内容案例者优先，熟练使用主流内容平台，数据敏感。",
    openedDaysAgo: 38,
  },
];

// ---- 演示候选人：track = 到达过的阶段轨迹（最后一项为当前/终态）----
// 分布（漏斗每层有人）：screening×13 → interview1×8 → interview2×4 → offer×3 → hired×2
// 终态：进行中 9 / 已入职 2 / 已淘汰 2 / 已放弃 1；来源覆盖 6 个渠道，转化率有差异可演示
interface DemoTalent {
  name: string; phone: string; gender: string; education: string; school: string;
  city: string; current_company: string; current_title: string; years: number;
  skills: string[]; expected_salary: string; source: string; createdDaysAgo: number;
  jobIdx: number; track: string[];
}
const DEMO_TALENTS: DemoTalent[] = [
  { name: "王一鸣", phone: "19902381001", gender: "男", education: "本科", school: "浙江工业大学", city: "杭州", current_company: "恒生电子", current_title: "Java 开发工程师", years: 6, skills: ["Java", "Spring Boot", "MySQL", "Redis"], expected_salary: "28-35K", source: "BOSS直聘", createdDaysAgo: 12, jobIdx: 0, track: ["screening", "interview1"] },
  { name: "李思远", phone: "19902381002", gender: "男", education: "硕士", school: "华东师范大学", city: "杭州", current_company: "阿里云", current_title: "后端开发工程师", years: 4, skills: ["Java", "Kafka", "微服务"], expected_salary: "30-40K", source: "猎聘", createdDaysAgo: 6, jobIdx: 0, track: ["screening"] },
  { name: "陈晨", phone: "19902381003", gender: "女", education: "本科", school: "杭州电子科技大学", city: "杭州", current_company: "网易", current_title: "服务端开发", years: 5, skills: ["Java", "Spring Cloud", "MySQL"], expected_salary: "26-33K", source: "内推", createdDaysAgo: 18, jobIdx: 0, track: ["screening", "interview1", "interview2"] },
  { name: "赵子轩", phone: "19902381004", gender: "男", education: "本科", school: "宁波大学", city: "杭州", current_company: "大华股份", current_title: "高级开发工程师", years: 7, skills: ["Java", "分布式", "性能优化"], expected_salary: "32-40K", source: "BOSS直聘", createdDaysAgo: 22, jobIdx: 0, track: ["screening", "interview1", "interview2", "offer"] },
  { name: "刘雨桐", phone: "19902381005", gender: "女", education: "本科", school: "中国传媒大学", city: "杭州", current_company: "遥望科技", current_title: "内容运营", years: 3, skills: ["公众号运营", "短视频", "数据分析"], expected_salary: "9-12K", source: "内推", createdDaysAgo: 40, jobIdx: 2, track: ["screening", "interview1", "interview2", "offer", "hired"] },
  { name: "张浩然", phone: "19902381006", gender: "男", education: "本科", school: "杭州电子科技大学", city: "杭州", current_company: "海康威视", current_title: "Java 开发", years: 5, skills: ["Java", "Spring Boot", "Oracle"], expected_salary: "25-32K", source: "校招", createdDaysAgo: 25, jobIdx: 0, track: ["screening", "interview1", "interview2", "offer", "hired"] },
  { name: "周子墨", phone: "19902381007", gender: "男", education: "大专", school: "上海杉达学院", city: "上海", current_company: "用友网络", current_title: "销售专员", years: 2, skills: ["To B 销售", "客户维护"], expected_salary: "10-14K", source: "BOSS直聘", createdDaysAgo: 15, jobIdx: 1, track: ["screening", "interview1", "rejected"] },
  { name: "吴优", phone: "19902381008", gender: "女", education: "本科", school: "上海师范大学", city: "上海", current_company: "销售易", current_title: "客户经理", years: 3, skills: ["SaaS 销售", "大客户"], expected_salary: "12-16K", source: "猎聘", createdDaysAgo: 9, jobIdx: 1, track: ["screening", "rejected"] },
  { name: "郑安琪", phone: "19902381009", gender: "女", education: "大专", school: "上海立信会计金融学院", city: "上海", current_company: "饿了么", current_title: "商务拓展", years: 1, skills: ["BD", "渠道拓展"], expected_salary: "9-12K", source: "前程无忧", createdDaysAgo: 4, jobIdx: 1, track: ["screening"] },
  { name: "孙嘉禾", phone: "19902381010", gender: "女", education: "本科", school: "浙江传媒学院", city: "杭州", current_company: "微博", current_title: "新媒体运营", years: 2, skills: ["内容策划", "社群运营"], expected_salary: "8-11K", source: "内推", createdDaysAgo: 11, jobIdx: 2, track: ["screening", "interview1"] },
  { name: "林晚晴", phone: "19902381011", gender: "女", education: "本科", school: "浙江大学", city: "杭州", current_company: "字节跳动", current_title: "运营专员", years: 2, skills: ["活动运营", "文案"], expected_salary: "10-13K", source: "校招", createdDaysAgo: 14, jobIdx: 2, track: ["screening", "withdrawn"] },
  { name: "何俊杰", phone: "19902381012", gender: "男", education: "大专", school: "上海城建职业学院", city: "上海", current_company: "美团", current_title: "城市经理", years: 4, skills: ["团队管理", "地推"], expected_salary: "13-18K", source: "BOSS直聘", createdDaysAgo: 8, jobIdx: 1, track: ["screening", "interview1"] },
  { name: "高晨曦", phone: "19902381013", gender: "女", education: "本科", school: "浙江工商大学", city: "杭州", current_company: "滴滴", current_title: "用户运营", years: 2, skills: ["用户增长", "活动策划"], expected_salary: "8-12K", source: "社交平台", createdDaysAgo: 3, jobIdx: 2, track: ["screening"] },
];

// 全局阶段（talents.stage）：new/screening/interview/offer/hired/archived
const globalStageOf = (track: string[]) => {
  const last = track[track.length - 1];
  if (last === "hired") return "hired";
  if (last === "rejected" || last === "withdrawn") return "archived";
  if (last === "interview1" || last === "interview2") return "interview";
  if (last === "offer") return "offer";
  return "screening";
};

// ---- 清除本企业示例数据（按外键顺序，只动 is_demo=1 的）----
async function clearDemo(env: Env, ownerId: string) {
  const tIds = (await env.DB.prepare(
    "SELECT id FROM talents WHERE owner_id = ? AND is_demo = 1"
  ).bind(ownerId).all<{ id: string }>()).results.map((r) => r.id);
  const jIds = (await env.DB.prepare(
    "SELECT id FROM jobs WHERE owner_id = ? AND is_demo = 1"
  ).bind(ownerId).all<{ id: string }>()).results.map((r) => r.id);

  if (tIds.length === 0 && jIds.length === 0) return { talents: 0, jobs: 0 };

  const inList = (ids: string[]) => `(${ids.map(() => "?").join(",")})`;
  const stmts: D1PreparedStatement[] = [];
  // 1) 轨迹日志（经 talent_jobs 关联，无 owner 列，按两端归属删）
  if (tIds.length > 0 || jIds.length > 0) {
    const conds: string[] = [];
    if (tIds.length > 0) conds.push(`talent_id IN ${inList(tIds)}`);
    if (jIds.length > 0) conds.push(`job_id IN ${inList(jIds)}`);
    const where = conds.join(" OR ");
    stmts.push(env.DB.prepare(
      `DELETE FROM job_stage_logs WHERE talent_job_id IN (SELECT id FROM talent_jobs WHERE ${where})`
    ).bind(...tIds, ...jIds));
    stmts.push(env.DB.prepare(`DELETE FROM talent_jobs WHERE ${where}`).bind(...tIds, ...jIds));
    stmts.push(env.DB.prepare(
      `DELETE FROM talent_tasks WHERE owner_id = ? AND (${where})`
    ).bind(ownerId, ...tIds, ...jIds));
    stmts.push(env.DB.prepare(
      `DELETE FROM communications WHERE talent_id IN ${inList(tIds)}`
    ).bind(...tIds));
  }
  if (tIds.length > 0) stmts.push(env.DB.prepare(`DELETE FROM talents WHERE id IN ${inList(tIds)}`).bind(...tIds));
  if (jIds.length > 0) stmts.push(env.DB.prepare(`DELETE FROM jobs WHERE id IN ${inList(jIds)}`).bind(...jIds));
  await env.DB.batch(stmts);
  return { talents: tIds.length, jobs: jIds.length };
}

// ---- 载入示例数据（幂等：先清旧的再插入）----
app.post("/seed", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const ownerId = session.userId;
  const db = c.env.DB;

  await clearDemo(c.env, ownerId);

  // 岗位
  const jobIds: string[] = [];
  const jobStmts = DEMO_JOBS.map((j) => {
    const id = genId();
    jobIds.push(id);
    return db.prepare(
      `INSERT INTO jobs (id, owner_id, title, department, city, job_type, headcount, priority, status, salary_range, education, experience, description, requirements, opened_at, is_demo, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id, ownerId, j.title, j.department, j.city, "fulltime", j.headcount,
      j.priority, j.status, j.salary_range, j.education, j.experience,
      j.description, j.requirements, dt(j.openedDaysAgo, 9), 1,
      dt(j.openedDaysAgo, 9), dt(j.openedDaysAgo, 9)
    );
  });
  await db.batch(jobStmts);

  // 人才 + 投递 + 轨迹日志
  const talentIds: string[] = [];
  const hiredDates: Record<number, string> = {}; // 入职者的 hire_date（供待办文案用）
  for (const t of DEMO_TALENTS) {
    const tid = genId();
    talentIds.push(tid);
    const last = t.track[t.track.length - 1];
    const hiredDaysAgo = last === "hired" ? 5 + Math.floor(Math.random() * 4) : null;
    if (hiredDaysAgo != null) hiredDates[talentIds.length - 1] = shDate(-hiredDaysAgo);
    await db.prepare(
      `INSERT INTO talents (id, owner_id, name, phone, email, age, gender, education, school, current_company, current_title, years_experience, city, skills, expected_salary, status, source, stage, hire_date, is_demo, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      tid, ownerId, t.name, t.phone, null,
      null, t.gender, t.education, t.school, t.current_company, t.current_title,
      t.years, t.city, JSON.stringify(t.skills), t.expected_salary,
      "active", t.source, globalStageOf(t.track),
      hiredDaysAgo != null ? shDate(-hiredDaysAgo) : null,
      1, "示例数据：可编辑或删除，正式使用前可一键清除全部示例",
      dt(t.createdDaysAgo, 9), dt(Math.max(0, t.createdDaysAgo - 1))
    ).run();

    // 投递记录
    const tjId = genId();
    const jobDaysAgo = t.createdDaysAgo - 0.5;
    await db.prepare(
      `INSERT INTO talent_jobs (id, talent_id, job_id, stage, rating, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(
      tjId, tid, jobIds[t.jobIdx], last,
      last === "hired" ? 5 : last === "offer" ? 4 : last === "rejected" ? 2 : 3,
      dt(Math.max(0, jobDaysAgo), 10), dt(0, 12)
    ).run();

    // 到达轨迹日志（时间均匀分布在 created → now 之间，漏斗「曾到达」口径依赖这些记录）
    const span = Math.max(0.5, t.createdDaysAgo - (hiredDaysAgo ?? 0));
    const logStmts = t.track.map((st, i) => {
      const daysAgo = Math.max(0, span - (span * i) / Math.max(1, t.track.length - 1));
      return db.prepare(
        `INSERT INTO job_stage_logs (id, talent_job_id, from_stage, to_stage, user_id, remark, created_at)
         VALUES (?,?,?,?,?,?,?)`
      ).bind(
        genId(), tjId, i === 0 ? null : t.track[i - 1], st, ownerId,
        i === 0 ? "简历初筛通过" : null, dt(daysAgo, 11 + (i % 6))
      );
    });
    await db.batch(logStmts);
  }

  // 待办（含 1 条 2 天后到期，可演示微信推送效果）
  const taskStmts = [
    { title: "初试：李思远（高级 Java 开发工程师）", content: "线上视频面，重点考察微服务与高并发经验。", talentIdx: 1, jobIdx: 0, due: shDate(1), priority: "high" },
    { title: "向赵子轩发送 Offer", content: "薪酬 32K·14薪，先电话沟通意向再发正式 Offer。", talentIdx: 3, jobIdx: 0, due: shDate(2), priority: "high" },
    { title: "整理本季度招聘渠道复盘", content: "结合招聘漏斗「渠道效果」数据，评估各渠道转化与周期。", talentIdx: -1, jobIdx: -1, due: shDate(5), priority: "normal" },
  ].map((k) => db.prepare(
    `INSERT INTO talent_tasks (id, owner_id, talent_id, job_id, title, content, due_date, priority, status, source)
     VALUES (?,?,?,?,?,?,?,?, 'pending', 'manual')`
  ).bind(
    genId(), ownerId,
    k.talentIdx >= 0 ? talentIds[k.talentIdx] : null,
    k.jobIdx >= 0 ? jobIds[k.jobIdx] : null,
    k.title, k.content, k.due, k.priority
  ));
  await db.batch(taskStmts);

  return c.json({
    ok: true,
    seeded: { jobs: DEMO_JOBS.length, talents: DEMO_TALENTS.length, tasks: 3 },
  });
});

// ---- 清除示例数据 ----
app.delete("/seed", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "未登录" }, 401);
  const removed = await clearDemo(c.env, session.userId);
  return c.json({ ok: true, removed });
});

export default app;
