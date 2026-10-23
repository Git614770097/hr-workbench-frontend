// AI 调用与返回解析的公共封装。
// 简历解析（aiParse）与人才AI匹配（match）都要用，抽出来避免两份几乎一样的 fetch + 取 JSON 逻辑。
//
// ── 供应商策略（2026-10-23 调整）────────────────────────────────────────
// **DeepSeek 优先，智谱 GLM-4.7-Flash 兜底。**
// 早先是智谱优先（免费档省钱），但智谱免费档「同时 1 个并发」，高峰期经常 17s+ 才响应、
// 甚至直接 429，导致每次 AI 调用先白等一段时间才回落——用户体验就是「一直在转」。
// DeepSeek 实测约 100 tok/s、稳定性好，单次成本极低（一份周报约 0.002 元），
// 所以让它当主路径，把智谱降为「DeepSeek 不可用时」的备份，省下的等待远比省下的钱值。
// 未配置 DeepSeek Key 时行为不变，直接走智谱。
// ────────────────────────────────────────────────────────────────────────

/** 从 AI 返回内容里稳健地抽出 JSON 对象（兼容被 ```json 包裹 / 前后有杂文的情况） */
export function extractJson(text: string): Record<string, unknown> | null {
  // 去掉 markdown 代码块围栏
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 直接解析
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Record<string, unknown>;
  } catch {
    /* fallthrough */
  }
  // 截取第一个 { 到最后一个 } 之间的内容再解析
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(s.slice(start, end + 1));
      if (obj && typeof obj === "object") return obj as Record<string, unknown>;
    } catch {
      /* fallthrough */
    }
  }
  return null;
}

/** AI 调用的 token 用量 */
export interface AiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** 一次 AI 调用所用的 Key 集合：DeepSeek 优先，智谱兜底 */
export interface AiKeys {
  /** 智谱 GLM Key（兜底）；DeepSeek 不可用时才用 */
  zhipu?: string | null;
  /** DeepSeek Key（优先） */
  deepseek?: string | null;
}

/** 兼容旧调用：只传一个 string 视为 DeepSeek Key */
export type AiKeyInput = string | AiKeys | (AiKeys & { key?: string | null }) | null | undefined;

function toKeys(input: AiKeyInput): AiKeys {
  if (!input) return {};
  if (typeof input === "string") return { deepseek: input };
  // 兼容 resolveAiKey 的返回形状：它的 `key` 就是 DeepSeek Key（字段名沿用历史）
  const any = input as AiKeys & { key?: string | null };
  return { zhipu: any.zhipu, deepseek: any.deepseek ?? any.key ?? null };
}

const ZHIPU_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const ZHIPU_MODEL = "glm-4.7-flash";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";

type Provider = "zhipu" | "deepseek";

const PROVIDER_LABEL: Record<Provider, string> = {
  zhipu: "智谱 GLM",
  deepseek: "DeepSeek",
};

/** Base64url 编码（JWT 用） */
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 智谱 JWT 动态签名（2026 年起的认证方式）。
 * Key 为 `id.secret` 复合格式时必须走这个：用 secret 对 header.payload 做 HMAC-SHA256，
 * 生成 5 分钟有效的 JWT，作为 Bearer token 发出。
 * 直接把 id.secret 当 Bearer 发会得到 401「令牌已过期或验证不正确」。
 */
async function zhipuBearer(key: string): Promise<string> {
  const dot = key.indexOf(".");
  if (dot <= 0 || dot === key.length - 1) return `Bearer ${key}`; // 非 id.secret 格式，按静态 token 发
  const id = key.slice(0, dot);
  const secret = key.slice(dot + 1);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", sign_type: "SIGN" })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ api_key: id, exp: now + 300, timestamp: now })));
  const data = `${header}.${payload}`;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  return `Bearer ${data}.${b64url(new Uint8Array(sig))}`;
}

interface RawOk {
  ok: true;
  content: string;
  usage: AiUsage | null;
}
interface RawErr {
  ok: false;
  /** 人类可读的失败原因（日志用） */
  reason: string;
}
type RawResult = RawOk | RawErr;

