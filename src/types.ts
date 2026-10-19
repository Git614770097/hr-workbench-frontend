export interface User {
  id: string;
  phone: string;
  name: string;
  role: string;
  role_id?: string | null;
  permissions?: string[];
  /** 管理员用临时密码重置过，需在下次登录后自行修改 */
  must_change_password?: boolean;
  /** 是否已配置个人 PushPlus 推送 token（用于到期提醒推送到本人微信） */
  pushplus_configured?: boolean;
  /** 会员有效期（NULL=未开通；时间串=已过期/有效，由管理员手动开通） */
  paid_until?: string | null;
  /** 账号状态：active=正常 / frozen=已冻结(只读，到期未续费) / pending / rejected / disabled */
  status?: string | null;
  /** 注册时自报身份（hr/headhunter/team/other）—— 只驱动品牌文案，不参与鉴权 */
  intended_role?: string | null;
  /** 团队标识：NULL=个人；manager=自己的 id；团队成员=所属管理员 id */
  team_id?: string | null;
}

/** 用户管理列表行（管理员视角，含审批与重置申请状态） */
export interface UserRow {
  id: string;
  phone: string;
  name: string;
  role: string;
  role_id: string | null;
  role_name: string | null;
  status: string | null;
  created_at: string;
  /** 忘记密码申请时间，非 null 表示有待处理申请 */
  reset_requested_at: string | null;
  must_change_password: number;
  /** 会员有效期（NULL=未开通；时间串=已过期/有效） */
  paid_until: string | null;
  /** 注册时自报身份（hr/headhunter/team/other），仅作审批参考，不参与鉴权 */
  intended_role?: string | null;
  /** 团队标识（管理员=自己的 id；子用户=管理员 id；NULL=个人） */
  team_id?: string | null;
}

/**
 * 注册时可选的身份。**只是意向标记，不授予任何权限** ——
 * 真正能看到什么菜单由管理员审批时分配的角色决定。
 * 目前仅 HR 人事 / 猎头顾问 两档，文案口径不同、功能一致。
 */
// desc 刻意控制在 ~12 字内：注册页身份选项为两列卡片，过长会换行撑高表单
export const INTENDED_ROLES: { key: string; label: string; desc: string }[] = [
  { key: "hr", label: "HR 人事", desc: "企业内部招聘与人才管理" },
  { key: "headhunter", label: "猎头 / 顾问", desc: "为多家客户寻访并交付" },
];

/** 身份 key → 中文标签（列表与提示复用） */
export const INTENDED_ROLE_LABELS: Record<string, string> = Object.fromEntries(
  INTENDED_ROLES.map((r) => [r.key, r.label])
);

// 菜单权限 key（与后端 src/worker/permissions.ts 保持一致）
export type MenuKey =
  | "talents" | "contracts" | "social"
  | "pipeline" | "interviews" | "funnel" | "jobs" | "tasks" | "templates" | "profiles" | "tools" | "users" | "background";

export const MENU_PERMISSIONS: { key: MenuKey; label: string; hint?: string }[] = [
  { key: "tasks", label: "待办日历" },
  { key: "jobs", label: "岗位管理" },
  { key: "pipeline", label: "招聘看板" },
  { key: "interviews", label: "面试管理", hint: "需同时勾选「招聘看板」" },
  { key: "funnel", label: "招聘概览" },
  { key: "talents", label: "人才库管理" },
  // 合同管理 / 社保公积金 已从 talents 拆为独立权限：
  // 猎头等角色可以只保留人才库、关掉这两个 HR 台账菜单。
  // 但两者主体数据仍取自 talents 表（合同期、试用期、社保基数都挂在人才上），
  // 接口层也需要 talents 权限才能读到人才列表，故需一并勾选。
  { key: "contracts", label: "合同管理", hint: "需同时勾选「人才库管理」" },
  { key: "social", label: "社保公积金", hint: "需同时勾选「人才库管理」" },
  // 背调中心：独立于招聘看板的敏感合规模块，单独权限便于按角色开关。
  // 主体数据仍取自 talents 表，故提示一并勾选「人才库管理」。
  { key: "background", label: "背调中心", hint: "需同时勾选「人才库管理」" },
  { key: "profiles", label: "人才画像" },
  { key: "templates", label: "模板库管理" },
  { key: "tools", label: "工具中心", hint: "AI 助手；页内各功能按其领域权限展示" },
  { key: "users", label: "用户管理" },
];

export interface Role {
  id: string;
  name: string;
  permissions: string[];
  created_at?: string;
  /** 角色创建者：NULL=全局角色；manager 创建的角色记自己的 id */
  owner_id?: string | null;
}

export interface Talent {
  id: string;
  owner_id: string;
  owner_name?: string;
  name: string;
  phone: string | null;
  email: string | null;
  age: number | null;
  gender: string | null;   // 性别：男 / 女
  education: string | null;
  school: string | null;
  major: string | null;    // 专业（所学专业）
  current_company: string | null;
  current_title: string | null;
  years_experience: number | null;
  city: string | null;
  skills: string[];
  tags: string[];
  industry: string | null;
  expected_salary: string | null;
  expected_city: string | null;
  status: string;
  resume_url: string | null;
  notes: string | null;
  stage: string | null;      // 全局招聘阶段
  source: string | null;     // 来源渠道
  entry_type?: string | null; // 录入方式: manual=手动录入 / import=简历导入 / sync=平台同步
  birth_date: string | null;
  contract_end: string | null;
  probation_end: string | null;
  resignation_date: string | null;
  hire_date: string | null;   // 入职日期（社保增员待办基准日）
  next_follow_at: string | null; // 下次跟进/提醒时间，到期自动生成待办并推送
  created_at: string;
  updated_at: string;
}

