import type { User, Talent, Tag, Communication, PaginatedResponse } from "./types";

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
    const err = await res.json().catch(() => ({ error: "请求失败" }));
    throw new Error(err.error || "请求失败");
  }

  return res.json() as Promise<T>;
}

export const api = {
  register: (data: { email: string; name: string; password: string }) =>
    request<{ id: string; email: string; name: string; token: string }>("/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    }).then((r) => {
      localStorage.setItem("token", r.token);
      return r;
    }),

  login: (data: { email: string; password: string }) =>
    request<{ id: string; email: string; name: string; token: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify(data),
    }).then((r) => {
      localStorage.setItem("token", r.token);
      return r;
    }),

  me: () => request<User>("/auth/me"),
  logout: () => request("/auth/logout", { method: "POST" }),

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

  getTags: () => request<(Tag & { talent_count?: number })[]>("/tags"),
  createTag: (data: { name: string; color?: string }) =>
    request<Tag>("/tags", { method: "POST", body: JSON.stringify(data) }),
  updateTag: (id: string, data: { name?: string; color?: string }) =>
    request(`/tags/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteTag: (id: string) => request(`/tags/${id}`, { method: "DELETE" }),

  getCommunications: (talentId: string) =>
    request<Communication[]>(`/communications/talent/${talentId}`),
  createCommunication: (data: Partial<Communication>) =>
    request<Communication>("/communications", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteCommunication: (id: string) =>
    request(`/communications/${id}`, { method: "DELETE" }),
};
