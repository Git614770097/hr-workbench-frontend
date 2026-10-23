// 智谱 GLM 接入自检：验证 Key 可用性 + 实测免费档真实并发上限。
//
// 用法：
//   ZHIPU_API_KEY=xxx node scripts/test-zhipu.mjs
//   ZHIPU_API_KEY=xxx node scripts/test-zhipu.mjs --concurrency 5
//
// 背景：免费档限流各家口径不一（官方称 1 并发，压测文章称 QPS 5 / 并发 10），
// 只有实测才知道你这个 Key 的真实上限 —— 这决定了「智谱优先 + DeepSeek 回落」的触发频率。

const KEY = process.env.ZHIPU_API_KEY;
const CONCURRENCY = Number(
  (process.argv.find((a, i) => process.argv[i - 1] === "--concurrency") || "3")
);
const URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL = "glm-4.7-flash";

if (!KEY) {
  console.error("缺少环境变量 ZHIPU_API_KEY");
  console.error("用法: ZHIPU_API_KEY=xxx node scripts/test-zhipu.mjs");
  process.exit(1);
}

// 智谱 2026 年起的认证方式：id.secret 格式 Key 需做 JWT 动态签名（HMAC-SHA256，5 分钟有效）
import { createHmac } from "node:crypto";

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function authHeader(key) {
  const dot = key.indexOf(".");
  if (dot <= 0 || dot === key.length - 1) return `Bearer ${key}`;
  const id = key.slice(0, dot);
  const secret = key.slice(dot + 1);
  const header = b64url(JSON.stringify({ alg: "HS256", sign_type: "SIGN" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ api_key: id, exp: now + 300, timestamp: now }));
  const data = `${header}.${payload}`;
  const sig = createHmac("sha256", secret).update(data).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `Bearer ${data}.${sig}`;
}

if (KEY.includes(".")) {
  console.log("检测到 id.secret 格式 Key —— 已启用 JWT 动态签名");
} else {
  console.log("Key 为纯字符串格式 —— 按静态 Bearer 发送");
}

async function call(i, label) {
  const t0 = Date.now();
  try {
    const resp = await fetch(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader(KEY),
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: `只返回 JSON：{"n": ${i}}` }],
        temperature: 0,
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const ms = Date.now() - t0;
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { i, label, ok: false, status: resp.status, ms, body: body.slice(0, 100) };
    }
    const data = await resp.json();
    return {
      i,
      label,
      ok: true,
      status: resp.status,
      ms,
      content: data?.choices?.[0]?.message?.content?.slice(0, 60) ?? "(空)",
    };
  } catch (e) {
    return { i, label, ok: false, status: 0, ms: Date.now() - t0, body: (e?.message || String(e)).slice(0, 100) };
  }
}

function report(results) {
  const ok = results.filter((r) => r.ok);
  const r429 = results.filter((r) => r.status === 429);
  const fail = results.filter((r) => !r.ok && r.status !== 429);
  for (const r of results) {
    const mark = r.ok ? "OK " : r.status === 429 ? "429" : "ERR";
    console.log(`  [${mark}] ${r.label}  ${r.ms}ms  ${r.ok ? r.content : r.body}`);
  }
  console.log(`\n  成功 ${ok.length}/${results.length}  ·  429 限流 ${r429.length}  ·  其他失败 ${fail.length}`);
  if (ok.length) {
    const ms = ok.map((r) => r.ms).sort((a, b) => a - b);
    console.log(`  耗时 中位 ${ms[Math.floor(ms.length / 2)]}ms  最慢 ${ms[ms.length - 1]}ms`);
  }
  return { ok: ok.length, r429: r429.length, fail: fail.length };
}

async function main() {
  console.log(`\n=== 1. Key 有效性（单次调用 ${MODEL}）===`);
  const single = await call(0, "single");
  const s = report([single]);
  if (!single.ok) {
    console.error(
      single.status === 401 || single.status === 403
        ? "\nKey 无效或已过期 —— 请到 open.bigmodel.cn 控制台重新生成"
        : "\n调用失败 —— 请检查网络或稍后再试"
    );
    process.exit(1);
  }

  console.log(`\n=== 2. 并发压测（${CONCURRENCY} 个请求同时发出）===`);
  console.log("  判定：若出现 429，说明并发上限 < " + CONCURRENCY + "；全部成功则可再加大 --concurrency 试");
  const batch = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => call(i + 1, `parallel-${i + 1}`))
  );
  const b = report(batch);

  console.log(`\n=== 结论 ===`);
  if (b.r429 === 0) {
    console.log(`  ${CONCURRENCY} 并发全部通过 —— 免费档上限 >= ${CONCURRENCY}，「智谱优先」在多用户下也够用`);
    console.log(`  建议再跑一次更大的并发找出真实上限：--concurrency 10`);
  } else if (b.ok > 0) {
    console.log(`  并发上限约为 ${b.ok} —— 超出的请求会 429，由 DeepSeek 自动回落（这正是设计好的路径）`);
    console.log(`  若 429 过多影响体验，可考虑给智谱调用加排队，或对多用户场景直接走 DeepSeek`);
  } else {
    console.log(`  ${CONCURRENCY} 并发全部被拒 —— 免费档基本是 1 并发，多用户下会频繁回落 DeepSeek`);
    console.log(`  建议：批量/离线任务走智谱，交互式场景保留 DeepSeek`);
  }
}

main();
