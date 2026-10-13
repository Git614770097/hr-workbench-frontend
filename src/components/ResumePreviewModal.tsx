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
  const [pdfUrl, setPdfUrl] = useState("");

  const ext = talent ? getExt(talent.resume_url) : "";
  const isWord = ext === "docx" || ext === "doc";

  useEffect(() => {
    if (!talent) return;
    let cancelled = false;
    setError("");
    setDocHtml("");
    setPdfUrl("");
    (async () => {
      try {
        // 无简历文件直接报错，不去请求票据（避免无意义的接口往返后干等）
        if (!talent.resume_url) throw new Error("该人才暂无简历文件");
        // 先取 60s 短期票据再拉取/预览，不再把会话 token 放进 URL
        const url = await api.getResumeUrl(talent.id);
        if (isWord) {
          setLoading(true);
          // 文件下载加 60s 超时兜底：KV 冷启动 / 大文件挂起时不再无限转圈
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 60000);
          let res: Response;
          try {
            res = await fetch(url, { signal: ctrl.signal });
          } catch (e) {
            clearTimeout(timer);
            throw new Error(
              (e as Error)?.name === "AbortError" ? "简历下载超时（60 秒），请稍后重试" : "网络异常，简历下载失败"
            );
          }
          clearTimeout(timer);
          if (!res.ok) throw new Error(`简历文件加载失败（${res.status}）`);
          const buf = await res.arrayBuffer();
          const result = await mammoth.convertToHtml({ arrayBuffer: buf });
          if (!cancelled) setDocHtml(result.value);
        } else {
          if (!cancelled) setPdfUrl(url);
        }
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
      {talent && (error ? (
        // 错误优先展示：此前 PDF 分支不渲染 error，票据失败时会永久转圈（看起来像一直加载）
        <Alert message={error} type="error" showIcon />
      ) : isWord ? (
        loading ? (
          <div style={{ textAlign: "center", padding: "4rem" }}>
            <Spin size="large" />
            <div style={{ marginTop: 12, color: "#888" }}>正在解析 Word 简历…</div>
          </div>
        ) : (
          <div className="resume-doc-preview" dangerouslySetInnerHTML={{ __html: docHtml }} />
        )
      ) : (
        pdfUrl ? (
          <iframe
            src={pdfUrl}
            style={{ width: "100%", height: "80vh", border: "none", borderRadius: 8 }}
            title="简历预览"
          />
        ) : (
          <div style={{ textAlign: "center", padding: "4rem" }}>
            <Spin size="large" />
          </div>
        )
      ))}
    </Modal>
  );
}
