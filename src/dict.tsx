import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api } from "./api";
import { SOURCE_OPTIONS, REJECT_REASONS, EDUCATION_OPTIONS, JOB_TYPE_LABELS, CITY_OPTIONS, SKILL_OPTIONS } from "./types";

/**
 * 数据字典（来源渠道 / 淘汰原因 / 学历 / 职位类型 / 城市 / 技能）—— 不同公司叫法不一样，
 * 交由管理员在「系统设置 → 数据字典」里配置；未配置或拉取失败时回落到代码内置默认值。
 */
export interface DictValue {
  sources: string[];
  rejectReasons: string[];
  /** 学历选项（中文原文即存储值） */
  education: string[];
  /** 职位类型 key→中文标签 映射（key 固定，标签可改） */
  jobTypeLabels: Record<string, string>;
  /** 城市选项 */
  cities: string[];
  /** 技能标签库（用于输入补全） */
  skills: string[];
  /** 管理员改完字典后调用，让全站下拉立即生效 */
  reload: () => void;
}

const DictContext = createContext<DictValue>({
  sources: SOURCE_OPTIONS,
  rejectReasons: REJECT_REASONS,
  education: EDUCATION_OPTIONS,
  jobTypeLabels: JOB_TYPE_LABELS,
  cities: CITY_OPTIONS,
  skills: SKILL_OPTIONS,
  reload: () => {},
});

export function DictProvider({ children }: { children: ReactNode }) {
  const [sources, setSources] = useState<string[]>(SOURCE_OPTIONS);
  const [rejectReasons, setRejectReasons] = useState<string[]>(REJECT_REASONS);
  const [education, setEducation] = useState<string[]>(EDUCATION_OPTIONS);
  const [jobTypeLabels, setJobTypeLabels] = useState<Record<string, string>>(JOB_TYPE_LABELS);
  const [cities, setCities] = useState<string[]>(CITY_OPTIONS);
  const [skills, setSkills] = useState<string[]>(SKILL_OPTIONS);

  const load = useCallback(async () => {
    try {
      const d = await api.getDictConfig();
      if (Array.isArray(d?.sources) && d.sources.length > 0) setSources(d.sources);
      if (Array.isArray(d?.reject_reasons) && d.reject_reasons.length > 0) setRejectReasons(d.reject_reasons);
      if (Array.isArray(d?.education) && d.education.length > 0) setEducation(d.education);
      if (d?.job_types && typeof d.job_types === "object") setJobTypeLabels(d.job_types);
      if (Array.isArray(d?.cities) && d.cities.length > 0) setCities(d.cities);
      if (Array.isArray(d?.skills) && d.skills.length > 0) setSkills(d.skills);
    } catch {
      // 拉取失败保持默认值，不阻断页面
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <DictContext.Provider value={{ sources, rejectReasons, education, jobTypeLabels, cities, skills, reload: load }}>
      {children}
    </DictContext.Provider>
  );
}

export function useDict(): DictValue {
  return useContext(DictContext);
}