/**
 * 单次调用某个供应商，返回原始文本内容。
 * 不做 JSON 解析、不抛错——把「要不要回落」的决策权交给上层。
 */
async function callProvider(
  provider: Provider,
  key: string,
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number }
): Promise<RawResult> {
  const url = provider === "zhipu" ? ZHIPU_URL : DEEPSEEK_URL;
  const model = provider === "zhipu" ? ZHIPU_MODEL : DEEPSEEK_MODEL;
  // 智谱的 id.secret 格式 Key 必须做 JWT 动态签名，直接当 Bearer 发会 401
  const auth = provider === "zhipu" ? await zhipuBearer(key) : `Bearer ${key}`;
  // ⚠️ 单次超时必须按供应商区分，不能都等 60s：
  // DeepSeek 是主路径，实测约 100 tok/s，40s 足够生成 4000 token；
  // 智谱只作兜底，免费档高峰期会长时间不响应（正常也要 17s+），只给 20s，拿不到就算了。
  // 最坏 40+20=60s，仍在前端 90s 之内，用户不会看到「请求超时」而其实后端还能成功。
  const timeoutMs = provider === "zhipu" ? 20_000 : 40_000;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: opts.temperature ?? 0,
        // 不传上限时模型默认 4096：按实测 100 tok/s 要 40s，正好卡在 DeepSeek 的
        // 超时边缘，且长输出更容易被截断成不完整 JSON。默认收在 3000。
        max_tokens: opts.maxTokens ?? 3000,
        response_format: { type: "json_object" },
        // ⚠️ GLM-4.7-Flash **默认开启思维链**：推理过程会吃光 max_tokens，
        // 导致 content 为空、响应拖到 17s+。本项目全是结构化 JSON 提取/生成，不需要推理。
        // 官方明确：disabled 后「响应更快、占用并发槽更短」，直接缓解免费档 429。
        // DeepSeek 不认这个字段，故只对智谱发送。
        ...(provider === "zhipu" ? { thinking: { type: "disabled" } } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!resp.ok) {
      // 429 = 免费档并发打满（预期内，静默回落）；401/403 = Key 问题；5xx = 上游抖动
      const body = await resp.text().catch(() => "");
      return { ok: false, reason: `HTTP ${resp.status} ${body.slice(0, 120)}` };
    }

    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { ok: false, reason: "响应无内容" };

    const u = data.usage;
    const usage: AiUsage | null =
      u && typeof u.total_tokens === "number"
        ? {
            prompt_tokens: Number(u.prompt_tokens) || 0,
            completion_tokens: Number(u.completion_tokens) || 0,
            total_tokens: Number(u.total_tokens) || 0,
          }
        : null;
    return { ok: true, content, usage };
  } catch (e) {
    // AbortSignal.timeout 抛 TimeoutError；网络不可达抛 TypeError
    return { ok: false, reason: (e as Error)?.name === "TimeoutError" ? `超时 ${timeoutMs / 1000}s` : `网络异常 ${(e as Error)?.message || ""}` };
  }
}

/**
 * 智谱熔断：免费档 1305「访问量过大」是常态而非故障，每次都先撞一次再回落，
 * 会让所有 AI 调用白付 0.3~0.5s。连续失败后短时间内直接跳过智谱，到期自动再试。
 * 存在 isolate 级全局变量（同一 isolate 内共享，跨 isolate 不保证）——最佳努力即可。
 *
 * 智谱现在只是**兜底**，只有 DeepSeek 失败才会走到它，所以这个熔断主要是防止
 * 「DeepSeek 挂了 + 智谱也在 429」时每一单都白等 20s。
 */
let zhipuOpenUntil = 0;
let zhipuFails = 0;
const ZHIPU_COOLDOWN_MS = 60_000;
const ZHIPU_FAIL_THRESHOLD = 2;

/**
 * 按「DeepSeek 优先 → 智谱兜底」的顺序跑完一次调用，返回第一个成功解析出 JSON 的结果。
 * 任一环的失败（429/超时/解析失败）都继续走下一环，全部失败返回 null。
 *
 * 为什么要倒过来：智谱免费档「同时 1 个并发」，高峰期首字节经常 17s+ 才回来，
 * 每次调用都先撞它等于每次白等十几秒；DeepSeek 稳定在 100 tok/s，等待时间可预期。
 */
