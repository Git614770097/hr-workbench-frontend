// 诊断：为什么这批 PDF 抽不出文字？
//
// 用三种 PDF 分别过一遍服务端的抽取逻辑，看各自落到哪个分支：
//   1. 正常文字型 PDF（Helvetica 文本层）      → 应该成功
//   2. 图片型 PDF（整页一张 JPEG，无文字层）    → 应该报 scanned
//   3. 中文 CID 字体 PDF（有文字但字体可能无 ToUnicode）→ 看实际结果
//
// 用法：node scripts/diag-pdf-text.mjs [样例.jpg]
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const JPG = process.argv[2];

/** 组装 PDF：objects 是已序列化的对象体，返回带正确 xref 的完整字节 */
function buildPdf(objs) {
  let out = Buffer.from("%PDF-1.4\n", "latin1");
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
  });
  const xrefPos = out.length;
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) tail += `${String(off).padStart(10, "0")} 00000 n \n`;
  tail += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.concat([out, Buffer.from(tail, "latin1")]);
}

/** 1. 纯文字 PDF */
function textPdf() {
  const content = "BT /F1 14 Tf 60 760 Td (Zhang Wei) Tj 0 -24 Td (Phone: 13900001111) Tj 0 -24 Td (Bachelor, Tsinghua University) Tj ET";
  return buildPdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"),
    Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"),
  ]);
}

/** 2. 图片型 PDF：整页就是一张 JPEG，没有任何文字操作符（= 扫描件/图片导出） */
function imagePdf(jpgBuf) {
  return buildPdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>"),
    // 唯一的操作符是画图：q ... /Im0 Do Q。没有 BT/ET，没有 Tj
    Buffer.from("<< /Length 35 >>\nstream\nq 595 0 0 842 0 0 cm /Im0 Do Q\nendstream"),
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1000 /Height 1414 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpgBuf.length} >>\nstream\n`, "latin1"),
      jpgBuf,
      Buffer.from("\nendstream", "latin1"),
    ]),
  ]);
}

/** 3. 中文字体但故意不带 ToUnicode（很多国内工具导出的 PDF 就是这样） */
function cjkNoToUnicodePdf() {
  // Identity-H 编码 + 一个子集字体，但没有 ToUnicode CMap：
  // pdfjs 能拿到字形编号，却无法映射回 Unicode，抽出来的 str 往往是空或乱码
  const content = "BT /F1 14 Tf 60 760 Td <0001000200030004> Tj 0 -24 Td <0005000600070008> Tj ET";
  return buildPdf([
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"),
    Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`),
    Buffer.from("<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /Identity-H /DescendantFonts [6 0 R] >>"),
    Buffer.from("<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimSun /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /DW 1000 >>"),
    Buffer.from("<< /Type /FontDescriptor /FontName /SimSun /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>"),
  ]);
}

const dir = mkdtempSync(join(tmpdir(), "diag-pdf-"));
const cases = [];
cases.push(["text-ok.pdf", textPdf(), "正常文字型 PDF"]);
cases.push(["cjk-no-tounicode.pdf", cjkNoToUnicodePdf(), "中文 CID 字体但无 ToUnicode"]);
if (JPG) {
  cases.push(["image-only.pdf", imagePdf(readFileSync(JPG)), "图片型 PDF（整页一张图）"]);
} else {
  console.log("⚠️  没给样例图片，跳过图片型 PDF 用例\n");
}

for (const [name, buf, desc] of cases) {
  const p = join(dir, name);
  writeFileSync(p, buf);
  console.log(`生成 ${name}  ${(buf.length / 1024).toFixed(1)} KB  — ${desc}`);
}
console.log(`\n目录：${dir}\n`);
process.env.DIAG_DIR = dir;
console.log("下一步：把这些文件拖进导入弹窗，或逐个调 /api/parse-resume/file 看返回。");
console.log("（目录不会自动删除，方便你手动复现；不需要了自行删掉即可）");
