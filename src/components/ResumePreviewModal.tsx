import { useState, useEffect } from "react";
import { Modal, Spin, Alert } from "antd";
import mammoth from "mammoth";
import { api } from "../api";
import type { Talent } from "../types";

interface Props {
  talent: Talent | null;
  onClose: () => void;
}

// 从 resume_url（KV key，形如 resume:{id}:{uuid}.pdf）取文件扩展名
function getExt(resumeUrl: string | null): string {
  if (!resumeUrl) return "";
  const m = resumeUrl.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "";
}

// 统一的简历预览弹窗：
// - PDF：iframe 原生渲染，完整保留原始排版
// - Word(.docx)：前端拉取文件后用 mammoth 转成 HTML 直接在线查看，不触发下载
export default function ResumePreviewModal({ talent, onClose }: Props) {
  const [docHtml, setDocHtml] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const ext = talent ? getExt(talent.resume_url) : "";
  const isWord = ext === "docx" || ext === "doc";

  useEffect(() => {
    if (!talent || !isWord) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setDocHtml("");
    (async () => {
      try {
        const res = await fetch(api.getResumeUrl(talent.id));
        if (!res.ok) throw new Error("简历文件加载失败");
        const buf = await res.arrayBuffer();
        const result = await mammoth.convertToHtml({ arrayBuffer: buf });
        if (!cancelled) setDocHtml(result.value);
      } catch (e) {
        if (!cancelled) setError((e as Error).message || "简历解析失败");
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [talent?.id]);

  return (
    <Modal
      title={talent ? `简历预览 - ${talent.name}` : "简历预览"}
      open={!!talent}
      onCancel={onClose}
      width="90%"
      style={{ top: 20 }}
      footer={null}
      destroyOnClose
    >
      {talent && (isWord ? (
        loading ? (
          <div style={{ textAlign: "center", padding: "4rem" }}>
            <Spin size="large" />
            <div style={{ marginTop: 12, color: "#888" }}>正在解析 Word 简历…</div>
          </div>
        ) : error ? (
          <Alert message={error} type="error" showIcon />
        ) : (
          <div className="resume-doc-preview" dangerouslySetInnerHTML={{ __html: docHtml }} />
        )
      ) : (
        <iframe
          src={api.getResumeUrl(talent.id)}
          style={{ width: "100%", height: "80vh", border: "none", borderRadius: 8 }}
          title="简历预览"
        />
      ))}
    </Modal>
  );
}
