import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import type { Plugin } from "vite";

/**
 * 切断 antd/es/form/context.js → rc-field-form 桶文件的依赖。
 *
 * 背景：antd/es/form/context.js 只需要 rc-field-form 的 FormProvider 一个符号，
 * 但它 `import { FormProvider as RcFormProvider } from 'rc-field-form'`——引的是
 * **桶文件**。而 rc-field-form/es/index.js 里有
 *     RefForm.Field = Field; RefForm.List = List; ...
 * 这种「给导出对象赋属性」的语句，Rollup 无法 tree-shake（它看不出这是纯赋值），
 * 于是 Field/Form/List/useForm/useWatch 整棵树 + @rc-component/async-validator
 * 全被拖进来（实测 79KB + 35KB raw）。
 *
 * 而 antd/es/form/context.js 本身在首屏闭包里：
 *   MobileLayout → antd/es/typography → Text → Base → Editable → input/TextArea
 *                → input/Input → form/context
 * 所以这一处不切断，整个 rc-field-form 就会跟着进首屏 chunk。
 *
 * 做法：只在这一处换成深路径 rc-field-form/es/FormContext.js
 * （该文件只依赖 react + babel runtime，独立）。FormProvider 是纯 Context
 * Provider，行为与从桶文件取完全一致。其它引用（antd/es/form/Form.js、
 * FormItem、FormList、hooks/useForm）都属于懒加载页面，不用管。
 */
function splitRcFieldForm(): Plugin {
  return {
    name: "split-rc-field-form",
    enforce: "pre",
    resolveId(source, importer) {
      if (source !== "rc-field-form") return null;
      if (!importer) return null;
      const normalized = importer.replace(/\\/g, "/");
      // 只有 antd/es/form/context.js 这一个「首屏用到」的地方改成深路径
      if (!normalized.includes("/antd/es/form/context.js")) return null;
      return this.resolve("rc-field-form/es/FormContext.js", importer, { skipSelf: true });
    },
  };
}

const REACT_RE =
  /node_modules\/(react|react-dom|scheduler)\/|node_modules\/react-router|node_modules\/@remix-run\//;
const ECHARTS_RE = /node_modules\/(echarts|zrender)\//;
/** 首屏拿不到客户端入口时（worker 构建）的兜底：按路径归堆，等价于改造前的行为。 */
const VENDOR_RE =
  /node_modules\/(antd|@ant-design|@rc-component|rc-|dayjs|resize-observer-polyfill)\//;

/**
 * 「首屏静态闭包」：从 src/main.tsx 出发，只沿**静态** import 边走 BFS。
 *
 * 为什么要它：manualChunks 按**路径**归堆时，会把 `node_modules/rc-field-form/`
 * 这种「首屏根本不可达、只有懒加载页面用」的模块也塞进 antd-vendor，而
 * antd-vendor 是被 index.html modulepreload 的 → 白进首屏。
 * 实测这样白背了 182KB（raw）/ 56KB（gzip）。
 *
 * 按可达性判断后，不可达的 vendor 直接 `return undefined`，交给 Rollup 跟着
 * 懒加载页面异步分包——首屏只剩真正要执行的那部分。
 *
 * ⚠️ 这条路走通的前提是「首屏链路全部深路径导入」。一旦有人写下
 *    `import { X } from "antd"` 或 `from "@ant-design/icons"`，桶文件就进了
 *    main.tsx 的静态闭包，831 个图标 / 78 个组件会全部被判定为「首屏可达」，
 *    再被塞回 antd-vendor。构建完请核对 index.html 的 modulepreload 清单与体积。
 */
function makeFirstScreenSet() {
  let mainId: string | null = null;
  let cache: Set<string> | null = null;

  return function firstScreen(api: {
    getModuleIds: () => Iterable<string>;
    getModuleInfo: (id: string) => { importedIds: readonly string[] } | null | undefined;
  }): Set<string> | null {
    if (!mainId) {
      for (const id of api.getModuleIds()) {
        if (id.replace(/\\/g, "/").endsWith("/src/main.tsx")) {
          mainId = id;
          break;
        }
      }
    }
    // 当前构建没有客户端入口（worker 环境）→ 返回 null，调用方走兜底规则。
    if (!mainId || !api.getModuleInfo(mainId)) return null;
    if (cache) return cache;

    const seen = new Set<string>([mainId]);
    const queue = [mainId];
    while (queue.length) {
      const info = api.getModuleInfo(queue.pop()!);
      if (!info) continue;
      // importedIds 只含静态 import；动态 import 在 dynamicallyImportedIds，
      // 正是我们要排除的（懒加载页面不该算进首屏）。
      for (const dep of info.importedIds) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        queue.push(dep);
      }
    }
    cache = seen;
    return cache;
  };
}

export default defineConfig({
  plugins: [react(), cloudflare(), splitRcFieldForm()],
  build: {
    rollupOptions: {
      output: {
        // Rollup 默认把「传递依赖」提升到入口 chunk，即使入口并不直接用它——
        // 结果懒加载页面用的 chunk 被入口 import、进而被 index.html modulepreload。
        // 关掉后由各 chunk 自己声明依赖。
        hoistTransitiveImports: false,
        // vendor 与业务代码拆 chunk：业务改动只让用户重下业务 chunk，react/antd
        // 等长期不变的走浏览器缓存。
        //
        // 规则只有三条，按顺序短路：
        //   1. react 全家桶 → react-vendor（首屏必需，且跨版本最稳定）
        //   2. echarts      → echarts-vendor（547KB，只有懒加载的漏斗页用）
        //   3. 首屏静态可达的其余 vendor → antd-vendor；不可达 → 不指定，自动异步分包
        //
        // ── 这里踩过的坑，改之前先读 ──────────────────────────────────
        // · 不要按路径把「重组件」单独归堆（曾经的 antd-heavy）。按路径归堆无法
        //   判断「首屏用不用」，一旦某条边漏了（typography/Editable → input/TextArea
        //   就是这种隐式耦合），重组件 chunk 会被入口静态引用 → 被 modulepreload
        //   → 反而白背 528KB。可达性判断从机制上排除了这种情况。
        // · 不要加 `/\/style\//` 这类全局兜底：会把 155 个 style 文件（584KB）锁进
        //   核心。样式要跟着组件走——`antd/es/button/style` 天然在首屏闭包里，
        //   `antd/es/tabs/style` 天然跟着懒加载的 tabs 异步分包。
        // · 不要把 dayjs 划进任何「延后」的规则：main.tsx 要 `dayjs.locale("zh-cn")`。
        // · 桶文件（antd/es/index.js、@ant-design/icons/es/index.js）是这套方案的
        //   唯一软肋：它一旦进了 main.tsx 的静态闭包，可达性判断会把整棵树判成
        //   首屏可达。首屏链路必须全部深路径导入。
        manualChunks: (() => {
          const firstScreen = makeFirstScreenSet();
          return (id: string, api: any) => {
            const nid = id.replace(/\\/g, "/");
            if (!nid.includes("node_modules")) return;
            if (REACT_RE.test(nid)) return "react-vendor";
            if (ECHARTS_RE.test(nid)) return "echarts-vendor";

            const first = firstScreen(api);
            if (first) {
              return first.has(id) || first.has(nid) ? "antd-vendor" : undefined;
            }
            // 兜底（worker 等拿不到客户端入口的构建）
            return VENDOR_RE.test(nid) ? "antd-vendor" : undefined;
          };
        })(),
      },
    },
  },
});