// 参保状态（talent_social.si_status）
export const SI_STATUS_LABELS: Record<string, string> = {
  none: "未参保",
  active: "参保中",
  stopped: "已停缴",
};
export const SI_STATUS_COLORS: Record<string, string> = {
  none: "default",
  active: "green",
  stopped: "default",
};
/** 参保状态可选项（单一来源）：编辑弹窗与搜索筛选共用，保证两者一致 */
export const SI_STATUS_OPTIONS: { label: string; value: string }[] = [
  "active",
  "stopped",
  "none",
].map((v) => ({ value: v, label: SI_STATUS_LABELS[v] }));

// 社保公积金台账行（talents LEFT JOIN talent_social）
export interface SocialItem {
  id: string;                    // 人才 id
  name: string;
  phone: string | null;
  status: string;
  hire_date: string | null;
  resignation_date: string | null;
  si_status: string | null;      // null = 无台账记录（视同未参保）
  si_city: string | null;
  si_base: number | null;
  hf_base: number | null;
  si_rate_personal: number | null;
  si_rate_company: number | null;
  hf_rate_personal: number | null;
  hf_rate_company: number | null;
}

// 参保城市费率模板（按城市存默认缴费比例，编辑参保信息时自动带出）
export interface SocialRateTemplate {
  id: string;
  owner_id: string;
  city: string;
  si_rate_personal: number | null;
  si_rate_company: number | null;
  hf_rate_personal: number | null;
  hf_rate_company: number | null;
  /** true = 系统内置参考值（不可删，只能用同名城市覆盖），需按当地政策核对 */
  is_system?: boolean;
}

export interface SocialRateInput {
  city: string;
  si_rate_personal: number | null;
  si_rate_company: number | null;
  hf_rate_personal: number | null;
  hf_rate_company: number | null;
}

// 学历选项（筛选 / 表单 / 导入解析共用）
export const EDUCATION_OPTIONS = [
  "高中及以下", "中专", "大专", "本科", "硕士", "博士", "MBA/EMBA", "其他",
];

export const CITY_OPTIONS = [
  "北京", "上海", "广州", "深圳", "杭州", "成都", "南京", "武汉",
  "西安", "苏州", "重庆", "天津", "青岛", "长沙", "郑州", "其他",
];

export const SKILL_OPTIONS = [
  "Java", "Python", "JavaScript", "TypeScript", "React", "Vue",
  "Node.js", "Go", "C++", "MySQL", "Redis", "Docker", "Kubernetes",
  "团队管理", "项目管理", "产品设计",
];

export interface DocTemplate {
  id: string;
  owner_id: string;
  owner_name?: string;
  name: string;
  category: string;
  content: string;
  scope: "official" | "shared" | "private";
  created_at: string;
  updated_at: string;
}

// 模板分类（新建/筛选共用，共 7 大类）
export const TEMPLATE_CATEGORIES = [
  "招聘入职", "合同协议", "员工异动", "薪酬福利", "社保公积金", "离职退休", "证明文档",
];

// 模板作用域：official 官方（管理员维护，全员只读）/ shared 共享 / private 个人
export const SCOPE_LABELS: Record<string, string> = {
  official: "官方",
  shared: "共享",
  private: "个人",
};

export const SCOPE_COLORS: Record<string, string> = {
  official: "gold",
  shared: "blue",
  private: "default",
};

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export const STATUS_LABELS: Record<string, string> = {
  active: "在职看机会",
  passive: "被动接触",
  placed: "已入职",
  do_not_contact: "暂不联系",
};

export const STATUS_COLORS: Record<string, string> = {
  active: "#10b981",
  passive: "#f59e0b",
  placed: "#3b82f6",
  do_not_contact: "#ef4444",
};

// 录入方式：人才是怎么进库的（具体来自哪个平台看 source 字段）
export const ENTRY_TYPE_LABELS: Record<string, string> = {
  manual: "手动录入",
  import: "简历导入",
  sync: "平台同步",
};

export const ENTRY_TYPE_COLORS: Record<string, string> = {
  manual: "#8c8c8c",
  import: "#1677ff",
  sync: "#722ed1",
};

export const ENTRY_TYPE_OPTIONS = [
  { label: "手动录入", value: "manual" },
  { label: "简历导入", value: "import" },
  { label: "平台同步", value: "sync" },
];

export const ROLE_LABELS: Record<string, string> = {
  admin: "超管",
  manager: "管理员",
  user: "普通用户",
};

// ============================================================
// 招聘看板 / 岗位管理 / 待办日历
// ============================================================

// ---- 招聘流程阶段（顺序即看板列顺序）----
export type Stage =
  | "screening" | "interview1" | "interview2" | "offer"
  | "hired" | "rejected" | "withdrawn";

export interface StageMeta {
  key: Stage;
  label: string;
  color: string;   // 主色（列头/标签）
  bg: string;      // 浅底
  terminal?: boolean;  // 终态：不计入「进行中」
}

export const PIPELINE_STAGES: StageMeta[] = [
  { key: "screening",  label: "简历筛选", color: "#0ea5e9", bg: "#e0f2fe" },
  { key: "interview1", label: "初试",     color: "#6366f1", bg: "#e0e7ff" },
  { key: "interview2", label: "复试",     color: "#8b5cf6", bg: "#f3e8ff" },
  { key: "offer",      label: "Offer",    color: "#f59e0b", bg: "#fef3c7" },
  { key: "hired",      label: "已入职",   color: "#10b981", bg: "#d1fae5", terminal: true },
  { key: "rejected",   label: "已淘汰",   color: "#ef4444", bg: "#fee2e2", terminal: true },
  { key: "withdrawn",  label: "已放弃",   color: "#94a3b8", bg: "#f1f5f9", terminal: true },
];

