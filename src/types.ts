export interface User {
  id: string;
  phone: string;
  name: string;
  role: string;
  role_id?: string | null;
  permissions?: string[];
}

// 菜单权限 key（与后端 src/worker/permissions.ts 保持一致）
export type MenuKey = "talents" | "risks" | "templates" | "tags" | "users";

export const MENU_PERMISSIONS: { key: MenuKey; label: string }[] = [
  { key: "talents", label: "人才库管理" },
  { key: "risks", label: "风险预警" },
  { key: "templates", label: "模板库管理" },
  { key: "tags", label: "标签管理" },
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
  birth_date: string | null;
  contract_end: string | null;
  probation_end: string | null;
  resignation_date: string | null;
  created_at: string;
  updated_at: string;
  tags: Tag[];
}

// 风险预警
export type RiskType = "contract_end" | "probation_end" | "birthday" | "resignation";
export type RiskLevel = "red" | "yellow" | "green";

export interface RiskItem {
  talent_id: string;
  name: string;
  type: RiskType;
  date: string;
  days_left: number;
  level: RiskLevel;
}

export interface RiskSummary {
  red: number;
  yellow: number;
  green: number;
}

export const RISK_TYPE_LABELS: Record<string, string> = {
  contract_end: "合同到期",
  probation_end: "试用期结束",
  birthday: "生日",
  resignation: "离职倒计时",
};

export const RISK_LEVEL_LABELS: Record<string, string> = {
  red: "紧急",
  yellow: "关注",
  green: "提醒",
};

// 风险级别视觉规范（红黄绿分色，全站统一）
export const RISK_LEVEL_META: Record<RiskLevel, { label: string; color: string; tag: string; bg: string }> = {
  red: { label: "紧急", color: "#ff4d4f", tag: "red", bg: "#fff1f0" },
  yellow: { label: "关注", color: "#faad14", tag: "gold", bg: "#fffbe6" },
  green: { label: "提醒", color: "#52c41a", tag: "green", bg: "#f6ffed" },
};

export const RISK_TYPE_ICONS: Record<RiskType, string> = {
  contract_end: "📝",
  probation_end: "⏳",
  birthday: "🎂",
  resignation: "🚪",
};

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
