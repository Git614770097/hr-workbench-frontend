import type { User, UserRow, Talent, TalentDetailData, DocTemplate, PaginatedResponse, Role, Job, JobDetail, PipelineCard, PipelineResponse, StageLog, FunnelResponse, Task, TaskSummary, MatchProfile, MatchResult, ComplianceResponse, ContractItem, ContractSyncResult, ContractFile, ContractUploadResult } from "./types";

const BASE = "/api";

function getToken(): string | null {
  return localStorage.getItem("token");
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  timeoutMs = 15000
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  // 前端超时兜底：D1 冷启动或网络异常时 fetch 可能长时间挂起（无超时），
  // 会导致首屏 loading 永久转圈、页面出不来。超时后抛错交由上层重试。
  // AI 类接口（生成画像 / JD / 评分）耗时远超普通查询，单独传更长的 timeoutMs。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...options, headers, signal: controller.signal });
  } catch {
    clearTimeout(timer);
    throw new Error("请求超时或网络异常，请稍后重试");
  }
  clearTimeout(timer);

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

  // 自助注册（注册后为 pending 状态，需管理员审批）
  register: (data: { phone: string; name: string; password: string; captcha_id: string; captcha: string }) =>
    request<{ ok: boolean; message: string }>("/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // 忘记密码：提交重置申请（无短信通道，由管理员核对后处理）
  forgotPassword: (data: { phone: string; name: string; captcha_id: string; captcha: string }) =>
    request<{ ok: boolean; message: string }>("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // 修改自己的密码
  changeMyPassword: (data: { old_password: string; new_password: string }) =>
    request("/auth/me/password", { method: "PUT", body: JSON.stringify(data) }),

  // User management (admin only)
  getUsers: (status?: string) =>
    request<UserRow[]>(`/auth/users${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  // 有待处理忘记密码申请的用户
  getResetRequests: () => request<UserRow[]>("/auth/users?reset=1"),
  // 处理忘记密码申请：action=reset 会同时设置新密码
  resolveReset: (id: string, action: "reset" | "dismiss", password?: string) =>
    request(`/auth/users/${id}/reset-password`, {
      method: "PUT",
      body: JSON.stringify({ action, password }),
    }),
  createUser: (data: { phone: string; name: string; password: string; role_id?: string | null }) =>
    request("/auth/users", { method: "POST", body: JSON.stringify(data) }),
  // 审批通过注册申请（可同时分配角色）
  approveUser: (id: string, role_id: string | null) =>
    request(`/auth/users/${id}/approve`, { method: "PUT", body: JSON.stringify({ role_id }) }),
  // 拒绝注册申请
  rejectUser: (id: string) =>
    request(`/auth/users/${id}/reject`, { method: "PUT" }),
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

  getTalent: (id: string) => request<TalentDetailData>(`/talents/${id}`),

  createTalent: (data: Partial<Talent>) =>
    request<Talent>("/talents", { method: "POST", body: JSON.stringify(data) }),

  updateTalent: (id: string, data: Partial<Talent>) =>
    request<Talent>(`/talents/${id}`, { method: "PUT", body: JSON.stringify(data) }),

  deleteTalent: (id: string) =>
    request(`/talents/${id}`, { method: "DELETE" }),

  importTalents: (data: Partial<Talent>[]) =>
    request<{ imported: number; items: { id: string; name: string }[] }>("/talents/import", {
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
  // 读取人才库里已存的简历文件（智能匹配勾选库内人选时，重新抽取原文做语义比对）
  // 返回 null 表示这条人才没存简历文件，调用方需回退到「用已录入字段拼文本」
  fetchResumeFile: async (talentId: string): Promise<{ blob: Blob; name: string } | null> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res: Response;
    try {
      res = await fetch(`${BASE}/talents/${talentId}/resume`, {
        headers: { Authorization: `Bearer ${getToken()}` },
        signal: ctrl.signal,
      });
    } catch {
      clearTimeout(timer);
      throw new Error("简历读取超时，请重试");
    }
    clearTimeout(timer);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("简历文件读取失败");
    // 文件名只能从 Content-Disposition 拿：解析走 PDF 还是 Word 全靠后缀判断
    const m = (res.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/);
    return { blob: await res.blob(), name: m ? decodeURIComponent(m[1]) : "" };
  },

  uploadResume: (talentId: string, file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("talent_id", talentId);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    return fetch(`${BASE}/talents/resume`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getToken()}` },
      body: formData,
      signal: ctrl.signal,
    }).then(async (res) => {
      clearTimeout(timer);
      if (!res.ok) {
        const err = (await res.json().catch(() => ({ error: "上传失败" }))) as { error?: string };
        throw new Error(err.error || "上传失败");
      }
      return res.json();
    }, (e) => {
      clearTimeout(timer);
      throw e;
    });
  },

  getResumeUrl: (talentId: string) =>
    `${BASE}/talents/${talentId}/resume?token=${getToken() || ""}`,

  getResumeDownloadUrl: (talentId: string) =>
    `${BASE}/talents/${talentId}/resume?token=${getToken() || ""}&download=1`,

  deleteResume: (talentId: string) =>
    request(`/talents/${talentId}/resume`, { method: "DELETE" }),

  // 合规到期扫描：合同 / 试用期 30 天内到期（含已过期未更新）
  getTalentCompliance: () =>
    request<ComplianceResponse>("/talents/compliance"),

  // 合同管理：有合同/试用期日期的人才清单
  getContracts: (q?: string) =>
    request<ContractItem[]>(`/talents/contracts${q ? `?q=${encodeURIComponent(q)}` : ""}`),

  // 合同到期提醒批量同步（幂等：新建/更新/取消待办）
  syncContractTasks: () =>
    request<ContractSyncResult>("/talents/contracts/sync-tasks", { method: "POST" }),

  // 合同文件上传（multipart：file + talent_id + text）。
  // text 为前端抽取的合同全文，后端用它调 AI 识别日期；AI 类接口传长超时。
  uploadContractFile: (talentId: string, file: File, text: string) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("talent_id", talentId);
    formData.append("text", text);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    return fetch(`${BASE}/talents/contracts/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getToken()}` },
      body: formData,
      signal: ctrl.signal,
    }).then(async (res) => {
      clearTimeout(timer);
      if (!res.ok) {
        const err = (await res.json().catch(() => ({ error: "上传失败" }))) as { error?: string };
        throw new Error(err.error || "上传失败");
      }
      return res.json() as Promise<ContractUploadResult>;
    }, (e) => {
      clearTimeout(timer);
      throw e;
    });
  },

  // 合同文件列表（按人才）
  getContractFiles: (talentId: string) =>
    request<ContractFile[]>(`/talents/contracts/files?talent_id=${encodeURIComponent(talentId)}`),

  // 合同文件预览 / 下载地址（带 token，可直接给 <a> / iframe 用）
  getContractFileUrl: (fileId: string, download = false) =>
    `${BASE}/talents/contracts/files/${fileId}/file?token=${getToken() || ""}${download ? "&download=1" : ""}`,

  deleteContractFile: (fileId: string) =>
    request(`/talents/contracts/files/${fileId}`, { method: "DELETE" }),

  // 智能匹配（简历 + 人才画像 → 排序推荐）
  // 按职位生成招聘 JD（AI 起草，用户可改后再提炼画像）
  generateJd: (jobTitle: string, city?: string) =>
    request<{ jd: string }>(
      "/match/generate-jd",
      { method: "POST", body: JSON.stringify({ job_title: jobTitle, city }) },
      60000
    ),

  generateMatchProfile: (jd: string) =>
    request<MatchProfile>(
      "/match/parse-profile",
      {
        method: "POST",
        body: JSON.stringify({ jd }),
      },
      60000
    ),

  getMatchProfiles: () => request<MatchProfile[]>("/match/profiles"),

  createMatchProfile: (data: Partial<MatchProfile>) =>
    request<{ id: string }>("/match/profiles", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateMatchProfile: (id: string, data: Partial<MatchProfile>) =>
    request<{ id: string }>(`/match/profiles/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  deleteMatchProfile: (id: string) =>
    request(`/match/profiles/${id}`, { method: "DELETE" }),

  scoreCandidate: (profile: MatchProfile, candidate: { text: string; parsed?: Record<string, unknown> }) =>
    request<MatchResult>(
      "/match/score",
      {
        method: "POST",
        body: JSON.stringify({ profile, candidate }),
      },
      60000
    ),

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
  // scope 由后端裁决：official 仅管理员可写，普通用户提交会被降级为 shared
  createTemplate: (data: { name: string; category: string; content: string; scope?: string }) =>
    request<{ id: string }>("/templates", { method: "POST", body: JSON.stringify(data) }),
  updateTemplate: (id: string, data: Partial<{ name: string; category: string; content: string; scope: string }>) =>
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
  // 批量加入：人才库多选 → 一次挂到同一岗位；已在流程中的人自动跳过
  batchAddToPipeline: (data: { talent_ids: string[]; job_id: string; stage?: string; notes?: string }) =>
    request<{ added: number; skipped: number; added_names: string[]; skipped_names: string[]; job_title: string }>(
      "/pipeline/batch",
      { method: "POST", body: JSON.stringify(data) }
    ),
  // 淘汰时传 rejectReason：标准原因以【】前缀拼进流转备注，供漏斗分布统计；
  // 流转到 hired 时后端自动联动人才状态并生成试用期跟进待办，task_created 表示本次新建了待办
  updateStage: (linkId: string, stage: string, remark?: string, rejectReason?: string) =>
    request<{ ok: boolean; stage: string; task_created?: boolean }>(`/pipeline/${linkId}/stage`, {
      method: "PUT",
      body: JSON.stringify({ stage, remark, reject_reason: rejectReason }),
    }),
  getStageLogs: (linkId: string) => request<StageLog[]>(`/pipeline/${linkId}/logs`),
  removeFromPipeline: (linkId: string) =>
    request(`/pipeline/${linkId}`, { method: "DELETE" }),
  getStaleCandidates: () =>
    request<{ items: (PipelineCard & { days_stale: number })[]; total: number }>("/pipeline/stale"),

  // ---- 招聘漏斗 ----
  getFunnel: (params: { job_id?: string; owner_id?: string; days?: number } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== 0)
        .map(([k, v]) => [k, String(v)]) as [string, string][]
    ).toString();
    return request<FunnelResponse>(`/pipeline/funnel${qs ? `?${qs}` : ""}`);
  },

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
