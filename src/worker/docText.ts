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
export type DocErrorCode = "unsupported" | "corrupt" | "scanned" | "empty";

export class DocError extends Error {
  code: DocErrorCode;
  constructor(code: DocErrorCode, message: string) {
    super(message);
    this.name = "DocError";
    this.code = code;
  }
}

/** 少于这个字符数就认为没抽到有效文本（扫描件 / 空文档） */
const MIN_TEXT_CHARS = 30;

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
    raw = kind === "pdf" ? await pdfToText(buf) : await docxToText(buf);
  } catch (e) {
    if (e instanceof DocError) throw e;
    const detail = (e as Error)?.message || "格式异常";
    throw new DocError("corrupt", `文件解析失败：${detail}`);
  }

  const text = normalizeDocText(raw);
  if (text.length < MIN_TEXT_CHARS) {
    if (kind === "pdf") {
      throw new DocError(
        "scanned",
        "这份 PDF 没有可提取的文字（多半是扫描件或图片导出的）。请换一份能直接复制文字的 PDF，或手动填写信息。"
      );
    }
    throw new DocError("empty", "这份 Word 文档没有可提取的文字，请检查内容后重试。");
  }

  return { text, kind };
}
