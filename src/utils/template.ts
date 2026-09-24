import { escapeHtml } from "./file";

// ---------- HTML / 纯文本互转 ----------

// 判断内容是否已经是 HTML（富文本模板）
export function looksLikeHtml(content: string): boolean {
  return /<\/?(p|div|span|br|h[1-6]|ul|ol|li|table|strong|em|u|s|blockquote)[\s>]/i.test(content);
}

// 去掉 HTML 标签，得到纯文本（用于内容校验、统计等）
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

// ---------- 一键整理格式 ----------

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
