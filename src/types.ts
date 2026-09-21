export interface User {
  id: string;
  phone: string;
  name: string;
  role: string;
  role_id?: string | null;
  permissions?: string[];
  /** 管理员用临时密码重置过，需在下次登录后自行修改 */
  must_change_password?: boolean;
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
}

// 菜单权限 key（与后端 src/worker/permissions.ts 保持一致）
// 注：标签管理已降级为人才库页内入口，不再是独立菜单，故不在此列——
//     它的访问权限跟随「人才库管理」（talents）。
export type MenuKey =
  | "talents" | "pipeline" | "jobs" | "tasks" | "templates" | "users";

export const MENU_PERMISSIONS: { key: MenuKey; label: string }[] = [
  { key: "talents", label: "人才库管理" },
  { key: "pipeline", label: "招聘流程" },
  { key: "jobs", label: "岗位管理" },
  { key: "tasks", label: "跟进待办" },
  { key: "templates", label: "模板库管理" },
  { key: "users", label: "用户管理" },
];

export interface Role {
  id: string;
  name: string;
  permissions: string[];
  created_at?: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  owner_name?: string;
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
  industry: string | null;
  expected_salary: string | null;
  expected_city: string | null;
  status: string;
  resume_url: string | null;
  notes: string | null;
  stage: string | null;      // 全局招聘阶段
  source: string | null;     // 来源渠道
  birth_date: string | null;
  contract_end: string | null;
  probation_end: string | null;
  resignation_date: string | null;
  created_at: string;
  updated_at: string;
  tags: Tag[];
}

// 学历选项（筛选 / 表单 / 导入解析共用）
export const EDUCATION_OPTIONS = [
  "高中及以下", "中专", "大专", "本科", "硕士", "博士", "MBA/EMBA", "其他",
];

export interface Communication {
  id: string;
  talent_id: string;
  user_id: string;
  user_name?: string;
  type: string;
  content: string | null;
  rating: number | null;
  follow_up_date: string | null;
  created_at: string;
}

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

// 模板分类（新建/筛选共用，共 6 大类）
export const TEMPLATE_CATEGORIES = [
  "招聘入职", "合同协议", "员工异动", "薪酬福利", "离职退休", "证明文档",
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

export const COMM_TYPES: Record<string, string> = {
  call: "电话",
  wechat: "微信",
  interview: "面试",
  email: "邮件",
  other: "其他",
};

export const ROLE_LABELS: Record<string, string> = {
  admin: "管理员",
  user: "普通用户",
};

// ============================================================
// 招聘流程 / 岗位管理 / 跟进待办
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

// ---- 跟进待办 ----
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

export const TASK_SOURCE_LABELS: Record<string, string> = {
  manual: "手动创建",
  follow_up: "沟通跟进",
  system: "系统生成",
};

// ---- 人才来源渠道 ----
export const SOURCE_OPTIONS = [
  "BOSS直聘", "猎聘", "智联招聘", "前程无忧", "内推", "校招",
  "官网投递", "猎头推荐", "社交平台", "其他",
];
