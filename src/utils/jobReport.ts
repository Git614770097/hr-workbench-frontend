import type { JobDetail } from "../types";
import { PIPELINE_STAGES } from "../types";

/**
 * 组装「AI 岗位诊断」的输入数据。
 *
 * 为什么抽成公共工具：这份结构原来只写在 Jobs.tsx 的岗位详情弹窗里，
 * 后来「AI 助手」页也要用同一份诊断（同一个岗位、同一套口径）。
 * 复制两份必然漂移——诊断结论会因两处取数口径不同而对不上，
 * 用户在两个页面看到互相矛盾的结论。所以单一来源。
 *
 * 数据全部来自 job detail（已在后端按owner 隔离），这里只做聚合与截断，
 * 不额外查询；备注样本截 60 字、职责/要求摘要截 300 字，避免 prompt 过长。
 */
export function buildJobDiagnosisReport(detail: JobDetail): Record<string, unknown> {
  const cs = detail.candidates || [];

  const toDays = (s: string | null) => {
    if (!s) return null;
    const d = new Date(s.length === 10 ? s + "T00:00:00Z" : s.replace(" ", "T") + "Z");
    return isNaN(d.getTime()) ? null : Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
  };

  const avgStay = (stage: string) => {
    const days = cs
      .filter((c) => c.stage === stage)
      .map((c) => toDays(c.updated_at))
      .filter((n): n is number => n != null);
    return days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : null;
  };

  return {
    岗位: {
      名称: detail.title,
      部门: detail.department || "",
      城市: detail.city || "",
      状态: detail.status,
      HC: detail.headcount,
      优先级: detail.priority,
      创建天数: toDays(detail.created_at),
      职责摘要: (detail.description || "").slice(0, 300) || "（空）",
      要求摘要: (detail.requirements || "").slice(0, 300) || "（空）",
    },
    各阶段人数: detail.stage_counts,
    候选人总数: cs.length,
    进行中阶段平均停留天数: Object.fromEntries(
      PIPELINE_STAGES.filter((s) => !s.terminal).map((s) => [s.label, avgStay(s.key)])
    ),
    终态: {
      已入职: cs.filter((c) => c.stage === "hired").length,
      已淘汰: cs.filter((c) => c.stage === "rejected").length,
      已放弃: cs.filter((c) => c.stage === "withdrawn").length,
    },
    候选人平均年限: cs.length
      ? Math.round((cs.reduce((a, c) => a + (c.years_experience || 0), 0) / cs.length) * 10) / 10
      : null,
    备注样本: cs.filter((c) => c.notes).slice(0, 3).map((c) => (c.notes || "").slice(0, 60)),
  };
}