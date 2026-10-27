import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 带「陈旧结果丢弃」的异步数据加载。
 *
 * 为什么需要它——这个项目里 51 个页面/组件中只有 6 个写了取消守卫，
 * 典型写法是：
 *
 *   const fetchData = async () => { setData(await api.getX(id)); };
 *   useEffect(() => { fetchData(); }, [id]);
 *
 * 问题在**请求会重叠**：用户在人才 A 的详情页快速切到 B 时，A 的响应如果比 B 慢，
 * 就会在 B 已经渲染之后把 A 的数据写进 state——页面地址是 B，显示的是 A。
 * 网络越差、接口越慢越容易复现，本地开发几乎看不到。
 *
 * 这个 hook 保证「只有最后一次发起的请求能写 state」，之前的结果一律丢弃。
 *
 * ⚠️ 它**不做**真正的请求取消：`api.*` 目前不接受 AbortSignal。
 * 这里丢的是「已经回来的陈旧响应」，省不掉那点流量，但能保证显示正确——
 * 而显示正确才是这个 bug 的要害。要做真取消得让 api 层透传 signal，属于另一件事。
 *
 * 用法：
 *
 *   const { data, loading, error, reload } = useAsyncData(
 *     () => api.getTalent(id!),
 *     [id],
 *     { enabled: !!id }        // 条件加载；false 时不动 state、不发请求
 *   );
 *
 * deps 的语义与 useEffect 一致；getter 不必 memo（内部用 ref 取最新值），
 * 这样调用方不用为了「不触发重跑」而到处写 useCallback。
 *
 * `reload()` 返回 Promise，等本次请求真正落地才 resolve——因为很多调用点是
 * 「改完数据 → await 刷新 → 收尾」（比如移动端推进阶段后要等列表刷新再复位按钮状态）。
 * 如果它只是个不返回 Promise 的触发器，那些地方的收尾会提前执行。
 *
 * `onError` 用来承接原来写在 catch 里的提示（`message.error(e.message)`），
 * 这样迁移时「失败弹一条 toast」的行为不会丢。它同时也会把 error 放回返回值，
 * 需要就地渲染错误态的调用方可以二选一。
 *
 * `keepOnError`（默认 false）决定请求失败时要不要保留上一次的数据：
 *   - 列表页传 true：网络抖一下不该把表格清空（旧代码就是「弹 toast + 列表不动」）。
 *   - 详情页保持默认：否则切到 B 失败时会继续显示 A 的数据，正是这个 hook 要消除的错。
 */
export function useAsyncData<T>(
  getter: () => Promise<T>,
  deps: unknown[],
  options: { enabled?: boolean; onError?: (e: Error) => void; keepOnError?: boolean } = {}
): { data: T | null; loading: boolean; error: Error | null; reload: () => Promise<void> } {
  const { enabled = true } = options;

  // 每次 render 更新 ref：getter 里通常闭包了 id / 筛选条件，
  // 用 ref 拿「当前这次 render 的 getter」，就不必要求调用方 memo 它。
  const getterRef = useRef(getter);
  getterRef.current = getter;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;

  const [state, setState] = useState<{ data: T | null; loading: boolean; error: Error | null }>({
    data: null,
    loading: enabled,
    error: null,
  });

  // reload 用自增计数触发，避免调用方传一个「假的 dep」
  const [nonce, setNonce] = useState(0);
  // 请求序号：只有最新一次发起的请求才有资格写 state
  const runRef = useRef(0);
  // 等待 reload 落地的 resolver，由下一次 effect 认领
  const queuedRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    if (!enabled) {
      // 条件不满足：清空并停掉 loading，避免页面永久转圈
      setState({ data: null, loading: false, error: null });
      const dropped = queuedRef.current;
      queuedRef.current = [];
      for (const resolve of dropped) resolve();
      return;
    }

    let alive = true;
    const run = ++runRef.current;
    const waiters = queuedRef.current;
    queuedRef.current = [];
    const settle = () => {
      for (const resolve of waiters) resolve();
    };

    // 保留上一次的 data：切筛选/翻页时不要让表格先闪成空
    setState((prev) => ({ data: prev.data, loading: true, error: null }));

    getterRef.current().then(
      (data) => {
        if (alive && run === runRef.current) setState({ data, loading: false, error: null });
        settle();
      },
      (e: unknown) => {
        const err = e instanceof Error ? e : new Error(String(e));
        // 陈旧响应引发的失败同样不该弹 toast（用户早就切走了）
        if (alive && run === runRef.current) {
          setState((prev) => ({
            data: options.keepOnError ? prev.data : null,
            loading: false,
            error: err,
          }));
          onErrorRef.current?.(err);
        }
        settle();
      }
    );

    return () => {
      // 卸载，或 deps 变了（此时新一轮会立刻把 runRef 加一，旧结果被丢弃）
      alive = false;
    };
    // deps 由调用方给出，长度可变，这里无法静态展开
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, nonce]);

  const reload = useCallback(
    () =>
      new Promise<void>((resolve) => {
        queuedRef.current.push(resolve);
        setNonce((n) => n + 1);
      }),
    []
  );

  return { ...state, reload };
}
