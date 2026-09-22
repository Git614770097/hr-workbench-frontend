import type { Talent, DocTemplate } from "../types";
import { downloadBlob, escapeHtml } from "./file";

// 占位符 → 人才字段映射（支持中文和英文别名）
const TALENT_PLACEHOLDER_MAP: Record<string, (t: Talent) => string> = {
  "姓名": (t) => t.name,
  "手机号": (t) => t.phone || "",
  "电话": (t) => t.phone || "",
  "邮箱": (t) => t.email || "",
  "年龄": (t) => (t.age != null ? String(t.age) : ""),
  "学历": (t) => t.education || "",
  "院校": (t) => t.school || "",
  "毕业院校": (t) => t.school || "",
  "公司": (t) => t.current_company || "",
  "当前公司": (t) => t.current_company || "",
  "职位": (t) => t.current_title || "",
  "当前职位": (t) => t.current_title || "",
  "工作年限": (t) => (t.years_experience != null ? `${t.years_experience}年` : ""),
  "城市": (t) => t.city || "",
  "所在城市": (t) => t.city || "",
  "期望薪资": (t) => t.expected_salary || "",
  "期望城市": (t) => t.expected_city || "",
  "行业": (t) => t.industry || "",
};

// ---------- HTML / 纯文本互转 ----------

// 判断内容是否已经是 HTML（富文本模板）
export function looksLikeHtml(content: string): boolean {
  return /<\/?(p|div|span|br|h[1-6]|ul|ol|li|table|strong|em|u|s|blockquote)[\s>]/i.test(content);
}

// 去掉 HTML 标签，得到纯文本（用于提取占位符、统计等）
export function stripHtml(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || "";
}

