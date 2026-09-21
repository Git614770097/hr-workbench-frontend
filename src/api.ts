import type { User, Talent, Tag, Communication, DocTemplate, PaginatedResponse, Role, Job, JobDetail, PipelineCard, PipelineResponse, StageLog, Task, TaskSummary } from "./types";

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
  getUsers: () => request<{ id: string; phone: string; name: string; role: string; role_id: string | null; role_name: string | null; created_at: string }[]>("/auth/users"),
  createUser: (data: { phone: string; name: string; password: string; role_id?: string | null }) =>
    request("/auth/users", { method: "POST", body: JSON.stringify(data) }),
  updateUserRole: (id: string, role_id: string | null) =>
    request(`/auth/users/${id}/role`, { method: "PUT", body: JSON.stringify({ role_id }) }),
  resetUserPassword: (id: string, password: string) =>
    request(`/auth/users/${id}/password`, { method: "PUT", body: JSON.stringify({ password }) }),
  deleteUser: (id: string) =>
    request(`/auth/users/${id}`, { method: "DELETE" }),

  // Roles (admin only)
  getRoles: () => request<Role[]>("/roles"),
  createRole: (data: { name: string; permissions: string[] }) =>
    request<Role>("/roles", { method: "POST", body: JSON.stringify(data) }),
  updateRole: (id: string, data: { name?: string; permissions?: string[] }) =>
    request<Role>(`/roles/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteRole: (id: string) => request(`/roles/${id}`, { method: "DELETE" }),

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

  // AI 简历解析（后端代理，调用 DeepSeek）
  parseResume: (text: string) =>
    request<{
      name: string;
      phone: string;
      email: string;
      age: number | null;
      gender: string;
      education: string;
      school: string;
      current_company: string;
      current_title: string;
      years_experience: number | null;
      city: string;
      skills: string[];
      birth_date: string;
    }>("/parse-resume", {
      method: "POST",
      body: JSON.stringify({ text }),
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

  getResumeDownloadUrl: (talentId: string) =>
    `${BASE}/talents/${talentId}/resume?token=${getToken() || ""}&download=1`,

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
  getTemplates: (params: { category?: string; q?: string; page?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params.category) qs.set("category", params.category);
    if (params.q) qs.set("q", params.q);
    if (params.page) qs.set("page", String(params.page));
    if (params.limit) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<{ items: DocTemplate[]; total: number }>(`/templates${suffix}`);
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

  // ---- 岗位管理 ----
  getJobs: (params: Record<string, string | number> = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== "" && v != null).map(([k, v]) => [k, String(v)])
    ).toString();
    return request<PaginatedResponse<Job>>(`/jobs${qs ? `?${qs}` : ""}`);
  },
  getJobOptions: (onlyOpen = false) =>
    request<(Pick<Job, "id" | "title" | "department" | "city" | "status" | "headcount">)[]>(
      `/jobs/options${onlyOpen ? "?open=1" : ""}`
    ),
  getDepartments: () => request<string[]>("/jobs/departments"),
  getJob: (id: string) => request<JobDetail>(`/jobs/${id}`),
  createJob: (data: Partial<Job>) =>
    request<{ id: string }>("/jobs", { method: "POST", body: JSON.stringify(data) }),
  updateJob: (id: string, data: Partial<Job>) =>
    request(`/jobs/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteJob: (id: string) => request(`/jobs/${id}`, { method: "DELETE" }),

  // ---- 招聘流程 ----
  getPipeline: (params: { job_id?: string; owner_id?: string; q?: string } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][]
    ).toString();
    return request<PipelineResponse>(`/pipeline${qs ? `?${qs}` : ""}`);
  },
  addToPipeline: (data: { talent_id: string; job_id: string; stage?: string; notes?: string }) =>
    request<{ id: string; talent_name: string; job_title: string; stage: string }>("/pipeline", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateStage: (linkId: string, stage: string, remark?: string) =>
    request<{ ok: boolean; stage: string }>(`/pipeline/${linkId}/stage`, {
      method: "PUT",
      body: JSON.stringify({ stage, remark }),
    }),
  getStageLogs: (linkId: string) => request<StageLog[]>(`/pipeline/${linkId}/logs`),
  removeFromPipeline: (linkId: string) =>
    request(`/pipeline/${linkId}`, { method: "DELETE" }),
  getStaleCandidates: () =>
    request<{ items: (PipelineCard & { days_stale: number })[]; total: number }>("/pipeline/stale"),

  // ---- 跟进待办 ----
  getTasks: (params: { scope?: string; talent_id?: string; priority?: string; owner_id?: string } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][]
    ).toString();
    return request<{ items: Task[]; total: number }>(`/tasks${qs ? `?${qs}` : ""}`);
  },
  getTaskSummary: () => request<TaskSummary>("/tasks/summary"),
  createTask: (data: Partial<Task>) =>
    request<{ id: string }>("/tasks", { method: "POST", body: JSON.stringify(data) }),
  updateTask: (id: string, data: Partial<Task>) =>
    request(`/tasks/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  updateTaskStatus: (id: string, status: string) =>
    request(`/tasks/${id}/status`, { method: "PUT", body: JSON.stringify({ status }) }),
  deleteTask: (id: string) => request(`/tasks/${id}`, { method: "DELETE" }),
};
