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
  /** 实际出内容的供应商（智谱免费档成本为 0，前端据此计价） */
  provider?: "zhipu" | "deepseek";
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
        // ⚠️ 两家都**默认开启思维链**，必须显式关掉，且字段格式不同：
        //  - GLM-4.7-Flash：推理会吃光 max_tokens，content 变空、响应拖到 17s+；
        //    官方明确 disabled 后「响应更快、占用并发槽更短」，直接缓解免费档 429。
        //  - DeepSeek V4-Flash 0731：不传参 ≠ 关闭，服务端按任务复杂度自动路由到
        //    high 档，reasoning 能吃满整个 max_tokens 预算 → HTTP 200 但 content 空串。
        //    实测 27 份扫描件 OCR：不关思考时 15 份空正文、6 份截断，关掉后 27/27 正常。
        // 本项目全是结构化 JSON 提取/生成，不需要推理链，关掉纯赚（更快更省）。
        thinking: { type: "disabled" },
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
            provider,
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

// ── 视觉 OCR（图片型 PDF 兜底）───────────────────────────────────────────
//
// 为什么单独一条通道、不走 callWithFallback：
//  - 文本调用要 response_format=json_object 拿结构化结果；视觉这里要的是
//    **纯文本转录**，硬塞进同一个函数会把两套语义搅在一起；
//  - 视觉只有 deepseek-flash 支持（deepseek-v4-pro 不支持），没有「优先/兜底」
//    的余地，选型是固定的。
//
// ⚠️ 模型必须用 deepseek-flash：
//  - deepseek-v4-pro **不支持视觉**（官方能力表明确标了 Not supported）；
//  - 老的 deepseek-v4-flash-vision-exp 已被官方下线，请求会被转到最新的
//    Flash 模型，直接写新名字更清楚。
//
// 图片走 base64 data URL（官方推荐的内联方式）：候选人的简历不能传到公网
// 图床再让模型去下载，这是隐私红线。单张上限 32MiB、请求体 48MiB，够用。
//
// 成本：图片按尺寸折算 token，**每张上限 1024 token**（2000×2000 和 5000×5000
// 折算后一样）。一份简历一页 ≈ 1024 输入 token，按 $0.15/1M 算约 0.001 元。
//
// ⚠️⚠️ 必须显式传 thinking.type=disabled，这是踩过坑的：
//  deepseek-flash（V4-Flash 0731）**不传 thinking 不等于关闭思考**，服务端会按
//  任务复杂度自动路由到 high 档。而 max_tokens 是「推理 token + 正文 token」
//  共享的预算——high 档下 reasoning 能一口气吃满 8191 个 token，最终
//  **HTTP 200、usage 扣了钱、但 message.content 是空串**。
//  实测 27 份扫描件简历：不关思考时 15 份空正文 + 6 份截断（reasoning 占 87%~98%），
//  关掉后 27/27 全部 finish=stop，耗时还从 1.2~2.5s 降到 0.3~1.3s。
//  纯视觉转录不需要思维链，关掉纯赚。

const DEEPSEEK_VISION_MODEL = "deepseek-flash";
/** 视觉调用比纯文本慢（要传整页图），给 60s；批量导入时前端超时是 120s */
const VISION_TIMEOUT_MS = 60_000;
/** 非思考模式下的输出上限。8192 是 deepseek 允许的最大值，一页简历约 2500 token 够用 */
const VISION_MAX_TOKENS = 8192;

export interface OcrResult {
  ok: boolean;
  text: string;
  /** 失败原因（日志/前端提示用） */
  reason?: string;
  /**
   * 输出撞到 max_tokens 上限被截断（finish_reason=length）。
   * 此时 text 只有上半页——**不能当失败丢掉**（有总比没有强），
   * 但调用方必须记日志，前端也应提示重点核对，否则缺的那半不会被发现。
   */
  truncated?: boolean;
}

/**
 * 整页图片 → 文字。
 *
 * 只做「转录」不做「直接抽字段」：转录是视觉模型最稳的任务，字段抽取交给
 * 后面已经调好的 DeepSeek + 本地规则管线。这样即使模型这一轮状态不好，
 * 也只是文字质量差一点，而不是整份简历全空——而且转录出的文本还能回填到
 * 核对弹窗左侧的「简历原文」，扫描件用户第一次能在界面上看到内容。
 *
 * @param apiKey DeepSeek Key（系统 Key 或用户自有 BYOK）
 * @param jpegBase64 不含 data URI 前缀的 base64
 */
export async function deepseekOcrImage(
  apiKey: string,
  jpegBase64: string,
  prompt: string,
  modelOverride?: string | null
): Promise<OcrResult> {
  try {
    const resp = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelOverride || DEEPSEEK_VISION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${jpegBase64}`,
                  // original 保留原图。默认 auto 目前等同 original，但显式写死，
                  // 免得哪天默认值改成 low（512×512）把简历正文糊掉
                  detail: "original",
                },
              },
            ],
          },
        ],
        temperature: 0.01,
        // 一页密集中文简历约 1500~2500 token，给 8192（模型允许的最大值）留足余量。
        // 截断是不报错的，表现是「只识别出上半页」，所以宁大勿小。
        max_tokens: VISION_MAX_TOKENS,
        // 见文件头注释：不传这一行会有近半数请求返回空正文
        thinking: { type: "disabled" },
      }),
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, text: "", reason: `HTTP ${resp.status} ${body.slice(0, 160)}` };
    }

    const data = (await resp.json()) as {
      choices?: {
        message?: { content?: string | { type?: string; text?: string }[] };
        finish_reason?: string;
      }[];
      usage?: {
        completion_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    const content = data.choices?.[0]?.message?.content;
    // 兼容 content 返回成 [{type:"text", text:"..."}] 数组的版本
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((p) => p?.text ?? "").join("")
        : "";
    if (!text.trim()) {
      // 空正文最常见的原因是推理把预算吃光（见文件头注释）。把 reasoning_tokens
      // 带进 reason，下次再出问题能一眼看出是配置退化了还是模型真抽风。
      const rt = data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      return {
        ok: false,
        text: "",
        reason: rt > 0
          ? `模型返回空内容（推理消耗 ${rt} token 占满输出预算，检查 thinking 是否被关闭）`
          : "模型返回空内容",
      };
    }
    const truncated = data.choices?.[0]?.finish_reason === "length";
    return { ok: true, text, truncated: truncated || undefined };
  } catch (e) {
    return { ok: false, text: "", reason: (e as Error)?.message || "视觉识别异常" };
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
