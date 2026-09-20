import { toHtml } from "./template";

export type DocParseMode = "html" | "rtf" | "text";

// 导入 .doc 文件并尽力解析为 HTML。
// .doc 实际有三种形态：
// 1. HTML 型（Word「另存为网页/筛选过的网页」、本系统导出的 .doc）—— 完整保留排版
// 2. RTF 型（写字板/旧程序产出）—— 提取纯文本
// 3. 二进制 OLE 型（Word 97-2003 原生格式）—— 提取纯文本（排版需手动整理）
export async function parseDocFile(file: File): Promise<{ html: string; mode: DocParseMode }> {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 8));

  // OLE2 复合文档魔数 D0CF11E0
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
    return { html: toHtml(oleExtractText(buf)), mode: "text" };
  }

  const text = decodeText(buf);

  if (/^\s*\{\\rtf/.test(text)) {
    return { html: toHtml(rtfToText(text)), mode: "rtf" };
  }
  if (/<html|<body|xmlns:w=|<p[\s>]/i.test(text)) {
    const doc = new DOMParser().parseFromString(text, "text/html");
    // 清掉 Word 导出 HTML 的脚本/样式噪音，只留正文结构
    doc.body.querySelectorAll("script,style,xml,meta,link").forEach((el) => el.remove());
    return { html: doc.body.innerHTML, mode: "html" };
  }
  // 兜底：按纯文本处理
  return { html: toHtml(text), mode: "text" };
}

// 文本解码：优先 UTF-8，失败退回 GBK（中文 Windows 常见编码）
function decodeText(buf: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("gbk").decode(buf);
  }
}

// RTF → 纯文本：处理 \'xx（GBK 字节）、\par 换行，剔除控制字与字体/颜色表
function rtfToText(rtf: string): string {
  // 先删除 {\fonttbl ...} {\colortbl ...} {\stylesheet ...} {\*\...} 组
  let s = rtf;
  for (const key of ["{\\fonttbl", "{\\colortbl", "{\\stylesheet", "{\\*"]) {
    s = removeGroup(s, key);
  }
  let out = "";
  let gbk: number[] = [];
  const flush = () => {
    if (gbk.length) {
      out += new TextDecoder("gbk").decode(new Uint8Array(gbk));
      gbk = [];
    }
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\") {
      const rest = s.slice(i);
      const hex = rest.match(/^\\'([0-9a-fA-F]{2})/);
      if (hex) {
        gbk.push(parseInt(hex[1], 16));
        i += 4;
        continue;
      }
      const word = rest.match(/^\\([a-z]+)(-?\d+)? ?/i);
      if (word) {
        if (word[1] === "par" || word[1] === "line") {
          flush();
          out += "\n";
        } else if (word[1] === "tab") {
          flush();
          out += "\t";
        }
        i += word[0].length;
        continue;
      }
      // \{ \} \\ 转义字符
      flush();
      out += s[i + 1] || "";
      i += 2;
      continue;
    }
    if (ch === "{" || ch === "}") {
      i++;
      continue;
    }
    flush();
    out += ch;
    i++;
  }
  flush();
  // 清理多余空行
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// 删除 RTF 中从 startKey 开始的完整花括号组
function removeGroup(s: string, startKey: string): string {
  let idx = s.indexOf(startKey);
  while (idx !== -1) {
    let depth = 0;
    let end = idx;
    for (; end < s.length; end++) {
      if (s[end] === "{") depth++;
      else if (s[end] === "}") {
        depth--;
        if (depth === 0) { end++; break; }
      }
    }
    s = s.slice(0, idx) + s.slice(end);
    idx = s.indexOf(startKey);
  }
  return s;
}

// 二进制 OLE .doc → 纯文本（启发式：按 UTF-16LE 解码后提取可读字符流）
function oleExtractText(buf: ArrayBuffer): string {
  const raw = new TextDecoder("utf-16le").decode(buf);
  // 提取连续可读片段（中日韩字符、ASCII、常用标点、空白）
  const runs = raw.match(/[一-鿿A-Za-z0-9，。、；：？！“”‘’（）《》〈〉【】\-—…·%‰\s@./+]{3,}/g) || [];
  const lines = runs
    .map((r) => r.replace(/[ \t　]+/g, " ").trim())
    .filter((r) => r.length >= 2 && /[一-鿿A-Za-z]/.test(r));
  // 去重相邻行（OLE 里常有元数据重复）
  const deduped: string[] = [];
  for (const line of lines) {
    if (deduped[deduped.length - 1] !== line) deduped.push(line);
  }
  return deduped.join("\n");
}