export const STAGE_META: Record<string, StageMeta> = Object.fromEntries(
  PIPELINE_STAGES.map((s) => [s.key, s])
);

// ---- 岗位 ----
export type JobStatus = "open" | "paused" | "closed";

export const JOB_STATUS_LABELS: Record<string, string> = {
  open: "在招",
  paused: "暂停",
  closed: "已关闭",
};

export const JOB_STATUS_COLORS: Record<string, string> = {
  open: "green",
  paused: "gold",
  closed: "default",
};

export const JOB_TYPE_LABELS: Record<string, string> = {
  fulltime: "全职",
  parttime: "兼职",
  intern: "实习",
  outsourced: "外包",
};

export const PRIORITY_LABELS: Record<string, string> = {
  high: "紧急",
  normal: "常规",
  low: "储备",
};

export const PRIORITY_COLORS: Record<string, string> = {
  high: "red",
  normal: "blue",
  low: "default",
};

export interface Job {
  id: string;
  owner_id: string;
  owner_name?: string;
  title: string;
  department: string | null;
  city: string | null;
  job_type: string;
  headcount: number;
  priority: string;
  status: JobStatus;
  salary_range: string | null;
  education: string | null;
  experience: string | null;
  description: string | null;
  requirements: string | null;
  opened_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  // 聚合统计（列表接口返回）
  candidate_count?: number;
  hired?: number;
  active_count?: number;
}

// 岗位详情：在 Job 基础上带候选人数组
export interface JobDetail extends Omit<Job, "candidate_count"> {
  candidates: JobCandidate[];
  stage_counts: Record<string, number>;
}

// 岗位下的候选人（含阶段）
export interface JobCandidate {
  link_id: string;
  stage: Stage;
  rating: number | null;
  notes: string | null;
  linked_at: string;
  updated_at: string;
  talent_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  current_title: string | null;
  current_company: string | null;
  years_experience: number | null;
  education: string | null;
  city: string | null;
  age: number | null;
  resume_url: string | null;
}

// 看板卡片
export interface PipelineCard {
  link_id: string;
  stage: Stage;
  rating: number | null;
  stage_notes: string | null;
  stage_updated_at: string;
  days_in_stage: number;
  talent_id: string;
  name: string;
  phone: string | null;
  current_title: string | null;
  current_company: string | null;
  years_experience: number | null;
  education: string | null;
  city: string | null;
  resume_url: string | null;
  source: string | null;
  /** 下次跟进日期：该候选人最早的未完成待办 due_date（没有待办则为 null） */
  next_follow: string | null;
  /** 最近一场待面试时间：该投递下最早的 scheduled 面试（没有则为 null） */
  next_interview_at: string | null;
  /** 最近一场待面试的方式（online/onsite/phone），与 next_interview_at 配套 */
  next_interview_mode: string | null;
  job_id: string | null;
  job_title: string | null;
  job_department: string | null;
  job_city: string | null;
  owner_name: string;
}

export interface PipelineResponse {
  columns: Record<string, PipelineCard[]>;
  stats: { total: number; active: number; hired: number; rejected: number };
}

// ---- 招聘需求 ----
export interface Requisition {
  id: string;
  owner_id: string;
  department: string;
  title: string;
  headcount: number;
  job_type: string;
  city: string | null;
  salary_range: string | null;
  education: string | null;
  experience: string | null;
  reason: string | null;
  expect_date: string | null;
  priority: string;
  status: "pending" | "approved" | "rejected" | "closed";
  job_id: string | null;
  reject_reason: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  status_label: string;
  priority_label: string;
}

export const REQUISITION_STATUS_LABELS: Record<string, string> = {
  pending: "待处理",
  approved: "已转岗",
  rejected: "已驳回",
  closed: "已作废",
};

// ---- 审批流 ----
export interface ApprovalFlow {
  id: string;
  owner_id: string;
  name: string;
  scene: string;
  steps: { name: string; approver_id?: string }[];
  enabled: number;
  created_at: string;
}

export interface ApprovalStepRecord {
  id: string;
  instance_id: string;
  step_index: number;
  step_name: string;
  approver_id: string | null;
  decision: "approve" | "reject" | null;
  comment: string | null;
  acted_at: string | null;
}

export interface ApprovalInstance {
  id: string;
  owner_id: string;
  flow_id: string | null;
  scene: string;
  talent_id: string;
  talent_job_id: string | null;
  title: string;
  current_step: number;
  status: "pending" | "approved" | "rejected" | "cancelled";
  status_label: string;
  payload: string | null;
  created_at: string;
  updated_at: string;
  talent_name: string;
  job_title: string | null;
  owner_name: string;
  steps: ApprovalStepRecord[];
}

// ---- 入职办理 ----
export interface OnboardingItem {
  id: string;
  owner_id: string;
  talent_id: string;
  talent_job_id: string | null;
  name: string;
  category: string | null;
  required: number;
  status: "pending" | "submitted" | "verified";
  status_label: string;
  submitted_at: string | null;
  remark: string | null;
  sort_order: number;
  talent_name?: string;
  job_title?: string | null;
}

export const ONBOARDING_STATUS_LABELS: Record<string, string> = {
  pending: "待提交",
  submitted: "已提交",
  verified: "已核验",
};

