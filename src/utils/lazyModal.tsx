import { useEffect, useState, type ComponentType } from "react";
import message from "antd/es/message";
import { reportClientError } from "./clientError";
import { isChunkLoadError, tryAutoReload } from "./chunkError";

/**
 * 弹窗类懒加载（替代 React.lazy）。
 *
 * 为什么不用 React.lazy：它的 reject 会被抛给最近的 error boundary，而本项目只有
 * 一个顶层 ErrorBoundary —— 点「修改密码」时那个 chunk 404，整页会被替换成
 * 「页面出错了」，把用户正在填的东西全冲掉。弹窗加载失败应该只是「这个功能打不开」，
 * 页面本身必须还在。
 *
 * 失败处理：
 *  1. 上报（带弹窗名），让这类错误在审计日志里可见；
 *  2. chunk 404 → 自动刷新一次（旧文件被发版删了，重试没意义）；
 *  3. 刷不了 → 提示 + 调 onClose 关掉弹窗。关掉是刻意的：下次点开时本组件会
 *     重新挂载、effect 重跑、重新 import（失败的 dynamic import 不会被浏览器永久缓存），
 *     等于免费得到一个「重试」入口。
 */

type ModalLoader<P> = () => Promise<{ default: ComponentType<P> }>;

const cache = new Map<ModalLoader<any>, ComponentType<any>>();

export function lazyModal<P>(loader: ModalLoader<P>, name: string): ComponentType<P> {
  function LazyModal(props: any) {
    const [Comp, setComp] = useState<ComponentType | null>(() => cache.get(loader) ?? null);

    useEffect(() => {
      if (cache.has(loader)) return;
      let alive = true;
      loader()
        .then((m) => {
          const mod = (m as { default?: ComponentType } | undefined)?.default;
          if (!mod) throw new Error(`模块 ${name} 没有默认导出`);
          cache.set(loader, mod);
          if (alive) setComp(() => mod as ComponentType);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          const error = err instanceof Error ? err : new Error(String(err));
          reportClientError(new Error(`弹窗加载失败 ${name}：${error.message}`));
          if (isChunkLoadError(error) && tryAutoReload(`modal:${name}`)) return;
          message.error(`「${name}」暂时打不开，请稍后重试或刷新页面`);
          // 关掉弹窗，让下次点开能重新走一遍加载。
          // 传 true 表示「异常关闭」——个别弹窗（改密码）正常关闭时会顺手记一笔
          // 「本次会话别再弹」，加载失败不该触发那个副作用。
          if (typeof props.onClose === "function") props.onClose(true);
        });
      return () => {
        alive = false;
      };
      // props.onClose 只在失败时读一次，不需要作为依赖（每次渲染都是新函数会反复触发）
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (!Comp) return null;
    return <Comp {...props} />;
  }
  return LazyModal as ComponentType<P>;
}
