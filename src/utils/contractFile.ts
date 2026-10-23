import { api } from "../api";

/**
 * 合同文件 → 纯文本。
 *
 * 与简历导入共用同一条服务端抽取链路（POST /api/parse-resume/file?ai=0，
 * 该接口本质是「任意 PDF/docx → 文本」，简历与合同都走它）：
 * 浏览器不再下载 pdfjs（worker 1.4MB + 主库 0.8MB）与 mammoth（350KB），
 * 弱网下快一个数量级；NFKC 归一化与扫描件检测也由服务端统一处理。
 *
 * 不支持 .doc 老格式。
 */
export async function extractContractText(file: File): Promise<string> {
  const r = await api.parseResumeFile(file, false);
  return r.text;
}