// ---- 面试管理 ----
export type InterviewRound = "interview1" | "interview2" | "final";
export type InterviewMode = "online" | "onsite" | "phone";
export type InterviewStatus = "scheduled" | "done" | "cancelled" | "no_show";
export type InterviewResult = "pass" | "fail" | "pending";

export const INTERVIEW_ROUND_LABELS: Record<InterviewRound, string> = {
  interview1: "初试",
  interview2: "复试",
  final: "终面",
};

export const INTERVIEW_MODE_LABELS: Record<InterviewMode, string> = {
  online: "线上",
  onsite: "线下",
  phone: "电话",
};

export const INTERVIEW_STATUS_LABELS: Record<InterviewStatus, string> = {
  scheduled: "待面试",
  done: "已完成",
  cancelled: "已取消",
  no_show: "未到",
};

export const INTERVIEW_RESULT_LABELS: Record<InterviewResult, string> = {
  pass: "通过",
  fail: "不通过",
  pending: "待定",
};

export interface Interview {
  id: string;
  owner_id: string;
  talent_id: string;
  job_id: string | null;
  talent_job_id: string | null;
  round: InterviewRound;
  mode: InterviewMode;
  /** 'YYYY-MM-DD HH:mm'（本地时区字符串，不存 UTC） */
  scheduled_at: string | null;
  duration: number;
  location: string | null;
  meeting_url: string | null;
  interviewer: string | null;
  status: InterviewStatus;
  result: InterviewResult | null;
  score: number | null;
  evaluation: string | null;
  // 用人部门评价（与面试评价并列，结构一致：结果 + 评分 + 评语）
  dept_result: InterviewResult | null;
  dept_score: number | null;
  dept_evaluation: string | null;
  created_at: string;
  updated_at: string;
  // 联表带出
  talent_name: string;
  talent_phone: string | null;
  current_title: string | null;
  current_company: string | null;
  job_title: string | null;
  job_department: string | null;
  owner_name: string;
  // 派生字段
  round_label: string;
  mode_label: string;
  status_label: string;
  result_label: string;
  dept_result_label: string;
  days_from_today: number | null;
  is_today: boolean;
  is_overdue: boolean;
}

export interface StageLog {
  id: string;
  talent_job_id: string;
  from_stage: Stage | null;
  to_stage: Stage;
  user_id: string | null;
  user_name?: string | null;
  remark: string | null;
  created_at: string;
}

// ---- 人才详情聚合（GET /talents/:id 返回本体 + 以下三组关联数据）----

/** 该人才的岗位投递记录（talent_jobs + 岗位信息） */
export interface TalentPipelineItem {
  id: string;              // talent_jobs 主键（link_id）
  job_id: string;
  stage: Stage;
  rating: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  job_title: string;
  job_department: string | null;
  job_city: string | null;
}

/** 投递的阶段流转日志（按 talent_job_id 关联到上面的投递记录） */
export interface TalentStageLog {
  id: string;
  talent_job_id: string;
  from_stage: Stage | null;
  to_stage: Stage;
  remark: string | null;
  created_at: string;
  user_name: string | null;
}

/** 沟通记录（communications 表；详情页时间线渲染） */
export interface TalentCommunication {
  id: string;
  type: string | null;        // call / wechat / interview / email / other
  content: string | null;
  rating: number | null;      // 1-5 评分
  follow_up_date: string | null;
  created_at: string;
  user_name: string | null;   // 记录人
}

/** 沟通方式中文标签 */
export const COMM_TYPE_LABELS: Record<string, string> = {
  call: "电话",
  wechat: "微信",
  interview: "面试",
  email: "邮件",
  other: "其他",
};

/** 人才详情聚合返回 */
export interface TalentDetailData extends Talent {
  tasks: Task[];
  pipeline: TalentPipelineItem[];
  stage_logs: TalentStageLog[];
  communications: TalentCommunication[];
}

// ---- 招聘漏斗 ----
// 阶段人数采用「曾到达」口径：日志里出现过即计入，漏斗因此单调递减
export interface FunnelStageItem {
  key: Stage;
  label: string;
  color: string;
  count: number;         // 该阶段人数
  prev_count: number;    // 上一阶段人数（首级 = 自身）
  rate: number;          // 相对上一级转化率（0~1）
  overall_rate: number;  // 相对漏斗顶层转化率（0~1）
  drop: number;          // 相对上一级流失人数
}

export interface FunnelStayItem {
  key: Stage;
  label: string;
  avg_days: number | null;  // 平均停留天数（当前仍在阶段内的人）
  count: number;
}

/** 一段周期的分布统计（天）。平均值易被个别长尾拉偏，需配合 p50/p90 看 */
export interface CycleStat {
  avg: number | null;
  p50: number | null;  // 中位数
  p90: number | null;  // 90 分位，代表长尾
  max: number | null;  // 最长
  min: number | null;  // 最短
  n: number;           // 样本数
}

/** 全流程耗时构成：同一批「完整链路入职者」的三段平均耗时，s1+s2+s3 = 该批人的全流程周期 */
export interface FunnelSegments {
  s1: number | null;  // 入库 → 首面
  s2: number | null;  // 首面 → Offer
  s3: number | null;  // Offer → 入职
  n: number;
}

export interface FunnelCycles {
  tti: CycleStat;        // 简历入库 → 首次面试
  to_offer: CycleStat;   // 首次面试 → Offer
  to_hire: CycleStat;    // Offer → 入职
  total: CycleStat;      // 入库 → 入职
  segments: FunnelSegments;
}

export interface FunnelSummary {
  total: number;        // 进入流程的候选人总数（人·岗位）
  entered: number;      // 进入简历筛选的人数
  in_progress: number;  // 进行中
  hired: number;
  rejected: number;
  withdrawn: number;
  overall_rate: number; // 整体转化率（入职 / 进入流程）
}

