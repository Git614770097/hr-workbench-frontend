import { message } from "antd";
import type { User, UserRow, Talent, TalentDetailData, DocTemplate, PaginatedResponse, Role, Job, JobDetail, PipelineCard, PipelineResponse, StageLog, FunnelResponse, Task, TaskSummary, OverviewResponse, MatchProfile, MatchResult, ComplianceResponse, ContractItem, ContractSyncResult, ContractFile, ContractUploadResult, SocialItem, SocialRateTemplate, SocialRateInput, Interview, Requisition, ApprovalFlow, ApprovalInstance, OnboardingItem } from "./types";

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
  } catch (e) {
    clearTimeout(timer);
    // 区分两种失败：主动超时（abort）与真正的网络不可达。
    // 之前一律报「请求超时或网络异常」，把真实原因盖掉了，排障时非常误导。
    if ((e as Error)?.name === "AbortError") {
      throw new Error(`请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒），请稍后重试`);
    }
    throw new Error("网络异常，无法连接服务器，请检查网络后重试");
  }
  clearTimeout(timer);

  if (res.status === 401) {
    localStorage.removeItem("token");
    window.location.href = "/login";
    throw new Error("未登录");
  }

  if (!res.ok) {
    const err = (await res.json().catch(() => ({ error: "请求失败" }))) as { error?: string; code?: string };
    // 账户已冻结（到期未续费）：只读，任何写操作被后端拦截，这里给出统一提示
    if (res.status === 403 && err.code === "FROZEN") {
      message.error("账户已冻结，仅可查看；续费后恢复使用");
    }
    throw new Error(err.error || "请求失败");
  }

  return res.json() as Promise<T>;
}

