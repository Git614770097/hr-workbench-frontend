// 用真实 Key 验证「图片型 PDF → 文字」这条链路通不通、识别质量够不够。
//
// 为什么不塞进 e2e：它要真实调用付费接口，不该混进 CI。
// 这个脚本从环境变量读 Key，本地跑一次就知道结果。
//
// 用法（Key 会自动从 .dev.vars 读，不用手输）：
//   node scripts/test-ocr.mjs "某份扫描件.pdf"
//   node scripts/test-ocr.mjs "简历目录" --limit 3
//   DEEPSEEK_API_KEY=xxx node scripts/test-ocr.mjs ...
//
// 它做的事和线上完全一致：从 PDF 里切出整页 JPEG → base64 → deepseek-flash 转录。
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, extname, basename } from "node:path";

/** 没显式给 Key 就从 .dev.vars 读（避免把密钥贴进命令行历史） */
function loadKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  if (existsSync(".dev.vars")) {
    const m = /^DEEPSEEK_API_KEY=(.+)$/m.exec(readFileSync(".dev.vars", "utf8"));
    if (m) return m[1].trim();
  }
  return null;
}

const KEY = loadKey();
const URL = "https://api.deepseek.com/chat/completions";
// 与 src/worker/ai.ts 保持一致
const MODEL = process.env.DEEPSEEK_VISION_MODEL || "deepseek-flash";

const PROMPT = `请把这张图片里的全部文字完整转录出来，用于简历信息提取。要求：
1. 只输出文字本身，不要总结、不要解释、不要加任何前后缀或标记；
2. 保持原有的分行与段落顺序；
3. 表格式排版按「字段名: 值」逐行输出；
4. 看不清的字用「□」代替，绝对不要猜测或编造。`;

/** 与 src/worker/docText.ts 的 extractPageJpegs 同逻辑 */
function extractPageJpegs(bytes, maxImages = 2) {
  let s = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  const out = [];
  let idx = 0;
  while (out.length < maxImages && (idx = s.indexOf("/DCTDecode", idx)) >= 0) {
    const seg = s.slice(Math.max(0, idx - 800), idx + 200);
    let lastLen = null;
    for (const m of seg.matchAll(/\/Length\s+(\d+)/g)) lastLen = Number(m[1]);
    const st = s.indexOf("stream", idx);
    if (st < 0) break;
    let start = st + 6;
    if (s[start] === "\r") start++;
    if (s[start] === "\n") start++;
    let len = lastLen && lastLen > 0 && start + lastLen <= bytes.length ? lastLen : 0;
    if (!len) {
      const e = s.indexOf("endstream", start);
      if (e < 0) break;
      len = e - start;
      while (len > 0 && (bytes[start + len - 1] === 0x0a || bytes[start + len - 1] === 0x0d)) len--;
    }
    const jpg = bytes.subarray(start, start + len);
    if (jpg.length > 2048 && jpg[0] === 0xff && jpg[1] === 0xd8) {
      const t = jpg.length - 2;
      if (jpg[t] === 0xff && jpg[t + 1] === 0xd9) out.push(jpg);
    }
    idx = start + Math.max(len, 1);
  }
  return out;
}

function collect(p) {
  const st = statSync(p);
  if (st.isDirectory()) {
    return readdirSync(p).filter((f) => extname(f).toLowerCase() === ".pdf").sort().map((f) => join(p, f));
  }
  return [p];
}

async function ocr(b64) {
  const t0 = Date.now();
  const resp = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: PROMPT },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}`, detail: "original" } },
        ],
      }],
      temperature: 0.01,
      max_tokens: 8192,
      // ⚠️ 必须显式关闭思考：不传 thinking 时 0731 版会按任务复杂度自动路由到
      // high 档，而 max_tokens 是「推理 token + 正文 token」共享预算，实测
      // reasoning 能吃满 8191 个 token → HTTP 200 但 content 为空串。
      // 纯视觉转录不需要思考链，关掉后更快也更便宜。
      thinking: { type: "disabled" },
    }),
    signal: AbortSignal.timeout(60000),
  });
  const ms = Date.now() - t0;
  if (!resp.ok) return { ok: false, status: resp.status, body: (await resp.text()).slice(0, 400), ms };
  const data = await resp.json();
  const c = data.choices?.[0]?.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join("") : "";
  // 注意「HTTP 200 但正文为空」是一种独立故障：reasoning_tokens 吃光了预算，
  // 不能和网络/鉴权失败混在一起报，否则会被误判成 Key 失效。
  if (!text.trim()) {
    return { ok: false, empty: true, ms, usage: data.usage, finish: data.choices?.[0]?.finish_reason };
  }
  return { ok: true, text, ms, usage: data.usage, finish: data.choices?.[0]?.finish_reason };
}

(async () => {
  if (!KEY) {
    console.log("缺少 DEEPSEEK_API_KEY（也读不到 .dev.vars）");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 1;
  const target = args.find((a) => !a.startsWith("--") && a !== String(limit));
  if (!target) {
    console.log("请给出 PDF 文件或目录");
    process.exit(1);
  }

  const files = collect(target).slice(0, limit);
  console.log(`模型：${MODEL}    测试 ${files.length} 份\n`);

  for (const f of files) {
    const name = basename(f);
    const bytes = new Uint8Array(readFileSync(f));
    const pages = extractPageJpegs(bytes, 2);
    console.log(`=== ${name} ===`);
    console.log(`  取到 ${pages.length} 页图，首张 ${(pages[0]?.length / 1024 || 0).toFixed(0)} KB`);
    if (pages.length === 0) { console.log("  ❌ 取不到图，跳过\n"); continue; }

    const b64 = Buffer.from(pages[0]).toString("base64");
    console.log(`  base64 ${(b64.length / 1024).toFixed(0)} KB`);

    const r = await ocr(b64);
    if (r.ok) {
      console.log(`  ✅ 耗时 ${(r.ms / 1000).toFixed(1)}s  输出 ${r.text.length} 字  finish=${r.finish}`);
      console.log(`  tokens: ${JSON.stringify(r.usage)}`);
      // 截断是静默的：finish_reason=length 时后半页就没了，必须显式告警
      if (r.finish === "length") console.log("  ⚠️ 输出被截断（finish_reason=length），后半页内容缺失！");
      console.log("  ---- 转录结果（前 700 字）----");
      console.log(r.text.slice(0, 700).split("\n").map((l) => "  " + l).join("\n"));
      console.log("  ------------------------------");
      const out = `dist/ocr-${name.replace(/\.pdf$/i, "")}.txt`;
      writeFileSync(out, r.text);
      console.log(`  完整结果已写入 ${out}\n`);
    } else if (r.empty) {
      const rt = r.usage?.completion_tokens_details?.reasoning_tokens ?? "?";
      console.log(`  ❌ HTTP 200 但正文为空  耗时 ${(r.ms / 1000).toFixed(1)}s  finish=${r.finish}`);
      console.log(`  reasoning_tokens=${rt} / completion_tokens=${r.usage?.completion_tokens}  ← 推理把输出预算吃光了\n`);
    } else {
      console.log(`  ❌ 请求失败：HTTP ${r.status}\n  ${r.body}\n`);
    }
  }
})().catch((e) => {
  console.error("脚本异常：", e.message);
  process.exit(1);
});