export interface FunnelResponse {
  stages: FunnelStageItem[];
  stage_stay: FunnelStayItem[];
  cycles: FunnelCycles;
  summary: FunnelSummary;
  /** 渠道效果：按人才来源统计「进入流程→入职」（口径与人·岗位一致） */
  sources: FunnelSourceItem[];
  /** 淘汰原因分布：流转日志备注按【原因】前缀归类 */
  reject_reasons: FunnelRejectReason[];
}

// AI 招聘复盘报告（/ai/recap-report）：把概览聚合数据讲成结论
export interface AiRecapReport {
  /** 整体判断一段话（80-150 字） */
  summary: string;
  /** 2-3 条瓶颈定位，须引用具体数字 */
  bottlenecks: string[];
  /** 3 条可执行建议 */
  suggestions: string[];
  /** 本次生成的 token 用量（后端透传 DeepSeek usage，历史缓存带回的是上次生成的用量） */
  _usage?: AiUsage | null;
}

/** AI 调用的 token 用量（DeepSeek usage 字段，后端原样透传） */
export interface AiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// AI 看板下一步建议（/ai/next-step）：单卡决策建议 + 跟进话术草稿
export interface AiNextStep {
  /** 动作类型：advance / arrange_interview / push_offer / contact / standby / drop */
  action: string;
  /** 一句话动作建议（带具体时间） */
  suggestion: string;
  /** 2-3 条依据（引用停留天数/备注/评分等事实） */
  reasons: string[];
  /** 可复制的跟进话术草稿（AI 只出草稿，系统永不代发） */
  draft: string;
}

// AI 今日重点（/ai/today-focus）：把逾期/今日/未来 7 天待办排个先后
export interface AiTodayFocus {
  /** 今天优先处理的 2-3 件事，每条「待办标题 — 一句话理由」 */
  top3: string[];
  /** 建议的处理顺序/时段安排（一句话） */
  arrange: string;
  /** 可放一放的待办 + 理由（可空） */
  defer: string[];
}

// AI 岗位诊断（/ai/job-diagnosis）：单岗位「为什么招人慢」
export interface AiJobDiagnosis {
  /** 一句话判断（瓶颈在哪） */
  verdict: string;
  /** 2-3 条依据（引用具体数字） */
  reasons: string[];
  /** 3 条可执行建议 */
  actions: string[];
}

// AI 审批摘要（/ai/approval-summary）：审批「10 秒读卡」
export interface AiApprovalSummary {
  /** 3 句话内讲清「批的是什么」 */
  summary: string;
  /** 0-2 条风险点（引用数据；AI 不给批准/驳回的倾向性结论） */
  risks: string[];
}

// AI 入职清单（/ai/onboard-checklist）：按岗位/城市上下文生成材料初稿，前端预览勾选后入库
export interface AiOnboardChecklist {
  items: { name: string; category: string; required: boolean }[];
}

// AI 人才储备盘点（/ai/talent-inventory）：按筛选口径讲「库里有没有货」
export interface AiTalentInventory {
  /** 一段储备画像（总量/结构/特征，带数字） */
  profile: string;
  /** 0-3 条储备缺口（引用数据对比） */
  gaps: string[];
  /** 2-3 条储备运营建议 */
  actions: string[];
}

// AI 招聘周报（/ai/weekly-report）：把一周的真实数据讲成一份可直接发出去的完整周报。
// 与 recap-report 的分工：复盘讲趋势结论（几句话），周报讲这一周发生了什么（完整文档）。
export interface AiWeeklyReport {
  /** 统计周期（this_week / last_week） */
  range: string;
  /** 语气（report 正式汇报 / brief 极简清单） */
  tone: string;
  /** 焦点（all / progress / risk） */
  focus: string;
  /** 展示用区间文案，如「10/12 ~ 10/16（本周至今）」 */
  period: string;
  /** 周报标题（一句话判断） */
  headline: string;
  /** 3-5 条本周亮点与进展（引用具体数字） */
  highlights: string[];
  /** 叙述性正文；仅 report 语气产出，brief 为空串 */
  narrative: string;
  /** 0-3 条风险或卡点 */
  concerns: string[];
  /** 3-5 条下周动作建议 */
  next_actions: string[];
  _usage?: AiUsage | null;
}

// AI 候选人对比（/ai/candidate-compare）：选 2-3 人并排对比 + 推荐
export interface AiCandidateCompare {
  /** 对比的候选人姓名，与输入顺序一致（用于渲染表头） */
  names: string[];
  /** 一句话综合推荐（谁更适合、为什么） */
  verdict: string;
  /** 3-5 个对比维度，每个维度的要点数组与候选人顺序一一对应 */
  aspects: { aspect: string; notes: string[] }[];
  /** 0-3 条需警惕的点 */
  watchouts: string[];
  _usage?: AiUsage | null;
}

// AI Offer 谈判话术（/ai/offer-negotiation）：基于双方薪资预期生成谈判方案
export interface AiOfferNegotiation {
  /** 一句话谈判基调 */
  strategy: string;
  /** 2-3 个核心筹码/说服点 */
  points: string[];
  /** 2-3 个场景话术 { 场景, 可直接说的话术 } */
  scripts: { situation: string; script: string }[];
  /** 1-3 条谈判注意 */
  tips: string[];
  _usage?: AiUsage | null;
}

// AI 被动人才触达文案（/ai/sourcing-copy）：面向在职/观望候选人的挖角文案
export interface AiSourcingCopy {
  title: string;
  content: string;
  tips: string[];
  _usage?: AiUsage | null;
}

