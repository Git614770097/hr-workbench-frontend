// 简历 PDF 抽不出文字？先诊断再修。
//
// 背景：导入弹窗里「这份 PDF 没有可提取的文字（多半是扫描件或图片导出的）」
// 这一句报错，实际上盖住了两种完全不同的原因，而修法完全不同：
//
//   ① 纯图片 PDF（扫描件 / 招聘网站导出的图片型 PDF）
//      页面里根本没有文字操作符，只有一张图。任何文本抽取都必然是空的。
//      只能靠 OCR / 视觉模型。
//
//   ② 有文字层，但字体没有 ToUnicode 映射
//      PDF 里确实有字，某些阅读器里也能选中，但字体是子集化且没带
//      「字形编号 → Unicode」的对照表。pdfjs 只能拿到字形编号，
//      于是抽出来是一串控制字符（\u0001\u0002…）。
//      这种文件用户会以为「我能复制啊，怎么会没文字」，最容易吵起来。
//
// 这个脚本不改任何东西，只如实报告每份文件属于哪种。
//
// 用法：
//   node scripts/diag-resume-pdfs.mjs "D:/某目录"          # 递归扫目录下的 pdf/docx
//   node scripts/diag-resume-pdfs.mjs a.pdf b.pdf          # 也可以直接给文件
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { extractText, extractImages, getDocumentProxy } from "unpdf";
import JSZip from "jszip";

const MIN_TEXT_CHARS = 30; // 与 src/worker/docText.ts 保持一致
const MAX_IMAGES_PROBE = 3; // 只探前几页的图片，够判断就行

/** 可打印字符占比：控制字符占多数 = 字形编号冒充文字（原因②的典型特征） */
function printableRatio(s) {
  if (!s) return 0;
  let ok = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    // 保留常规可见字符、中日韩、全角标点、空白
    if (c === 9 || c === 10 || c === 13) { ok++; continue; }
    if (c < 0x20) continue;            // 控制字符：不算
    if (c === 0x7f) continue;
    if (c >= 0x80 && c <= 0x9f) continue; // C1 控制字符
    ok++;
  }
  return ok / [...s].length;
}

function collect(paths) {
  const out = [];
  for (const p of paths) {
    let st;
    try { st = statSync(p); } catch { console.log(`跳过（不存在）：${p}`); continue; }
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) {
        const full = join(p, name);
        const s = statSync(full);
        if (s.isDirectory()) out.push(...collect([full]));
        else if (/\.(pdf|docx)$/i.test(name)) out.push(full);
      }
    } else if (/\.(pdf|docx)$/i.test(p)) {
      out.push(p);
    }
  }
  return out;
}

async function diagPdf(buf) {
  const pdf = await getDocumentProxy(buf);
  const pages = pdf.numPages;
  const { text } = await extractText(pdf, { mergePages: true });
  const t = Array.isArray(text) ? text.join("\n") : (text || "");

  // 只探前几页有没有图（扫描件通常每页一张整页图）
  let images = 0;
  const probe = Math.min(pages, MAX_IMAGES_PROBE);
  for (let p = 1; p <= probe; p++) {
    try {
      const imgs = await extractImages(pdf, p);
      images += Array.isArray(imgs) ? imgs.length : 0;
    } catch { /* 单页取图失败不影响结论 */ }
  }
  return { pages, text: t, images, kind: "pdf" };
}

async function diagDocx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const doc = zip.file("word/document.xml");
  if (!doc) return { pages: 0, text: "", images: 0, kind: "docx", broken: true };
  const xml = await doc.async("string");
  const t = xml.replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "");
  return { pages: 1, text: t, images: 0, kind: "docx" };
}

/** 给结论。顺序要紧：先排除损坏，再看是「有字但不可读」还是「压根没字」 */
function verdict(d) {
  if (d.broken) return ["损坏", "缺少正文，文件可能不是真的 docx"];
  const len = d.text.trim().length;
  const ratio = printableRatio(d.text);
  if (len >= MIN_TEXT_CHARS && ratio >= 0.8) {
    return ["可正常解析", `${len} 字，可打印占比 ${(ratio * 100).toFixed(0)}%`];
  }
  if (len > 0 && ratio < 0.5) {
    return [
      "原因② 字体无 Unicode 映射",
      `抽出 ${len} 字但可打印占比仅 ${(ratio * 100).toFixed(0)}%，是字形编号冒充文字`,
    ];
  }
  if (len === 0 || len < MIN_TEXT_CHARS) {
    if (d.images > 0) return ["原因① 纯图片 PDF", `无文字层，探到 ${d.images} 张图，需 OCR`];
    return ["空文档", `只有 ${len} 字，且没探到图片`];
  }
  return ["可正常解析", `${len} 字`];
}

const targets = collect(process.argv.slice(2));
if (targets.length === 0) {
  console.log("用法：node scripts/diag-resume-pdfs.mjs <目录或文件...>");
  process.exit(1);
}

console.log(`共 ${targets.length} 个文件\n`);
const tally = {};
const rows = [];

for (const f of targets) {
  const name = basename(f);
  let d;
  try {
    const buf = new Uint8Array(readFileSync(f));
    d = extname(f).toLowerCase() === ".pdf" ? await diagPdf(buf) : await diagDocx(buf);
  } catch (e) {
    const msg = (e?.message || "").slice(0, 60);
    const tag = /password|encrypt/i.test(msg) ? "加密 PDF（需密码）" : "打不开/已损坏";
    tally[tag] = (tally[tag] || 0) + 1;
    rows.push([name, tag, msg]);
    continue;
  }
  const [tag, why] = verdict(d);
  tally[tag] = (tally[tag] || 0) + 1;
  rows.push([name, tag, why]);
  // 每 20 个打一行，避免 27 份刷屏
  if (rows.length % 20 === 0) console.log(`  …已处理 ${rows.length}/${targets.length}`);
}

console.log("");
const w = Math.min(46, Math.max(...rows.map((r) => r[0].length)) + 2);
console.log("文件".padEnd(w) + "判定".padEnd(26) + "说明");
console.log("-".repeat(w + 26 + 40));
for (const [name, tag, why] of rows) {
  const n = name.length > w - 2 ? name.slice(0, w - 5) + "…" : name;
  console.log(n.padEnd(w) + tag.padEnd(26) + why);
}

console.log("\n汇总：");
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)} 份  ${k}`);
}

const needOcr = (tally["原因① 纯图片 PDF"] || 0) + (tally["原因② 字体无 Unicode 映射"] || 0);
if (needOcr > 0) {
  console.log(`\n其中 ${needOcr} 份靠换文件解决不了——它们本身就是这份简历唯一的样子，`);
  console.log("只能走 OCR / 视觉模型，或者人工录入。");
}