export const api = {
  // Auth
  getCaptcha: () =>
    request<{ captcha_id: string; svg: string }>("/auth/captcha"),

  // 登录：手机号 + 密码 + 图文验证码（登录不发短信，省费用；注册仍用短信验证）
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
  // ref 为选填邀请码：非法码后端静默忽略，不影响注册结果
  // intended_role 为自报身份（hr/headhunter），仅作审批参考，不授予权限
  // sms_code 为短信验证码（注册用短信校验替代图形验证码）
  register: (data: { phone: string; name: string; password: string; sms_code: string; ref?: string; intended_role?: string }) =>
    request<{ ok: boolean; message: string }>("/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // 注册短信验证码下发（公开，无需登录）
  sendSms: (phone: string) =>
    request<{ ok: boolean }>("/auth/sms/send", {
      method: "POST",
      body: JSON.stringify({ phone }),
    }),

  // 我的推广：邀请码 / 邀请链接 / 已邀请列表 / 奖励规则
  getReferral: () =>
    request<{
      code: string;
      link: string;
      config: { enabled: boolean; referrerMonths: number; inviteeMonths: number; capMonthsPerYear: number };
      invited: {
        name: string; phone: string; status: string;
        created_at: string; rewarded_at: string | null; reward_months: number | null;
      }[];
    }>("/auth/me/referral"),

  // 忘记密码：提交重置申请（短信验证码校验，由管理员核对后处理）
  forgotPassword: (data: { phone: string; name: string; sms_code: string }) =>
    request<{ ok: boolean; message: string }>("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // 修改自己的密码
  changeMyPassword: (data: { old_password: string; new_password: string }) =>
    request("/auth/me/password", { method: "PUT", body: JSON.stringify(data) }),

  // 个人推送设置：保存/清空 PushPlus token
  updateMyPushplus: (token: string) =>
    request<{ ok: boolean; configured: boolean }>("/auth/me/pushplus", {
      method: "PUT",
      body: JSON.stringify({ token }),
    }),
  // 给当前用户推一条测试消息
  testMyPushplus: () =>
    request<{ ok: boolean; message: string }>("/auth/me/pushplus/test", { method: "POST" }),

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
  // 修改用户「身份」（hr/headhunter/team/other）—— 只影响品牌文案，不影响权限
  updateUserIntendedRole: (id: string, intended_role: string | null) =>
    request(`/auth/users/${id}/intended-role`, { method: "PUT", body: JSON.stringify({ intended_role }) }),
  resetUserPassword: (id: string, password: string) =>
    request(`/auth/users/${id}/password`, { method: "PUT", body: JSON.stringify({ password }) }),
  deleteUser: (id: string) =>
    request(`/auth/users/${id}`, { method: "DELETE" }),

  // 会员开通 / 续期 / 清空（管理员确认收款后操作）
  setMembership: (id: string, data: { months?: number; paid_until?: string; clear?: boolean }) =>
    request(`/auth/users/${id}/membership`, { method: "PUT", body: JSON.stringify(data) }),
  // 支付收款配置（收款码 + 说明），向用户展示
  getPayConfig: () =>
    request<{ wechat_qr: string | null; alipay_qr: string | null; note: string | null }>("/auth/settings/pay"),
  setPayConfig: (data: { wechat_qr?: string; alipay_qr?: string; note?: string }) =>
    request("/auth/settings/pay", { method: "PUT", body: JSON.stringify(data) }),
  // 数据字典（来源渠道 / 淘汰原因 / 学历 / 职位类型），管理员可配置
  getDictConfig: () =>
    request<{
      sources: string[];
      reject_reasons: string[];
      education: string[];
      job_types: Record<string, string>;
    }>("/auth/settings/dict"),
  setDictConfig: (data: {
    sources?: string[];
    reject_reasons?: string[];
    education?: string[];
    job_types?: Record<string, string>;
  }) =>
    request<{ ok: boolean }>("/auth/settings/dict", { method: "PUT", body: JSON.stringify(data) }),
  // 更新公告（首屏弹窗用）：GET 登录可见，PUT 仅管理员
  getChangelog: () =>
    request<{ version: string | null; title: string | null; updated_at: string | null; items: string[] }>(
      "/auth/settings/changelog"
    ),
  setChangelog: (data: { version: string; title?: string; updated_at?: string; items: string[] }) =>
    request<{ ok: boolean }>("/auth/settings/changelog", { method: "PUT", body: JSON.stringify(data) }),
  // 当前用户付款后申请开通会员（推送通知管理员）
  requestMembership: () =>
    request<{ ok: boolean; message?: string; error?: string }>("/auth/me/membership-request", { method: "POST" }),

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

  // 示例数据（演示模式）：一键载入 / 一键清除
  seedDemo: () =>
    request<{ ok: boolean; seeded: { jobs: number; talents: number; tasks: number } }>("/demo/seed", {
      method: "POST",
    }),

  clearDemo: () =>
    request<{ ok: boolean; removed: { talents: number; jobs: number } }>("/demo/seed", {
      method: "DELETE",
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

  // ---- 社保公积金台账 ----
  getSocialList: (q?: string) =>
    request<SocialItem[]>(`/talents/social${q ? `?q=${encodeURIComponent(q)}` : ""}`),

  // 编辑参保信息（upsert），后端保存后即同步增减员待办
  updateSocial: (talentId: string, data: Partial<SocialItem>) =>
    request<{ ok: true }>(`/talents/social/${talentId}`, { method: "PUT", body: JSON.stringify(data) }),

  // 增减员待办批量同步（幂等）
  syncSocialTasks: () =>
    request<ContractSyncResult>("/talents/social/sync-tasks", { method: "POST" }),

  // 参保城市费率模板：内置参考值（is_system）+ 自己维护的，同城自己的优先
  getSocialRates: () =>
    request<SocialRateTemplate[]>("/talents/social/rates"),

  // 新增 / 覆盖自己城市下的默认比例
  saveSocialRate: (data: SocialRateInput) =>
    request<{ ok: true; city: string }>("/talents/social/rates", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  deleteSocialRate: (id: string) =>
    request<{ ok: true }>(`/talents/social/rates/${id}`, { method: "DELETE" }),

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
    return request<{ items: DocTemplate[]; total: number; page: number; limit: number; pages: number }>(`/templates${suffix}`);
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

  // ---- 招聘看板 ----
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
  // 阶段停滞 → 待办同步（幂等，可重复调用）：返回本次新建/更新/取消数量
  syncStaleTasks: () =>
    request<{ created: number; updated: number; cancelled: number; total: number }>(
      "/pipeline/sync-stale-tasks",
      { method: "POST" }
    ),
  // 批量流转：看板多选 → 一次推进或淘汰（淘汰传 rejectReason 统一记原因）
  batchUpdateStage: (data: { link_ids: string[]; stage: string; reject_reason?: string; remark?: string }) =>
    request<{ updated: number; skipped: number; hired_linked: number; names: string[] }>(
      "/pipeline/batch-stage",
      { method: "POST", body: JSON.stringify(data) }
    ),

  // 人才库批量操作（收人才 id，与看板批量流转区分路由）
  batchTags: (data: { ids: string[]; tags: string[]; mode?: "replace" | "add" }) =>
    request<{ updated: number; skipped: number }>("/talents/batch/tags", { method: "POST", body: JSON.stringify(data) }),
  batchStageTalents: (data: { ids: string[]; stage: string }) =>
    request<{ updated: number; skipped: number }>("/talents/batch/stage", { method: "POST", body: JSON.stringify(data) }),
  batchDeleteTalents: (data: { ids: string[] }) =>
    request<{ deleted: number }>("/talents/batch/delete", { method: "POST", body: JSON.stringify(data) }),

  // ---- 招聘漏斗 ----
  getFunnel: (params: { job_id?: string; owner_id?: string; days?: number } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== 0)
        .map(([k, v]) => [k, String(v)]) as [string, string][]
    ).toString();
    return request<FunnelResponse>(`/pipeline/funnel${qs ? `?${qs}` : ""}`);
  },

  // ---- 待办日历 ----
  getTasks: (params: { scope?: string; talent_id?: string; priority?: string; owner_id?: string } = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][]
    ).toString();
    return request<{ items: Task[]; total: number }>(`/tasks${qs ? `?${qs}` : ""}`);
  },
  getTaskSummary: () => request<TaskSummary>("/tasks/summary"),
  // 招聘概览首页聚合（全员可看，按 owner 隔离）
  getOverview: () => request<OverviewResponse>("/overview"),
  createTask: (data: Partial<Task>) =>
    request<{ id: string }>("/tasks", { method: "POST", body: JSON.stringify(data) }),
  updateTask: (id: string, data: Partial<Task>) =>
    request(`/tasks/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  updateTaskStatus: (id: string, status: string) =>
    request(`/tasks/${id}/status`, { method: "PUT", body: JSON.stringify({ status }) }),
  deleteTask: (id: string) => request(`/tasks/${id}`, { method: "DELETE" }),

  // 面试管理（面试安排 + 面试评价）
  // filters: talent_job_id / talent_id / job_id / status / owner_id(admin)
  getInterviews: (params: { talent_job_id?: string; talent_id?: string; job_id?: string; status?: string; owner_id?: string } = {}) => {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");
    return request<{ items: Interview[] }>(`/interviews${qs ? `?${qs}` : ""}`);
  },
  createInterview: (data: Partial<Interview>) =>
    request<{ ok: boolean; item: Interview; advanced_to?: string | null }>("/interviews", { method: "POST", body: JSON.stringify(data) }),
  updateInterview: (id: string, data: Partial<Interview>) =>
    request<{ ok: boolean; item: Interview; advanced_to?: string | null }>(`/interviews/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteInterview: (id: string) => request<{ ok: boolean }>(`/interviews/${id}`, { method: "DELETE" }),

  // 招聘需求（用人部门提需求 → 审批 → 一键转岗位）
  getRequisitions: (params: { status?: string; owner_id?: string } = {}) => {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");
    return request<{ items: Requisition[] }>(`/requisitions${qs ? `?${qs}` : ""}`);
  },
  createRequisition: (data: Partial<Requisition>) =>
    request<{ ok: boolean; id: string }>("/requisitions", { method: "POST", body: JSON.stringify(data) }),
  approveRequisition: (id: string) =>
    request<{ ok: boolean; job_id: string }>(`/requisitions/${id}/approve`, { method: "POST", body: "{}" }),
  rejectRequisition: (id: string, reason?: string) =>
    request<{ ok: boolean }>(`/requisitions/${id}/reject`, { method: "POST", body: JSON.stringify({ reason }) }),

  // 审批流
  getApprovalFlows: () => request<{ items: ApprovalFlow[] }>("/approvals/flows"),
  createApprovalFlow: (data: { name: string; scene: string; steps: { name: string }[] }) =>
    request<{ ok: boolean; id: string }>("/approvals/flows", { method: "POST", body: JSON.stringify(data) }),
  deleteApprovalFlow: (id: string) => request<{ ok: boolean }>(`/approvals/flows/${id}`, { method: "DELETE" }),
  getApprovalInstances: (params: { status?: string } = {}) => {
    const qs = params.status ? `?status=${encodeURIComponent(params.status)}` : "";
    return request<{ items: ApprovalInstance[] }>(`/approvals/instances${qs}`);
  },
  createApprovalInstance: (data: { talent_job_id: string; scene?: string; flow_id?: string; title?: string; payload?: unknown }) =>
    request<{ ok: boolean; id: string; total_steps: number }>("/approvals/instances", { method: "POST", body: JSON.stringify(data) }),
  decideApproval: (id: string, decision: "approve" | "reject", comment?: string) =>
    request<{ ok: boolean; status: string; downstream?: string[] }>(`/approvals/instances/${id}/decide`, { method: "POST", body: JSON.stringify({ decision, comment }) }),
  cancelApproval: (id: string) =>
    request<{ ok: boolean }>(`/approvals/instances/${id}/cancel`, { method: "POST", body: "{}" }),

  // 入职办理（材料清单）
  getOnboardingItems: (params: { talent_id?: string; talent_job_id?: string } = {}) => {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");
    return request<{ items: OnboardingItem[]; progress: { total: number; done: number; percent: number } }>(
      `/onboarding${qs ? `?${qs}` : ""}`
    );
  },
  initOnboarding: (talent_id: string, talent_job_id?: string) =>
    request<{ ok: boolean; created: number }>("/onboarding/init", { method: "POST", body: JSON.stringify({ talent_id, talent_job_id }) }),
  createOnboardingItem: (data: Partial<OnboardingItem>) =>
    request<{ ok: boolean; id: string }>("/onboarding", { method: "POST", body: JSON.stringify(data) }),
  updateOnboardingItem: (id: string, data: Partial<OnboardingItem>) =>
    request<{ ok: boolean }>(`/onboarding/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteOnboardingItem: (id: string) => request<{ ok: boolean }>(`/onboarding/${id}`, { method: "DELETE" }),
};
