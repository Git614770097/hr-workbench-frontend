import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api } from "./api";
import { SOURCE_OPTIONS, REJECT_REASONS } from "./types";

/**
 * 数据字典（来源渠道 / 淘汰原因）—— 不同公司叫法不一样，交由管理员在
 * 「用户菜单 → 数据字典」里配置；未配置或拉取失败时回落到代码内置默认值。
 */
export interface DictValue {
  sources: string[];
  rejectReasons: string[];
  /** 管理员改完字典后调用，让全站下拉立即生效 */
  reload: () => void;
}

const DictContext = createContext<DictValue>({
  sources: SOURCE_OPTIONS,
  rejectReasons: REJECT_REASONS,
  reload: () => {},
});

export function DictProvider({ children }: { children: ReactNode }) {
  const [sources, setSources] = useState<string[]>(SOURCE_OPTIONS);
  const [rejectReasons, setRejectReasons] = useState<string[]>(REJECT_REASONS);

  const load = useCallback(async () => {
    try {
      const d = await api.getDictConfig();
      if (Array.isArray(d?.sources) && d.sources.length > 0) setSources(d.sources);
      if (Array.isArray(d?.reject_reasons) && d.reject_reasons.length > 0) setRejectReasons(d.reject_reasons);
    } catch {
      // 拉取失败保持默认值，不阻断页面
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <DictContext.Provider value={{ sources, rejectReasons, reload: load }}>
      {children}
    </DictContext.Provider>
  );
}

export function useDict(): DictValue {
  return useContext(DictContext);
}