// AI 招聘渠道建议（/ai/channel-advice）：针对单岗位推荐投放渠道与优先级
export interface AiChannelAdvice {
  /** 一句话结论（主力渠道 + 原因） */
  verdict: string;
  /** 3-5 个推荐渠道 { 渠道名, 优先级, 理由 } */
  channels: { channel: string; priority: "高" | "中" | "低"; reason: string }[];
  /** 1-3 条渠道运营建议 */
  tips: string[];
  _usage?: AiUsage | null;
}

// AI 合同风险审查（/ai/contract-review）：粘贴合同文本，AI 标风险点/缺失条款/健康度
export interface AiContractReview {
  /** 一句话整体判断 */
  summary: string;
  /** 合规健康度评分 0-100 */
  score: number;
  /** 2-6 个风险点 { 涉及条款, 风险说明, 修改建议 } */
  risks: { clause: string; risk: string; suggestion: string }[];
  /** 0-5 条缺失的必备条款 */
  missing: string[];
  _usage?: AiUsage | null;
}

// AI 社保增减员提醒（/ai/social-reminder）：基于事件/日期/城市生成操作提醒
export interface AiSocialReminder {
  /** 事件标签（增员/减员） */
  event: string;
  /** 一句话关键时间节点 */
  deadline: string;
  /** 3-6 步操作清单 */
  steps: string[];
  /** 1-4 条合规注意 */
  notes: string[];
  /** 1-3 条实操建议 */
  tips: string[];
  _usage?: AiUsage | null;
}

// AI 个税筹划建议（/ai/tax-plan）：基于税前薪资构成给出到手估算与合规节税建议
export interface AiTaxPlan {
  /** 一句话到手结论（估算） */
  take_home_note: string;
  /** 2-5 条节税/优化点 { 项目, 说明 } */
  optimizations: { item: string; detail: string }[];
  /** 1-3 条合规提醒 */
  tips: string[];
  _usage?: AiUsage | null;
}

// AI 试用期合规提醒（/ai/probation-compliance）：基于合同起始日与试用期月数推算节点与话术
export interface AiProbationCompliance {
  /** 2-4 个关键节点 { 节点名, HR 应做的事 } */
  timeline: { node: string; action: string }[];
  /** 2-5 条合规要点 */
  points: string[];
  /** 0-3 个沟通话术 { 场景, 话术 } */
  scripts: { situation: string; script: string }[];
  /** 1-3 条注意 */
  tips: string[];
  _usage?: AiUsage | null;
}

// AI 配额（/ai/quota）：管理员不限额（unlimited=true, limit=-1）；
// 普通用户 limit 为生效上限，0 表示不限制。default_limit 是「系统设置里配的值」，
// 管理员把自己的生效值设为 -1，所以要额外给默认值才能在设置页回显当前配置。
export interface AiQuotaInfo {
  used: number;
  limit: number;
  unlimited: boolean;
  default_limit: number;
}

/** 自有 AI Key（BYOK）状态：/ai/own-key。masked 如 sk-****abcd */
export interface AiOwnKeyInfo {
  configured: boolean;
  masked: string | null;
}

export interface FunnelSourceItem {
  source: string;
  entered: number;  // 进入流程的投递数
  hired: number;    // 曾到达「已入职」的投递数
  rate: number;     // 入职转化率（0~1）
  in_progress: number;  // 尚未到达终态（招聘中）的投递数
  rejected: number;     // 曾到达「已淘汰」的投递数
  withdrawn: number;    // 曾到达「已放弃」的投递数
  /** 入库→入职的平均天数（仅入职者样本，无样本为 null） */
  avg_cycle_days: number | null;
}

export interface FunnelRejectReason {
  reason: string;
  count: number;
}

/** 淘汰标准原因：拖入「已淘汰」时必选，以【原因】前缀存入流转日志备注，供漏斗页统计分布 */
export const REJECT_REASONS = [
  "薪资不匹配", "能力不达标", "经验不符", "稳定性存疑",
  "文化/团队匹配", "候选人放弃", "企业侧暂停", "其他",
];

// ---- 合规到期提醒（合同 / 试用期）----
export interface ComplianceItem {
  talent_id: string;
  name: string;
  date: string;       // 到期日 YYYY-MM-DD
  days_left: number;  // 负数 = 已过期
  type: "contract" | "probation";
}

export interface ComplianceResponse {
  items: ComplianceItem[];
  contract_count: number;
  probation_count: number;
}

// ---- 合同管理 ----
export interface ContractItem {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  status: string;
  contract_end: string | null;
  probation_end: string | null;
}

export interface ContractSyncResult {
  checked: number;
  created: number;
  updated: number;
  cancelled: number;
}

// 合同文件（原件存 KV，元数据 + AI 识别日期存 D1）
export interface ContractFile {
  id: string;
  talent_id: string;
  filename: string;
  mime: string;
  size: number;
  extracted_contract_end: string | null;
  extracted_probation_end: string | null;
  applied: number;
  created_at: string;
}

export interface ContractUploadResult {
  file: ContractFile;
  extracted: { contract_end: string | null; probation_end: string | null } | null;
  warning: string | null;
}

// ---- 候选人背调中心（独立模块，逻辑挂在 Offer→入职之间）----
export type BgStatus = "pending" | "processing" | "completed" | "passed" | "failed" | "cancelled";
export type BgConsent = "none" | "requested" | "granted" | "declined";
export type BgItemStatus = "pending" | "pass" | "fail";

