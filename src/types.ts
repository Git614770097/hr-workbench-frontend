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
  | "pipeline" | "interviews" | "funnel" | "jobs" | "tasks" | "templates" | "profiles" | "users";

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
  { key: "profiles", label: "人才画像" },
  { key: "templates", label: "模板库管理" },
  { key: "users", label: "用户管理" },
];

export interface Role {
  id: string;
  name: string;
  permissions: string[];
  created_at?: string;
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
  is_demo?: number;           // 示例数据标记：1=一键载入的演示数据
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
  admin: "管理员",
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
  is_demo?: number;           // 示例数据标记：1=一键载入的演示数据
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
  pending: "待审批",
  approved: "已通过",
  rejected: "已驳回",
  closed: "已关闭",
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

/** 人才详情聚合返回 */
export interface TalentDetailData extends Talent {
  tasks: Task[];
  pipeline: TalentPipelineItem[];
  stage_logs: TalentStageLog[];
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

// ---- 招聘概览首页聚合（GET /api/overview）----
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
  /** 本周各阶段「到达」人次（job_stage_logs.to_stage），键为阶段 key */
  weeklyStageReached: Record<string, number>;
  /** 待办汇总 */
  tasks: { pending: number; overdue: number; today: number };
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
