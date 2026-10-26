import DOMPurify from "dompurify";

/**
 * 富文本净化：用于 dangerouslySetInnerHTML 渲染用户可控 HTML（模板 content、套用结果等）。
 * 丢掉 script / on* 事件 / javascript: 协议，保留常用文档排版标签。
 */
const CONFIG = {
  ALLOWED_TAGS: [
    "p", "br", "div", "span", "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "b", "em", "i", "u", "s", "strike", "sub", "sup",
    "ul", "ol", "li", "blockquote", "pre", "code", "hr",
    "table", "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup", "col",
    "a", "img", "font",
  ],
  ALLOWED_ATTR: [
    "href", "target", "rel", "src", "alt", "title", "width", "height",
    "style", "class", "colspan", "rowspan", "align", "valign",
    "border", "cellpadding", "cellspacing", "color", "face", "size",
  ],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

/** 净化 HTML 后用于 dangerouslySetInnerHTML。空值原样返回空串。 */
export function sanitizeHtml(dirty: string | null | undefined): string {
  if (!dirty) return "";
  return DOMPurify.sanitize(String(dirty), CONFIG) as unknown as string;
}
