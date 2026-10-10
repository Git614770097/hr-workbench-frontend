// DeepSeek 调用与返回解析的公共封装。
// 简历解析（aiParse）与智能匹配（match）都要用，抽出来避免两份几乎一样的 fetch + 取 JSON 逻辑。

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

/**
 * 调 DeepSeek chat/completions 并取回 JSON 对象。
 * 约定用 response_format=json_object，但仍走 extractJson 兜底（模型偶尔会带围栏）。
 * 60s 超时：AI 接口耗时较长，但超时后必须中断，避免前端永久挂起。
 */
export async function deepseekJson(
  apiKey: string,
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<Record<string, unknown> | null> {
  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: opts.temperature ?? 0,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`DeepSeek 调用失败 (${resp.status}): ${body.slice(0, 200)}`);
  }

  const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;
  return extractJson(content);
}

/**
 * 安全版 DeepSeek 调用：超时或任何异常时返回 null 而非抛错。
 * 调用方根据返回值自行决定降级策略（规则兜底 / 基础解析 / 提示用户）。
 */
export async function deepseekJsonSafe(
  apiKey: string,
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
