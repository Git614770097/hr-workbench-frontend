// 简历文件 → 纯文本（在 Worker 侧抽取，浏览器不再下载解析引擎）
//
// 为什么搬到服务端：浏览器解析需要先下载 pdfjs —— pdf.worker.min 1.4MB +
// 主库约 0.8MB，弱网下（实测 8~15 KB/s）要 2~4 分钟才出结果；改成上传简历
// 本身（通常 100~500KB，实测上行约 64 KB/s）由 Worker 抽取，线上实测 4 秒完成。
//
// 两个必须处理的坑：
// 1) pdfjs 抽出的中文常是「康熙部首」而非标准汉字（⽉ U+2F49 / ⾼ / ⼯ / ⽇），
//    不做 NFKC 归一化，正则和 AI 都会把「3⽉」当成脏值。
// 2) 扫描件（图片型 PDF）没有文本层，抽出来是空串。必须明确告诉用户原因，
//    不能静默返回空让用户以为简历内容丢了。

import { extractText, getDocumentProxy } from "unpdf";
import JSZip from "jszip";

export type DocKind = "pdf" | "docx";

/** 可区分的失败原因：前端据此给出不同的引导文案 */
export type DocErrorCode = "unsupported" | "corrupt" | "scanned" | "fontmap" | "empty";

export class DocError extends Error {
  code: DocErrorCode;
  /** 扫描件才有：能否取出整页图（决定了能不能走 OCR 兜底） */
  hasImages?: boolean;
  constructor(code: DocErrorCode, message: string, hasImages?: boolean) {
    super(message);
    this.name = "DocError";
    this.code = code;
    this.hasImages = hasImages;
  }
}

/** 少于这个字符数就认为没抽到有效文本（扫描件 / 空文档） */
const MIN_TEXT_CHARS = 30;

/**
 * 可打印字符占比。
 *
 * 用来区分两种「抽不出文字」——它们修法完全不同，报同一句话会让用户和排查的人
 * 一起走错方向：
 *  - 扫描件 / 图片型 PDF：压根没有文字操作符，抽出来是空串
 *  - 字体缺 ToUnicode：**有**文字层，但字体没带「字形编号→Unicode」对照表，
 *    pdfjs 只能拿到字形编号，抽出来是一串控制字符（\u0001\u0002…）。
 *    这种文件在阅读器里「明明能选中能复制」，最容易吵起来。
 */
function printableRatio(s: string): number {
  if (!s) return 0;
  let ok = 0;
  let total = 0;
  for (const ch of s) {
    total++;
    const c = ch.codePointAt(0)!;
    if (c === 9 || c === 10 || c === 13) { ok++; continue; }
    if (c < 0x20 || c === 0x7f) continue; // 控制字符
    if (c >= 0x80 && c <= 0x9f) continue; // C1 控制字符
    ok++;
  }
  return total ? ok / total : 0;
}

export function detectDocKind(fileName: string): DocKind | null {
  const ext = (fileName.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  return null;
}

/**
 * 统一文本形态：
 * - NFKC 把康熙部首 / 全角字母数字归一化（⽉→月、⾼→高、Ａ→A）
 * - 各种空格（含全角 U+3000、不换行 U+00A0）折成半角空格
 * - 去掉行尾空白、压缩连续空行（保留段落分隔，AI 需要靠它区分经历段落）
 */
export function normalizeDocText(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00A0\u2000-\u200B\u3000]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** XML 实体解码：docx 的文本存在 <w:t> 里，`&amp;` 之类不解码会显示成原始实体 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    // &amp; 必须最后替换，否则 `&amp;lt;` 会被二次解码成 `<`
    .replace(/&amp;/g, "&");
}

