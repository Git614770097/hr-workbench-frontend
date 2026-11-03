// 用真实 Key 验证「图片型 PDF → 文字」这条链路通不通、识别质量够不够。
//
// 为什么不塞进 e2e：它需要 ZHIPU_API_KEY，而密钥不该进仓库、也不该贴进聊天框。
// 这个脚本从环境变量读 Key，你本地跑一次就知道结果。
//
// 用法：
//   ZHIPU_API_KEY=你的key node scripts/test-ocr.mjs "某份扫描件.pdf"
//   ZHIPU_API_KEY=... node scripts/test-ocr.mjs "简历目录" --limit 3
//
// 它做的事和线上完全一致：从 PDF 里切出整页 JPEG → base64 → 视觉模型转录。
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, extname, basename } from "node:path";

const KEY = process.env.ZHIPU_API_KEY;
const URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
// 与 src/worker/ai.ts 的候选列表保持一致
const MODELS = ["glm-4.6v-flash", "glm-5.3-flash", "glm-4v-flash"];

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

async function ocr(model, b64) {
  const t0 = Date.now();
  const resp = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } },
          { type: "text", text: PROMPT },
        ],
      }],
      temperature: 0.01,
      max_tokens: 4000,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const ms = Date.now() - t0;
  if (!resp.ok) return { ok: false, status: resp.status, body: (await resp.text()).slice(0, 300), ms };
  const data = await resp.json();
  const c = data.choices?.[0]?.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join("") : "";
  return { ok: !!text.trim(), text, ms, usage: data.usage };
}

(async () => {
  if (!KEY) {
    console.log("缺少 ZHIPU_API_KEY。用法：");
    console.log('  ZHIPU_API_KEY=你的key node scripts/test-ocr.mjs "某份扫描件.pdf"');
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
  console.log(`测试 ${files.length} 份\n`);

  for (const f of files) {
    const name = basename(f);
    const bytes = new Uint8Array(readFileSync(f));
    const pages = extractPageJpegs(bytes, 2);
    console.log(`=== ${name} ===`);
    console.log(`  取到 ${pages.length} 页图，首张 ${(pages[0]?.length / 1024 || 0).toFixed(0)} KB`);
    if (pages.length === 0) { console.log("  ❌ 取不到图，跳过\n"); continue; }

    const b64 = Buffer.from(pages[0]).toString("base64");
    console.log(`  base64 ${(b64.length / 1024).toFixed(0)} KB`);

    let done = false;
    for (const model of MODELS) {
      const r = await ocr(model, b64);
      if (r.ok) {
        console.log(`  ✅ ${model}  耗时 ${(r.ms / 1000).toFixed(1)}s  输出 ${r.text.length} 字  tokens=${JSON.stringify(r.usage)}`);
        console.log("  ---- 转录结果（前 600 字）----");
        console.log(r.text.slice(0, 600).split("\n").map((l) => "  " + l).join("\n"));
        console.log("  ------------------------------");
        const out = `dist/ocr-${name.replace(/\.pdf$/i, "")}.txt`;
        writeFileSync(out, r.text);
        console.log(`  完整结果已写入 ${out}\n`);
        done = true;
        break;
      }
      console.log(`  ⚠️ ${model} 失败：HTTP ${r.status} ${r.body?.slice(0, 160)}`);
      // 只有模型不存在才换下一个，429/鉴权失败换模型也没用
      if (r.status !== 400 && r.status !== 404) break;
    }
    if (!done) console.log("  ❌ 全部模型都失败\n");
  }
})().catch((e) => {
  console.error("脚本异常：", e.message);
  process.exit(1);
});
