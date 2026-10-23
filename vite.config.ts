import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare()],
  build: {
    rollupOptions: {
      output: {
        // Rollup 默认把「传递依赖」提升到入口 chunk，即使入口并不直接用它——
        // 结果 antd-heavy 明明只被懒加载页面使用，却被入口 import、进而被
        // index.html modulepreload，白进首屏。关掉后由各 chunk 自己声明依赖。
        hoistTransitiveImports: false,
        // vendor 与业务代码拆 chunk：业务改动只让用户重下业务 chunk（~200KB），
        // react/antd/echarts 等长期不变的走浏览器缓存，不发版本也省重复传输。
        // 函数形式（而非对象）才能把 rc-* / scheduler / dayjs 等间接依赖一并归位。
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/scheduler/") ||
            id.includes("node_modules/react-router") ||
            id.includes("node_modules/@remix-run/")
          ) {
            return "react-vendor";
          }

          // ── antd 三分（2026-10-23）──────────────────────────────────
          // 背景：原来所有 antd 进一个 chunk 且被首屏预加载，于是「登录页」也要
          // 先下完 379KB(gzip) 整包——含 rc-table、rc-picker、rc-tree 这些登录页
          // 根本用不到的东西。实测这条链路 28~30KB/s，该文件经常 60 秒下不完。
          //
          // 关键约束：桶文件 antd/es/index.js 会静态 re-export 全部 78 个组件，
          // 只要它进了首屏模块图，无论怎么配 manualChunks，被页面用到的组件都会
          // 被拖进首屏（试过，等于白拆）。所以首屏链路已全部改成深路径导入
          // （见 main.tsx 顶部注释），桶文件这里单独成 chunk，只被懒加载页面引用。
          if (id.endsWith("node_modules/antd/es/index.js")) return "antd-barrel";

          // 只被具体页面用到、首屏链路确定不引用的组件
          const HEAVY = [
            "antd/es/table", "antd/es/date-picker", "antd/es/time-picker",
            "antd/es/calendar", "antd/es/upload", "antd/es/tree",
            "antd/es/tree-select", "antd/es/cascader", "antd/es/select",
            "antd/es/auto-complete", "antd/es/tabs", "antd/es/steps",
            "antd/es/slider", "antd/es/input-number", "antd/es/mentions",
            "antd/es/image", "antd/es/segmented", "antd/es/rate",
            "antd/es/progress", "antd/es/transfer", "antd/es/pagination",
            "antd/es/list", "antd/es/descriptions", "antd/es/timeline",
            "antd/es/switch", "antd/es/popconfirm",
            "antd/es/statistic", "antd/es/result", "antd/es/card",
            // color-picker 整个目录算重组件：它的交互子树
            //   ColorInput → select、ColorSlider → slider、ColorSteppers → input-number、
            //   PanelPicker → segmented
            // 会把 select/slider/input-number/segmented 一起拖走；而 color-picker
            // 本身是 barrel 引入的、首屏并不渲染，没必要为它背上这四个组件。
            // 例外见下方 KEEP_CORE：color-picker/color 与 components/ColorPresets
            // 被 button/style/token 依赖，必须留在核心。
            "antd/es/color-picker",
            "rc-table", "rc-picker", "rc-upload", "rc-tree", "rc-cascader",
            "rc-select", "rc-tabs", "rc-steps", "rc-slider",
            "rc-input-number", "rc-mentions", "rc-image", "rc-segmented",
            "rc-rate", "rc-progress", "rc-transfer", "rc-pagination",
            "rc-virtual-list", "rc-switch",
          ];
          // ⚠️ dayjs 绝对不能进 HEAVY：首屏 main.tsx 就要 `dayjs.locale("zh-cn")`。
          // 它一旦被划进「重组件」组，Rollup 会把整个重组件的 chunk 变成入口的
          // 静态依赖，于是 rc-table / rc-tree / rc-picker 全部回到首屏。
          // 它本身只有 ~7KB(gzip)，留在 antd-vendor 即可。
          //
          // ⚠️ 同理 antd/es/skeleton 也不能进 HEAVY：Drawer 与 Modal 在 loading
          // 态会渲染 Skeleton，二者都是首屏组件（MobileLayout / FeishuBindConfirmModal）。
          // Skeleton 全部代码约 17KB(raw)，放核心完全可接受。
          //
          // 被首屏组件共享的小模块：即使在 heavy 目录下也留在核心。
          // 这几条都是实测出来的 antd 内部隐式耦合，去掉就会把 heavy 反向拉回首屏：
          //   button/style/token → color-picker/color + components/ColorPresets → collapse
          //   config-provider    → locale/en_US → date-picker/locale；→ empty
          //   tooltip/util       → color-picker/util
          //   radio              → checkbox/useBubbleLock
          //
          // 注意：**不要再加 `/\/style\//` 这种全局兜底**。加过一版，结果 155 个
          // style 文件（584KB，含 table/tabs/date-picker/pagination 的样式）全被
          // 锁在核心 chunk 里，而它们对应的组件明明已经懒加载了。样式应当跟着
          // 组件走：`antd/es/button/style` 天然落在核心，`antd/es/tabs/style`
          // 天然跟着 tabs 一起被自动分包。
          const KEEP_CORE = [
            /\/locale\//,
            /\/_util\//,
            /antd\/es\/modal\/locale/,
            /antd\/es\/color-picker\/(color|util|components\/ColorPresets)/,
            /antd\/es\/empty\//,
            /antd\/es\/checkbox\//,
            /antd\/es\/collapse\//,
            /rc-collapse\//,
            /rc-checkbox\//,
          ];
          // 重组件单独成 chunk。早先失败过一次：那时 dayjs 也在 HEAVY 里，而首屏
          // main.tsx 要 `dayjs.locale("zh-cn")`，于是入口静态 import 了这个 chunk，
          // 再被 index.html modulepreload，等于白拆。把 dayjs 摘出去之后入口不再
          // 需要它，chunk 就不会被提升——这正是下面 KEEP_CORE 之后要 return 的原因。
          if (
            !KEEP_CORE.some((re) => re.test(id)) &&
            HEAVY.some((p) => id.includes(p))
          ) {
            return "antd-heavy";
          }

          if (
            id.includes("node_modules/antd/") ||
            id.includes("node_modules/@ant-design/") ||
            id.includes("node_modules/@rc-component/") ||
            id.includes("node_modules/rc-") ||
            id.includes("node_modules/dayjs/") ||
            // @rc-component/trigger（Tooltip / Popover / Dropdown 的底座）要用它，
            // 而 trigger 是首屏组件，所以它必须留在核心，不能跟着重组件走。
            id.includes("node_modules/resize-observer-polyfill/")
          ) {
            return "antd-vendor";
          }
          if (
            id.includes("node_modules/echarts/") ||
            id.includes("node_modules/zrender/")
          ) {
            return "echarts-vendor";
          }
          // 简历解析已搬到服务端（pdfjs/mammoth 不再进前端包），此处原 doc-vendor
          // 规则随之删除：浏览器不再需要下载解析引擎，首屏与解析都省下约 2.2MB。
        },
      },
    },
  },
});