// 统一转为 HTML：富文本模板原样返回；旧的纯文本模板按段落/换行转换
export function toHtml(content: string): string {
  if (looksLikeHtml(content)) return content;
  return content
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// ---------- 占位符 ----------

// 提取模板中所有占位符（去重，保持出现顺序；自动忽略 HTML 标签）
export function extractPlaceholders(content: string): string[] {
  const text = looksLikeHtml(content) ? stripHtml(content) : content;
  const found: string[] = [];
  const re = /\{\{([^{}]+)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const key = m[1].trim();
    if (key && !found.includes(key)) found.push(key);
  }
  return found;
}

// 判断占位符能否由人才信息自动填充
export function isAutoFillable(key: string): boolean {
  return key in TALENT_PLACEHOLDER_MAP || key === "日期" || key === "今天日期";
}

// 返回每个占位符当前的解析值，供「套用生成」弹窗做填充核对与手动覆盖。
// auto=true 表示该值由人才档案/日期自动得出（未被手动覆盖）；auto=false 表示手动填写或仍为空。
export function getPlaceholderValues(
  content: string,
  talent: Talent | null,
  manualValues: Record<string, string>
): { key: string; value: string; auto: boolean }[] {
  return extractPlaceholders(content).map((key) => {
    if (manualValues[key] !== undefined) return { key, value: manualValues[key] || "", auto: false };
    let value = "";
    if (talent && key in TALENT_PLACEHOLDER_MAP) {
      value = TALENT_PLACEHOLDER_MAP[key](talent);
    } else if (key === "日期" || key === "今天日期") {
      value = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
    }
    return { key, value, auto: !!value };
  });
}

function resolvePlaceholderValue(
  key: string,
  talent: Talent | null,
  manualValues: Record<string, string>
): string {
  let value = "";
  if (talent && key in TALENT_PLACEHOLDER_MAP) {
    value = TALENT_PLACEHOLDER_MAP[key](talent);
  } else if (key === "日期" || key === "今天日期") {
    value = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
  }
  if (manualValues[key] !== undefined) value = manualValues[key];
  return value;
}

// 在 HTML 的文本节点内替换占位符（不破坏标签结构，替换值按纯文本注入，安全）
function replaceInHtml(html: string, values: Map<string, string>): string {
  const container = document.createElement("div");
  container.innerHTML = html;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    if (!node.data.includes("{{")) continue;
    let text = node.data;
    for (const [key, value] of values) {
      text = text.split(`{{${key}}}`).join(value);
    }
    node.data = text;
  }
  return container.innerHTML;
}

// 用人才信息 + 手动补充值替换占位符，返回替换后的 HTML 和仍未填充的占位符
export function fillTemplate(
  content: string,
  talent: Talent | null,
  manualValues: Record<string, string>
): { html: string; missing: string[] } {
  const keys = extractPlaceholders(content);
  const missing: string[] = [];
  const values = new Map<string, string>();
  for (const key of keys) {
    const value = resolvePlaceholderValue(key, talent, manualValues);
    if (!value) missing.push(key);
    // 未填的占位符保留醒目标记，方便用户发现
    values.set(key, value || `【${key}】`);
  }
  return { html: replaceInHtml(toHtml(content), values), missing };
}

// ---------- 导出 / 打印 ----------

// 一键整理富文本格式（保守清理，不动用户的字体/颜色/对齐设置）：
// 1. 清除导入残留的背景高亮
// 2. 去掉段落尾部多余空格与 <br>
// 3. 连续空段落合并为一个，首尾空段落删除
export function tidyHtml(html: string): string {
  const c = document.createElement("div");
  c.innerHTML = html;

  // 1) 清除背景高亮（mammoth/Word 导入常见残留）
  c.querySelectorAll<HTMLElement>("[style]").forEach((el) => {
    el.style.backgroundColor = "";
    if (!el.style.cssText.trim()) el.removeAttribute("style");
  });

  // 2) 段落尾部清理（保留整段唯一的一个 <br> 占位）
  c.querySelectorAll("p").forEach((p) => {
    while (p.lastChild && p.childNodes.length > 1) {
      const last = p.lastChild;
      const isBr = last.nodeName === "BR";
      const isBlankText =
        last.nodeType === Node.TEXT_NODE && !(last.textContent || "").trim();
      if (!isBr && !isBlankText) break;
      p.removeChild(last);
    }
  });

  // 3) 空段落处理
  const isEmptyP = (el: Element) =>
    el.tagName === "P" && !(el.textContent || "").trim() && !el.querySelector("img,table");
  let prevEmpty = false;
  for (const el of Array.from(c.children)) {
    if (isEmptyP(el)) {
      if (prevEmpty) el.remove();
      else prevEmpty = true;
    } else {
      prevEmpty = false;
    }
  }
  while (c.firstElementChild && isEmptyP(c.firstElementChild)) c.firstElementChild.remove();
  while (c.lastElementChild && isEmptyP(c.lastElementChild)) c.lastElementChild.remove();

  return c.innerHTML;
}

// 一键整理格式：在 tidyHtml 清理的基础上，按中文公文/合同惯例自动布局排版
// 规则：标题居中加粗二号黑体；条款/序号标题加粗；正文宋体四号 + 首行缩进 2 字符；
//       甲乙方信息行不缩进；末尾落款（公司/日期/签章）右对齐
export function smartTidyHtml(html: string): string {
  const c = document.createElement("div");
  c.innerHTML = tidyHtml(html);

  // 只处理直接子块级元素（li 保持列表原样）
  const blocks = Array.from(c.children).filter((el) => /^(P|H[1-6]|DIV)$/.test(el.tagName));

  // 先重置块级排版样式，避免与自动布局冲突
  for (const el of blocks) {
    const st = (el as HTMLElement).style;
    st.fontFamily = "";
    st.fontSize = "";
    st.textAlign = "";
    st.textIndent = "";
  }
  // 内联 span 的字体/字号也清掉（保留颜色、加粗等）
  c.querySelectorAll<HTMLElement>("span[style]").forEach((el) => {
    el.style.fontFamily = "";
    el.style.fontSize = "";
    if (!el.style.cssText.trim()) el.removeAttribute("style");
  });

  const nonEmpty = blocks.filter((el) => (el.textContent || "").trim());
  const total = nonEmpty.length;

  nonEmpty.forEach((el, idx) => {
    const text = (el.textContent || "").trim();
    const len = text.length;
    const st = (el as HTMLElement).style;
    const setFont = (family: string, size: string) => {
      st.fontFamily = family;
      st.fontSize = size;
    };

    // 文档标题：首个非空块、短行、无句末标点 → 居中、加粗、二号黑体
    if (idx === 0 && len <= 30 && !/[。；，,;.]$/.test(text)) {
      st.textAlign = "center";
      st.fontWeight = "bold";
      setFont("SimHei, sans-serif", "22px");
      return;
    }
    // 编号行（紧跟标题，如「编号：XXX-2026」）→ 居中
    if (idx === 1 && len <= 30 && /编号|NO\.?/i.test(text)) {
      st.textAlign = "center";
      setFont("SimSun, serif", "14px");
      return;
    }
    // 条款标题：第X条/章/节（短行）→ 加粗三号黑体
    if (/^第[一二三四五六七八九十百千\d]+[条章节]/.test(text) && len <= 40) {
      st.fontWeight = "bold";
      setFont("SimHei, sans-serif", "16px");
      return;
    }
    // 中文序号小标题：（一）xxx / 一、xxx（短行）→ 加粗
    if ((/^[（(][一二三四五六七八九十]+[）)]/.test(text) || /^[一二三四五六七八九十]+、/.test(text)) && len <= 40) {
      st.fontWeight = "bold";
      setFont("SimSun, serif", "14px");
      return;
    }
    // 落款：末尾 4 行内的公司/日期/签章类短行 → 右对齐
    if (
      idx >= total - 4 &&
      len <= 50 &&
      (/年.{1,3}月.{1,3}日/.test(text) ||
        /[（(](盖章|签字|签名|代表)/.test(text) ||
        /(公司|中心|部门|委员会|事务所)[:：]?$/.test(text))
    ) {
      st.textAlign = "right";
      setFont("SimSun, serif", "14px");
      return;
    }
    // 甲乙方/当事人信息行 → 左对齐不缩进
    if (/^(甲方|乙方|丙方|用人单位|劳动者|员工|姓名|身份证号)[:：]/.test(text) && len <= 80) {
      setFont("SimSun, serif", "14px");
      return;
    }
    // 普通正文：宋体四号 + 首行缩进 2 字符
    setFont("SimSun, serif", "14px");
    st.textIndent = "2em";
  });

  return c.innerHTML;
}

const DOC_ENVELOPE_STYLE = `
  body { font-family: "SimSun", "宋体", serif; font-size: 14pt; line-height: 2; max-width: 700px; margin: 40px auto; color: #000; }
  p { margin: 0.35em 0; }
  h1, h2, h3 { line-height: 1.5; }
  ul, ol { padding-left: 2em; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #999; padding: 4px 8px; }
`;

// 导出为 Word（.doc，HTML 兼容格式，保留富文本排版，Word/WPS 可直接打开编辑）
export function exportAsWord(docName: string, htmlContent: string) {
  const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head><meta charset="utf-8"><title>${escapeHtml(docName)}</title>
<style>${DOC_ENVELOPE_STYLE}</style></head>
<body>${htmlContent}</body></html>`;
  const blob = new Blob(["﻿", html], { type: "application/msword;charset=utf-8" });
  downloadBlob(blob, `${docName}.doc`);
}

// 打印 / 另存 PDF（打开新窗口调用浏览器打印）
export function printDoc(docName: string, htmlContent: string) {
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(docName)}</title>
<style>${DOC_ENVELOPE_STYLE}</style>
</head><body>${htmlContent}
<script>window.onload = function(){ window.print(); }<\/script></body></html>`);
  win.document.close();
}

// 导出模板原文为 .doc（保留排版与占位符标记）
export function exportTemplateAsDoc(template: DocTemplate) {
  exportAsWord(template.name, toHtml(template.content));
}

// 导出模板为 PDF（打印视图，浏览器"另存为 PDF"）
export function exportTemplateAsPdf(template: DocTemplate) {
  printDoc(template.name, toHtml(template.content));
}