export const BG_STATUS_LABELS: Record<string, string> = {
  pending: "待发起",
  processing: "核验中",
  completed: "已出报告",
  passed: "已通过",
  failed: "未通过",
  cancelled: "已取消",
};

export const BG_CONSENT_LABELS: Record<string, string> = {
  none: "未授权",
  requested: "已发授权请求",
  granted: "已授权",
  declined: "候选人拒绝",
};

export const BG_ITEM_STATUS_LABELS: Record<string, string> = {
  pending: "待核验",
  pass: "一致",
  fail: "异常",
};

export interface BgItem {
  type: string;
  label: string;
  status: BgItemStatus;
  note: string;
}

export interface BackgroundCheck {
  id: string;
  owner_id: string;
  talent_id: string;
  talent_job_id: string | null;
  status: BgStatus;
  consent_status: BgConsent;
  consent_at: string | null;
  consent_method: string | null;
  provider: string;
  high_risk: boolean;
  items: BgItem[];
  item_count?: number;
  has_report: boolean;
  report_name: string | null;
  summary: string | null;
  result: "pass" | "fail" | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  // 联表带出
  talent_name: string;
  talent_phone: string | null;
  job_title: string | null;
  owner_name: string;
  status_label: string;
  consent_label: string;
}

/** AI 背调小结（/background/:id/ai-summary） */
export interface BgSummary {
  summary: string;
  risks: string[];
}

/** AI 简历核查清单（/background/:id/ai-resume-check）：基于简历文本生成待核查建议 */
export interface BgResumeCheckItem {
  category: string;     // 学历 / 工作履历 / 竞业限制 / 身份 / 其他
  item: string;         // 具体核查事项
  channel: string;      // 建议核查渠道（学信网 / 前雇主 HR / 社保系统…）
  material: string;     // 需收集的证明材料
  priority: "high" | "medium" | "low";
}
export interface BgResumeCheckResult {
  items: BgResumeCheckItem[];
  gaps: string[];       // 简历缺失/含糊、需候选人补充确认的点
  notes: string;        // 整体建议
}

// ---- 待办日历 ----
export type TaskStatus = "pending" | "done" | "cancelled";

export interface Task {
  id: string;
  owner_id: string;
  owner_name?: string | null;
  talent_id: string | null;
  talent_name?: string | null;
  job_id: string | null;
  job_title?: string | null;
  title: string;
  content: string | null;
  due_date: string | null;
  priority: string;
  status: TaskStatus;
  source: string;
  done_at: string | null;
  created_at: string;
  // 周末顺延：original_due 为原始到期日，shifted=1 表示已顺延到工作日
  original_due?: string | null;
  shifted?: number | null;
  // 后端计算字段
  days_left: number | null;
  overdue: boolean;
  due_today: boolean;
}

export interface TaskSummary {
  pending: number;
  overdue: number;
  today: number;
}

// ---- 工作台首屏聚合（GET /api/overview）----
export interface TodayInterviewItem {
  id: string;
  talent_id: string;
  job_id: string | null;
  scheduled_at: string | null;
  round: string;
  mode: string;
  location: string | null;
  meeting_url: string | null;
  interviewer: string | null;
  talent_name: string;
  job_title: string | null;
}

export interface DueSoonTaskItem {
  id: string;
  title: string;
  due_date: string;
  source: string;
  talent_id: string | null;
  job_id: string | null;
  talent_name: string | null;
}

export interface OverviewResponse {
  /** 在招职位数（status=open） */
  openJobs: number;
  /** 人才库总数 */
  totalTalents: number;
  /** 进行中候选人数（talent_jobs 非终态阶段之和） */
  activeCandidates: number;
  /** 当前各阶段人数（talent_jobs 当前停留阶段），键为阶段 key */
  stageCounts: Record<string, number>;
  /** 本周新增人才数（中国时区周一为界） */
  weeklyNewTalents: number;
  /** 上周新增人才数（环比基准） */
  prevWeekNewTalents: number;
  /** 本周各阶段「到达」人次（job_stage_logs.to_stage），键为阶段 key */
  weeklyStageReached: Record<string, number>;
  /** 待办汇总 */
  tasks: { pending: number; overdue: number; today: number };
  /** 今日面试数（KPI 快照用） */
  todayInterviewCount: number;
  /** 上周同日面试数（环比基准） */
  prevWeekdayInterviewCount: number;
  /** 今日面试列表（action 层用） */
  todayInterviews: TodayInterviewItem[];
  /** 近 3 天到期待办（含今日，action 层用） */
  dueSoonTasks: DueSoonTaskItem[];
}

// ---- 工作台趋势折线（GET /api/overview/trend）----
export interface TrendSeries {
  key: string;
  label: string;
  color: string;
  data: number[];
}

export interface TrendResponse {
  granularity: "week";
  /** 窗口长度：4w / 12w / 24w */
  range: string;
  labels: string[];
  series: TrendSeries[];
  total: { new_talents: number; interview: number; hired: number };
  from_date: string;
}

// ---- 工作台「调整模块」配置（存 user_settings.workbench_modules）----
export type WorkbenchModuleKey =
  | "daily_brief"
  | "today_focus"
  | "kpi_band"
  | "trend"
  | "funnel"
  | "sources"
  | "cycles"
  | "stay"
  | "reject";

export interface WorkbenchModuleConfig {
  /** 被隐藏的模块 key 列表（缺省 = 全部显示） */
  hidden: WorkbenchModuleKey[];
}

