import { useEffect, useRef } from "react";
import Quill from "quill";
import "quill/dist/quill.snow.css";

// 中文字体白名单（style 型 attributor，直接写内联样式，导出 Word 时保留）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FontStyle = Quill.import("attributors/style/font") as any;
FontStyle.whitelist = ["SimSun", "SimHei", "FangSong", "KaiTi", "Microsoft YaHei", "Arial", "Times New Roman"];
Quill.register(FontStyle, true);

// 国标字号（px 值对应：小四12/四号14/三号16/小二18/二号22/一号26）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SizeStyle = Quill.import("attributors/style/size") as any;
SizeStyle.whitelist = ["12px", "14px", "16px", "18px", "22px", "26px"];
Quill.register(SizeStyle, true);

interface Props {
  value?: string;
  onChange?: (html: string) => void;
  placeholder?: string;
  /** 编辑区最小高度 */
  minHeight?: number;
}

// 工具栏：字体/字号/标题/加粗斜体下划线删除线/颜色/对齐/列表/缩进/引用/清除格式
// 下拉标签的中文文案在 global.css 中定义
const TOOLBAR_OPTIONS = [
  [{ font: FontStyle.whitelist }, { size: SizeStyle.whitelist }],
  [{ header: [false, 1, 2, 3] }],
  ["bold", "italic", "underline", "strike"],
  [{ color: [] }, { background: [] }],
  [{ align: [] }],
  [{ list: "ordered" }, { list: "bullet" }],
  [{ indent: "-1" }, { indent: "+1" }],
  ["blockquote"],
  ["clean"],
];

// Quill 富文本编辑器封装（受控：value 为 HTML 字符串）
// 直接用 Quill 原生 API，不经过 React 包装库，兼容 React 19
export default function RichTextEditor({ value, onChange, placeholder, minHeight = 380 }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const quillRef = useRef<Quill | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // 标记当前 HTML 是否来自编辑器自身输入，避免 onChange → value → 重设的死循环
  const internalChangeRef = useRef(false);

  useEffect(() => {
    if (!hostRef.current) return;
    const quill = new Quill(hostRef.current, {
      theme: "snow",
      placeholder: placeholder || "请输入内容…",
      modules: { toolbar: TOOLBAR_OPTIONS },
    });
    quillRef.current = quill;
    if (value) {
      quill.clipboard.dangerouslyPasteHTML(value);
    }
    quill.on("text-change", () => {
      const html = quill.root.innerHTML;
      internalChangeRef.current = true;
      onChangeRef.current?.(html === "<p><br></p>" ? "" : html);
    });
    return () => {
      quillRef.current = null;
    };
    // 仅初始化一次；后续 value 同步由下面的 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部 value 变化（如切换模板、导入文件填入、套用生成时手动输入联动）时同步进编辑器。
  // 注意：不能用 dangerouslyPasteHTML——它内部 getSelection(true) 会强制聚焦编辑器，
  // 导致在其他输入框打字时焦点被抢走。这里用 convert + setContents('silent') 无焦点更新。
  useEffect(() => {
    if (internalChangeRef.current) {
      internalChangeRef.current = false;
      return;
    }
    const quill = quillRef.current;
    if (!quill) return;
    const current = quill.root.innerHTML;
    const next = value || "";
    if (next === current || (next === "" && current === "<p><br></p>")) return;
    const hadFocus = quill.hasFocus();
    const sel = hadFocus ? quill.getSelection() : null;
    quill.setContents(quill.clipboard.convert({ html: next }), "silent");
    if (hadFocus && sel) {
      // 编辑器正在被使用时尽量保住光标位置
      const maxIndex = Math.max(quill.getLength() - 1, 0);
      quill.setSelection(Math.min(sel.index, maxIndex), 0, "silent");
    }
  }, [value]);

  return (
    <div className="rich-text-editor">
      <div ref={hostRef} style={{ minHeight }} />
    </div>
  );
}
