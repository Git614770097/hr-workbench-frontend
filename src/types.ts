export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface Talent {
  id: string;
  owner_id: string;
  name: string;
  phone: string | null;
  email: string | null;
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
  created_at: string;
  updated_at: string;
  tags: Tag[];
}

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