// ---- 今日早报（工作台行动层，GET /overview/daily-brief）----
export type DailyBriefLevel = "red" | "amber" | "blue";
export interface DailyBriefItem {
  /** 人才-岗位对（talent_id:job_id），前端列表 key */
  link_key: string;
  talent_id: string;
  talent_name: string;
  job_title: string;
  /** red=候选人在流失/结论卡人；amber=排期风险；blue=等你做决定 */
  level: DailyBriefLevel;
  reason: string;
  action: string;
}
export interface DailyBrief {
  items: DailyBriefItem[];
  /** AI 一句话开场白（null=配额用完/无 Key/失败，静默降级，名单不受影响） */
  ai_note: string | null;
  generated_at: string;
}

export const TASK_SOURCE_LABELS: Record<string, string> = {
  manual: "手动创建",
  follow_up: "沟通跟进",
  system: "系统生成",
};

// ============================================================
// 智能匹配：多份简历 + 人才画像 → 排序推荐
// ============================================================

/** 人才画像（一个职位一份整体要求；不再按级别分档） */
export interface MatchProfile {
  id?: string;
  name: string;
  job_title: string;
  city: string;
  education: string;
  min_years: number | null;
  max_years: number | null;
  salary_range: string;
  industry: string;
  must_skills: string[];
  nice_skills: string[];
  requirements: string;
  jd_raw: string;
  created_at?: string;
  updated_at?: string;
}

/** 硬性条件判定（规则算出，不随 AI 波动）。ok 为 null = 无法判定（画像未要求或简历未体现） */
export interface MatchHardCheck {
  education: { ok: boolean | null; actual: string; require: string };
  /** over：实际年限高于画像上限 = 资历偏高（薪资可能不匹配），不是不达标 */
  years: { ok: boolean | null; actual: number | null; require: string; over?: boolean };
  city: { ok: boolean | null; actual: string; require: string };
  must_skills: { hit: string[]; miss: string[] };
  nice_skills: { hit: string[] };
}

export interface MatchResult {
  score: number;
  verdict: string;
  summary: string;
  reasons: string[];
  gaps: string[];
  risks: string[];
  questions: string[];
  hard: MatchHardCheck;
  /** ai=AI 语义评分；rule=未配密钥或 AI 失败时的硬性条件估算 */
  source: "ai" | "rule";
}

export const VERDICT_COLORS: Record<string, string> = {
  强烈推荐: "#10b981",
  推荐: "#3b82f6",
  可考虑: "#f59e0b",
  不建议: "#ef4444",
};

// ---- 人才来源渠道 ----
export const SOURCE_OPTIONS = [
  "BOSS直聘", "猎聘", "智联招聘", "前程无忧", "内推", "校招",
  "官网投递", "猎头推荐", "社交平台", "其他",
];

// ---- 使用日志（模块点击率）----
export interface UsageOverview {
  days: number;
  range: { from: string; to: string };
  cards: {
    activeUsers: number;
    totalViews: number;
    /** 今日访问最多的模块 key，空串表示今天还没有数据 */
    topMenu: string;
    /** 今日人均使用的模块数 */
    avgMenus: number;
  };
  ranking: { menu: string; views: number; uv: number }[];
  trend: { day: string; views: number; uv: number }[];
  /** 本期出现过的菜单 key（矩阵列顺序） */
  menus: string[];
  users: {
    id: string;
    name: string;
    role: string;
    status: string;
    total: number;
    menus: Record<string, number>;
  }[];
}

export interface UsageEventRow {
  id: string;
  ts: string;
  menu: string;
  action: string;
  detail: string | null;
  platform: string | null;
  user_id: string;
  user_name: string;
  role: string | null;
}

export interface UsageEventsResponse {
  total: number;
  page: number;
  page_size: number;
  items: UsageEventRow[];
}

// ---- AI 提效（简历解读 / 沟通文案 / 面试问题 / 综合评估）----
// 约定：所有 AI 产出都是「草稿」，必须人工确认后才使用；系统永不代发。
// 配额：每用户每日 10 次（ai_artifacts 按中国时区计日），同对象同场景 10 分钟内命中缓存。

export interface AiResumeInsight {
  highlights: string[];
  risks: string[];
  jd_fit: { score: number; reasons: string[] } | null;
  suggestion: string;
  _cached?: boolean;
}

export const AI_OUTREACH_SCENE_LABELS: Record<AiOutreachScene, string> = {
  invite_call: "电话邀约脚本",
  invite_wechat: "微信邀约文案",
  reject: "婉拒信",
  followup: "跟进催回",
};

export type AiOutreachScene = "invite_call" | "invite_wechat" | "reject" | "followup";
export type AiRejectTone = "warm" | "polite";

export const AI_REJECT_TONE_LABELS: Record<AiRejectTone, string> = {
  warm: "温暖挽留型",
  polite: "标准客气型",
};

export interface AiOutreach {
  scene: AiOutreachScene;
  tone: AiRejectTone | null;
  title: string;
  content: string;
  tips: string[];
  _cached?: boolean;
}

// HR 侧 AI 改简历：把候选人简历精简、结构化并突出与岗位的匹配点。
// 产出为草稿，供 HR 参考后手动复制，不写回候选人记录。
export interface AiResumeOptimize {
  /** 一句话核心亮点（放简历开头的定位句） */
  headline: string;
  /** 优化后的简历正文（精简、结构化） */
  optimized: string;
  /** 关键改动说明（做了哪些精简/突出） */
  changes: string[];
  /** 进一步优化建议 */
  tips: string[];
  _cached?: boolean;
}

export interface AiInterviewQuestions {
  questions: { q: string; focus: string }[];
  _cached?: boolean;
}

export interface AiCandidateSummary {
  summary: string;
  strengths: string[];
  risks: string[];
  recommendation: string;
  suggested_result: string;
  rounds: number;
  _cached?: boolean;
}