async function pdfToText(buf: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(buf);
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

/**
 * docx = zip 包，正文在 word/document.xml。
 * 只做「按段落换行 + 去标签」，不引 mammoth（350KB，且依赖 Node Buffer）：
 * - </w:p> 段落结束 → 换行
 * - <w:tab/> → 制表符，<w:br/> → 换行（简历里常用来分栏）
 * 其余标签一律去掉，文本内容原样保留。
 */
async function docxToText(buf: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const doc = zip.file("word/document.xml");
  if (!doc) {
    throw new DocError("corrupt", "这不是有效的 .docx 文件（缺少正文），请用 Word 另存为 .docx 后重试");
  }
  const xml = await doc.async("string");
  const withBreaks = xml
    .replace(/<w:tab[^>]*\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n");
  return decodeXmlEntities(withBreaks.replace(/<[^>]+>/g, ""));
}

/**
 * 从 PDF 原始字节里捞出整页图片（DCTDecode = JPEG）。
 *
 * 为什么不走 pdfjs 的 extractImages：它给的是**解码后的像素**（width/height/channels +
 * 原始 RGBA），要发给视觉模型还得先编码成 JPEG——而 Worker 里没有 canvas，
 * 得再引一个纯 JS JPEG 编码器。DCTDecode 流本身就是 JPEG 字节，直接切出来零依赖、
 * 无重编码损失。
 *
 * 为什么用 /Length 而不是扫 endstream：JPEG 的二进制数据里可能恰好出现
 * "endstream" 字样，扫标记会切歪；/Length 是 PDF 里唯一权威的长度来源。
 * 但 /Length 也可能是间接引用（数字对象编号），那就退回扫标记兜底。
 *
 * 只对扫描件调用（正常 PDF 走文本抽取，不需要图）。
 */
export function extractPageJpegs(buf: Uint8Array, maxImages = 3): Uint8Array[] {
  const bytes = buf;
  // latin1 保证字节与字符一一对应，索引不会错位
  let s = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }

  const out: Uint8Array[] = [];
  let idx = 0;
  while (out.length < maxImages && (idx = s.indexOf("/DCTDecode", idx)) >= 0) {
    // /Length 在本对象的字典里，位于 /DCTDecode 附近；取最近的一个
    const seg = s.slice(Math.max(0, idx - 800), idx + 200);
    let lastLen: number | null = null;
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
    // SOI…EOI 才算一张完整图，切歪的直接丢
    if (jpg.length > 2048 && jpg[0] === 0xff && jpg[1] === 0xd8) {
      const tail = jpg.length - 2;
      if (jpg[tail] === 0xff && jpg[tail + 1] === 0xd9) out.push(jpg);
    }
    idx = start + Math.max(len, 1);
  }
  return out;
}

/**
 * 文件字节 → 归一化后的纯文本。
 * 失败一律抛 DocError，调用方按 code 转成用户能看懂的提示。
 */
export async function extractDocText(
  buf: Uint8Array,
  fileName: string
): Promise<{ text: string; kind: DocKind }> {
  const kind = detectDocKind(fileName);
  if (!kind) {
    throw new DocError("unsupported", "只支持 .pdf 和 .docx 格式（.doc 请先用 Word 另存为 .docx）");
  }

  let raw: string;
  try {
    // ⚠️ 必须传副本：pdfjs 接管缓冲区时会 **detach** 原始 ArrayBuffer
    // （getDocumentProxy 之后 buf.length 直接变成 0，实测 Node 与 Worker 都一样）。
    // 不复制的话，下面「抽不出文字时去取整页图」永远拿到空数据，
    // 图片型 PDF 的 OCR 兜底会静默失效——而表面上只会表现为「识别不出图片」。
    raw = kind === "pdf" ? await pdfToText(buf.slice()) : await docxToText(buf);
  } catch (e) {
    if (e instanceof DocError) throw e;
    const detail = (e as Error)?.message || "格式异常";
    throw new DocError("corrupt", `文件解析失败：${detail}`);
  }

  const text = normalizeDocText(raw);
  if (text.length < MIN_TEXT_CHARS) {
    if (kind === "pdf") {
      // 有字但都是控制字符 = 字体缺 ToUnicode 映射，不是扫描件。
      // 这两种必须分开报：前者是 PDF 生成的编码问题，后者是图片，用户能做的事不一样。
      if (text.length > 0 && printableRatio(text) < 0.5) {
        throw new DocError(
          "fontmap",
          "这份 PDF 的文字用了没有编码映射的字体，程序读不出内容（在阅读器里能选中，但复制出来是乱码）。请另存为可复制文字的 PDF，或手动填写信息。"
        );
      }
      // 空文本 + 有整页图 = 图片型 PDF。hasImages 告诉调用方「还能走 OCR 兜底」
      const hasImages = extractPageJpegs(buf, 1).length > 0;
      throw new DocError(
        "scanned",
        "这份 PDF 是图片（扫描件或图片导出），没有文字层，需要识别图中的文字。",
        hasImages
      );
    }
    throw new DocError("empty", "这份 Word 文档没有可提取的文字，请检查内容后重试。");
  }

  return { text, kind };
}
