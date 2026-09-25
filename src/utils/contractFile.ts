import { extractPdfLines } from "./resumeParser";

// 合同文件 → 纯文本。与简历导入（utils/resumeImport）同一条 pdfjs/mammoth 链路，
// 但不 import resumeImport 本体（它静态引入 mammoth 会拖重引用方），
// 这里 pdfjs / mammoth 都走动态 import，只在真正解析文件时才下载分包。
//
// PDF.js 本地打包 + 按需动态加载（原因同简历导入：不依赖 CDN，不影响首屏）。
let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    });
  }
  return pdfjsPromise;
}

/** 合同文件 → 纯文本（PDF 用 pdfjs 按坐标还原行，Word 用 mammoth 提取）。不支持 .doc 老格式。 */
export async function extractContractText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) {
    const pdfjsLib = await loadPdfjs();
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += extractPdfLines(content).join("\n") + "\n";
    }
    return text;
  }
  if (name.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }
  throw new Error(`不支持的文件格式：${file.name}，请上传 PDF 或 Word（.docx）文件`);
}
