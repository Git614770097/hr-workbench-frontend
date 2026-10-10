// KV 读取兼容层。
//
// 背景（安全修复）：prod 的 SESSIONS 与 RESUMES 曾经共用同一个 namespace（id 相同），
// 会话数据与简历/合同文件混存。现已将 SESSIONS 拆到独立 namespace。
//
// 为让「拆分前签发的会话」继续可用（用户不被强制登出），会话类 key 在新 namespace
// 未命中时回退到旧 namespace —— 旧数据仍留在 RESUMES 绑定的那个旧 namespace 里。
// 旧会话最长 7 天过期，到期后回退分支自然失效，可择机删除。
type KVEnv = { SESSIONS: KVNamespace; RESUMES: KVNamespace };

/** 读会话/token：先新 SESSIONS namespace，未命中回退旧 namespace（RESUMES 绑定）。 */
export async function sessionGet(env: KVEnv, key: string): Promise<string | null> {
  const v = await env.SESSIONS.get(key);
  if (v !== null && v !== undefined) return v;
  return env.RESUMES.get(key);
}
