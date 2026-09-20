import type { User, Talent, Tag, Communication, DocTemplate, PaginatedResponse, RiskItem, RiskSummary } from "./types";

const BASE = "/api";

function getToken(): string | null {
  return localStorage.getItem("token");
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    localStorage.removeItem("token");
    window.location.href = "/login";
    throw new Error("未登录");
  }

  if (!res.ok) {
    const err = (await res.json().catch(() => ({ error: "请求失败" }))) as { error?: string };
    throw new Error(err.error || "请求失败");
  }

  return res.json() as Promise<T>;
}

export const api = {
  // Auth
  getCaptcha: () =>
    request<{ captcha_id: string; svg: string }>("/auth/captcha"),

  login: (data: { phone: string; password: string; captcha_id: string; captcha: string }) =>
    request<{ id: string; phone: string; name: string; role: string; token: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify(data),
    }).then((r) => {
      localStorage.setItem("token", r.token);
      return r;
    }),

  me: () => request<User>("/auth/me"),
  logout: () => request("/auth/logout", { method: "POST" }),

  // User management (admin only)
  getUsers: () => request<{ id: string; phone: string; name: string; role: string; created_at: string }[]>("/auth/users"),
  createUser: (data: { phone: string; name: string; password: string }) =>
    request("/auth/users", { method: "POST", body: JSON.stringify(data) }),
  resetUserPassword: (id: string, password: string) =>
    request(`/auth/users/${id}/password`, { method: "PUT", body: JSON.stringify({ password }) }),
  deleteUser: (id: string) =>
    request(`/auth/users/${id}`, { method: "DELETE" }),

  // Talents
  getTalents: (params: Record<string, string | number>) => {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    ).toString();
    return request<PaginatedResponse<Talent>>(`/talents?${qs}`);
  },

  getTalent: (id: string) => request<Talent>(`/talents/${id}`),

  createTalent: (data: Partial<Talent> & { tag_ids?: string[] }) =>
    request<Talent>("/talents", { method: "POST", body: JSON.stringify(data) }),

  updateTalent: (id: string, data: Partial<Talent> & { tag_ids?: string[] }) =>
    request<Talent>(`/talents/${id}`, { method: "PUT", body: JSON.stringify(data) }),

  deleteTalent: (id: string) =>
    request(`/talents/${id}`, { method: "DELETE" }),

  importTalents: (data: Partial<Talent>[]) =>
    request<{ imported: number }>("/talents/import", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Resume file upload and preview
  uploadResume: (talentId: string, file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("talent_id", talentId);
    return fetch(`${BASE}/talents/resume`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getToken()}` },
      body: formData,
    }).then(async (res) => {
      if (!res.ok) {
        const err = (await res.json().catch(() => ({ error: "上传失败" }))) as { error?: string };
        throw new Error(err.error || "上传失败");
      }
      return res.json();
    });
  },

  getResumeUrl: (talentId: string) =>
    `${BASE}/talents/${talentId}/resume?token=${getToken() || ""}`,

  deleteResume: (talentId: string) =>
    request(`/talents/${talentId}/resume`, { method: "DELETE" }),

  // Tags
  getTags: () => request<(Tag & { talent_count?: number; owner_name?: string })[]>("/tags"),
  createTag: (data: { name: string; color?: string }) =>
    request<Tag>("/tags", { method: "POST", body: JSON.stringify(data) }),
  updateTag: (id: string, data: { name?: string; color?: string }) =>
    request(`/tags/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteTag: (id: string) => request(`/tags/${id}`, { method: "DELETE" }),

  // Communications
  getCommunications: (talentId: string) =>
    request<Communication[]>(`/communications/talent/${talentId}`),
  createCommunication: (data: Partial<Communication>) =>
    request<Communication>("/communications", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteCommunication: (id: string) =>
    request(`/communications/${id}`, { method: "DELETE" }),

  // Doc templates
  getTemplates: (params: { category?: string; q?: string }) => {
    const qs = new URLSearchParams();
    if (params.category) qs.set("category", params.category);
    if (params.q) qs.set("q", params.q);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<{ items: DocTemplate[] }>(`/templates${suffix}`);
  },
  getTemplateCategories: () =>
    request<{ items: { category: string; count: number }[] }>("/templates/categories"),
  getTemplate: (id: string) => request<DocTemplate>(`/templates/${id}`),
  createTemplate: (data: { name: string; category: string; content: string }) =>
    request<{ id: string }>("/templates", { method: "POST", body: JSON.stringify(data) }),
  updateTemplate: (id: string, data: Partial<{ name: string; category: string; content: string }>) =>
    request(`/templates/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteTemplate: (id: string) =>
    request(`/templates/${id}`, { method: "DELETE" }),

  duplicateTemplate: (id: string) =>
    request(`/templates/${id}/duplicate`, { method: "POST" }),

  // 风险预警
  getRisks: () =>
    request<{ items: RiskItem[]; summary: RiskSummary }>("/risks"),
};
