import { useEffect, useState, type ComponentType } from "react";
import Spin from "antd/es/spin";
import Button from "antd/es/button";
import Alert from "antd/es/alert";

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
 */

type Loader = () => Promise<{ default: ComponentType<any> }>;

const cache = new Map<Loader, ComponentType<any>>();

export function lazyPage(loader: Loader): ComponentType<any> {
  function LazyPage(props: any) {
    const [Comp, setComp] = useState<ComponentType | null>(() => cache.get(loader) ?? null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
      if (cache.has(loader)) return;
      let alive = true;
      setFailed(false);
      loader()
        .then((m) => {
          cache.set(loader, m.default);
          if (alive) setComp(() => m.default);
        })
        .catch(() => {
          if (alive) setFailed(true);
        });
      return () => {
        alive = false;
      };
    }, []);

    if (failed) {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center", padding: "48px 16px" }}>
          <Alert type="warning" showIcon message="页面加载失败，请检查网络后重试" style={{ maxWidth: 420 }} />
          <Button
            type="primary"
            onClick={() => {
              setFailed(false);
              loader()
                .then((m) => {
                  cache.set(loader, m.default);
                  setComp(() => m.default);
                })
                .catch(() => setFailed(true));
            }}
          >
            重试
          </Button>
        </div>
      );
    }

    if (!Comp) {
      return (
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: 240 }}>
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