async function callWithFallback(
  apiKey: AiKeyInput,
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number }
): Promise<{ data: Record<string, unknown>; usage: AiUsage | null; provider: Provider } | null> {
  const keys = toKeys(apiKey);
  const zhipuCooled = Date.now() < zhipuOpenUntil;
  const chain: { provider: Provider; key: string | null | undefined }[] = [
    { provider: "deepseek", key: keys.deepseek },
    { provider: "zhipu", key: zhipuCooled ? null : keys.zhipu },
  ];

  for (const step of chain) {
    if (!step.key) continue;
    const raw = await callProvider(step.provider, step.key, system, user, opts);
    if (!raw.ok) {
      if (step.provider === "zhipu") {
        zhipuFails += 1;
        if (zhipuFails >= ZHIPU_FAIL_THRESHOLD) {
          zhipuOpenUntil = Date.now() + ZHIPU_COOLDOWN_MS;
          zhipuFails = 0;
          console.log(`[ai] 智谱连续 ${ZHIPU_FAIL_THRESHOLD} 次不可用，熔断 ${ZHIPU_COOLDOWN_MS / 1000}s`);
        }
        // 1305/1302 是免费档常态，不刷屏；其余错误才记
        if (!/^HTTP (429|503)/.test(raw.reason)) {
          console.log(`[ai] 智谱兜底也失败: ${raw.reason}`);
        }
      } else {
        // DeepSeek 是主路径，失败一定要记（这是真异常，不是预期内的限流）
        console.log(`[ai] DeepSeek 失败，回落智谱: ${raw.reason}`);
      }
      continue;
    }
    const parsed = extractJson(raw.content);
    if (!parsed) {
      console.log(`[ai] ${PROVIDER_LABEL[step.provider]} 返回内容解析不出 JSON，换下一个供应商`);
      if (step.provider === "zhipu") zhipuFails += 1;
      continue;
    }
    // 成功即清零失败计数
    if (step.provider === "zhipu") {
      zhipuFails = 0;
      zhipuOpenUntil = 0;
    }
    return { data: parsed, usage: raw.usage, provider: step.provider };
  }
  return null;
}

/**
 * 调 AI 并取回 JSON 对象 + token 用量（DeepSeek 优先，智谱兜底）。
 * 约定用 response_format=json_object，但仍走 extractJson 兜底（模型偶尔会带围栏）。
 * 超时按供应商区分（DeepSeek 40s / 智谱 20s），超时后必须中断，避免前端永久挂起。
 * 失败/无内容/解析不出 JSON 时返回 null（调用方降级），不抛错。
 */
export async function deepseekJsonWithUsage(
  apiKey: AiKeyInput,
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<{ data: Record<string, unknown>; usage: AiUsage | null } | null> {
  const r = await callWithFallback(apiKey, system, user, opts);
  return r ? { data: r.data, usage: r.usage } : null;
}

/**
 * 调 AI 并取回 JSON 对象（DeepSeek 优先，智谱兜底）。
 * 与 deepseekJsonWithUsage 的差别只在不返回 usage；两者都失败时抛错（调用方需捕获）。
 */
export async function deepseekJson(
  apiKey: AiKeyInput,
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<Record<string, unknown> | null> {
  const r = await callWithFallback(apiKey, system, user, opts);
  if (!r) throw new Error("AI 调用失败（DeepSeek 与智谱均不可用）");
  return r.data;
}

/**
 * 安全版 AI 调用：超时或任何异常时返回 null 而非抛错。
 * 调用方根据返回值自行决定降级策略（规则兜底 / 基础解析 / 提示用户）。
 */
export async function deepseekJsonSafe(
  apiKey: AiKeyInput,
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<Record<string, unknown> | null> {
  try {
    return await deepseekJson(apiKey, system, user, opts);
  } catch {
    return null;
  }
}

/** 把 AI 返回的任意值安全转成长度受限的字符串数组（用于 reasons / gaps / risks） */
export function toStringArray(v: unknown, max = 5): string[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  return arr
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .slice(0, max);
}
