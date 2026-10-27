import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import Spin from "antd/es/spin";
import Button from "antd/es/button";
import Alert from "antd/es/alert";
import { reportClientError } from "./clientError";
import { isChunkLoadError, tryAutoReload } from "./chunkError";

/**
 * 非挂起式懒加载（替代 React.lazy）。
 *
 * 背景：react-router v7 的 navigate 包在 React.startTransition 里。用 React.lazy 时，
 * 目标页 chunk 未下载完会 suspend，而 transition 的语义是「新 UI 没准备好就继续渲染旧 UI」——
 * 于是 URL 已经变了，页面却一直停在点击前的那一页，用户以为没点上。
 *
 * 这里改成 useState + useEffect 自己拉模块：组件挂载后第一帧就渲染加载占位，
 * 旧页面立刻被替换（不再赖着不走）；模块就绪后一次替换。
 * 模块缓存后命中缓存直接渲染，无闪烁。
 *
 * 失败分两类，因为对用户的含义完全不同：
 *  - chunk 拿不到（404）：发版删了旧文件，重试无意义 → 自动刷新一次拿新的 index.html；
 *  - 其他错误（网络抖动 / 模块自身抛错）：重试有意义 → 显示「重试」。
 * 两类都要上报，否则这类错误在审计日志里根本看不见。
 */

type Loader = () => Promise<{ default: ComponentType<any> }>;

type Failure = { chunk: boolean; message: string };

const cache = new Map<Loader, ComponentType<any>>();

const centerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  minHeight: 240,
};

const failedWrapStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  alignItems: "center",
  padding: "48px 16px",
};

/**
 * @param name 仅用于上报文案（如 "/tasks"）。出错的 URL 通常就是目标页
 *   （路由先变、chunk 后到），但预取和多标签场景下 location 未必指向它，
 *   显式标注最可靠。
 */
export function lazyPage(loader: Loader, name?: string): ComponentType<any> {
  const label = name || "unknown-page";

  function LazyPage(props: any) {
    const [Comp, setComp] = useState<ComponentType | null>(() => cache.get(loader) ?? null);
    const [failure, setFailure] = useState<Failure | null>(null);
    const [reloading, setReloading] = useState(false);

    // 卸载后不再 setState（切页很快时 loader 可能还在飞）
    const mountedRef = useRef(true);
    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
      };
    }, []);

    // 首挂载和「重试」按钮共用
    const load = useCallback(() => {
      setFailure(null);
      loader()
        .then((m) => {
          // 防御：构建器包装异常时 m 可能是 undefined，直接读 .default 会抛 TypeError，
          // 那条 TypeError 既不像 chunk 错误也定位不到页面，白丢一条有效线索。
          const mod = (m as { default?: ComponentType } | undefined)?.default;
          if (!mod) throw new Error(`模块 ${label} 没有默认导出`);
          cache.set(loader, mod);
          if (mountedRef.current) setComp(() => mod);
        })
        .catch((err: unknown) => {
          if (!mountedRef.current) return;
          const error = err instanceof Error ? err : new Error(String(err));
          const chunk = isChunkLoadError(error);
          reportClientError(new Error(`懒加载失败 ${label}：${error.message}`));
          // chunk 404 = 旧文件已被发版删掉，重试没有意义，直接换新的 index.html
          if (chunk && tryAutoReload(label)) {
            setReloading(true);
            return;
          }
          setFailure({ chunk, message: error.message });
        });
    }, []);

    useEffect(() => {
      if (cache.has(loader)) return;
      load();
      // load 由 useCallback 包着、已依赖 loader，这里不重复列
    }, [load]);

    if (reloading) {
      return (
        <div style={{ ...centerStyle, flexDirection: "column", gap: 12 }}>
          <Spin size="large" />
          <div style={{ color: "var(--text-3)", fontSize: 13 }}>页面已更新，正在重新加载…</div>
        </div>
      );
    }

    if (failure) {
      return (
        <div style={failedWrapStyle}>
          <Alert
            type="warning"
            showIcon
            message={failure.chunk ? "页面已更新" : "页面加载失败"}
            description={
              failure.chunk
                ? "系统刚发布了新版本，当前页面引用的还是旧文件。刷新一下即可继续。"
                : "可能是网络问题，请重试；反复失败请联系管理员。"
            }
            style={{ maxWidth: 420 }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <Button
              type="primary"
              onClick={() => {
                setReloading(true);
                location.reload();
              }}
            >
              刷新页面
            </Button>
            <Button onClick={load}>重试</Button>
          </div>
        </div>
      );
    }

    if (!Comp) {
      return (
        <div style={centerStyle}>
          <Spin size="large" />
        </div>
      );
    }
    // props 透传：页面类组件没有 props，但登录页这类「壳」组件要带 onLogin / user 等
    return <Comp {...props} />;
  }
  // 预取入口：菜单 hover / 空闲时调用，与页面共用同一 loader（模块缓存天然去重）
  (LazyPage as any).preload = loader;
  return LazyPage;
}
