import React, { useState } from "react";
import ReactDOM from "react-dom/client";
// React 19 + antd v5 官方兼容补丁：必须放在所有 antd 引用之前。
// 没有它，antd 的静态方法（Modal.confirm / message / notification）在
// React 19 下静默失败——点击后什么都不渲染，表现为「点了没反应」。
//
// ⚠️ 这里**不能**直接 `import "@ant-design/v5-patch-for-react-19"`：
//    那个包内部是 `import { unstableSetRender } from 'antd'`——引的是**桶文件**！
//    桶文件 antd/es/index.js 会静态 re-export 全部 78 个组件，一旦它进入首屏
//    模块图，无论怎么配 manualChunks，被页面用到的组件全都会被拖进首屏 chunk。
//    实测：只加这一行，首屏就多背了 radio(21KB) + checkbox(16KB) + table 等一堆
//    首屏根本不渲染的组件，gzip 从 364KB 涨到 522KB。
//
//    官方补丁做的事只有一件：调 antd 的 unstableSetRender 换成 React 19 的
//    createRoot 渲染。而 unstableSetRender 就在 antd/es/config-provider/UnstableContext.js
//    里（深路径，与桶文件 re-export 的是**同一个模块实例**，行为完全一致）。
//    所以这里改成直接引深路径 + 复制补丁的 15 行实现，等价但不带进桶文件。
import { unstableSetRender } from "antd/es/config-provider/UnstableContext";
import { BrowserRouter } from "react-router-dom";
// ⚠️ 首屏链路一律走「深路径导入」，不要写 `from "antd"`。
// 桶文件 antd/es/index.js 会静态 re-export 全部 78 个组件，一旦它进入首屏模块图，
// 无论 tree-shaking 怎么优化，所有被页面用到的组件都会被拖进首屏 chunk
// （实测：首屏只需要 19 个组件，却被迫加载 54 个、1233KB）。
// 判断标准：被 main.tsx 静态可达的文件（本文件、App、api、Login、Layout、
// MobileLayout、ChangelogModal、FeishuBindConfirmModal）必须用深路径。
// 懒加载页面用 `from "antd"` 无妨，它们本来就不在首屏。
import ConfigProvider from "antd/es/config-provider";
import antdTheme from "antd/es/theme";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
// 日期组件中文化必须显式引入 dayjs 的 zh-cn 语言包并设为默认：
// antd 的 ConfigProvider locale 只能翻译「组件外壳」文案（如月份选择器的按钮），
// DatePicker / Calendar 面板内部的星期、月份名称来自 dayjs 自身 locale，
// 只传 antd locale 会出现「外壳中文、面板英文」的混合状态。
import "dayjs/locale/zh-cn";
// JetBrains Mono 本地打包：不再走 jsdelivr CDN（国内不稳定，且字体 render-blocking）。
// 与 global.css 的 --font-mono 配合，仅加载用到的 400/700 两个字重。
// 只取 latin 子集：产品是中文界面，等宽场景几乎只有 ASCII（SQL/代码/数字），
// latin-ext + cyrillic 字重文件纯属白背（每字重约 20KB+）。
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { installGlobalErrorHandlers } from "./utils/clientError";
import { getThemeState, applyTheme, getColorDef, saveThemeState, type ThemeState } from "./theme";
import "./styles/global.css";
import "./styles/mobile.css";

dayjs.locale("zh-cn");

// 全局兜底：未捕获异常 / 未处理 Promise 拒绝也上报留痕（渲染崩溃由 ErrorBoundary 报）
installGlobalErrorHandlers();

// ⚠️ 这里刻意**不监听** vite:preloadError。
//
// 直觉上该在这里接管它（官方文档的示例就是 reload），但实测踩过坑：
// 一旦在 handler 里 event.preventDefault()，Vite 的 __vitePreload 就不会把
// 真实错误抛给调用方，promise 反而 resolve 成 undefined——于是 lazyPage 拿到的是
// "Cannot read properties of undefined (reading 'default')"，识别不出这是 chunk 404，
// 自动刷新和「页面已更新」文案全都失效（上报里只剩一句没头没尾的 TypeError）。
//
// 本项目所有动态 import 都有 catch（lazyPage / lazyModal / prefetchPage），
// 让错误正常传播到它们那里，既能拿到真实的 "Failed to fetch dynamically imported
// module"，也顺带知道是哪个页面。真正没人接的失败由上面的 unhandledrejection 兜住。

// 等价于 @ant-design/v5-patch-for-react-19 的实现（该包内容就是这 15 行）。
// 之所以自己写而不用那个包：它内部 import 的是 antd 桶文件，会把首屏拖成 522KB。
// unstableSetRender 是模块级单例，antd 的 message / notification / Modal.confirm
// 都从同一个 UnstableContext.js 取它，所以这里设置后静态方法照常工作。
unstableSetRender(function (node: React.ReactElement, container: Element | DocumentFragment) {
  const el = container as Element & { _reactRoot?: ReturnType<typeof ReactDOM.createRoot> };
  el._reactRoot || (el._reactRoot = ReactDOM.createRoot(container as Element));
  const root = el._reactRoot;
  root.render(node);
  return function () {
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        root.unmount();
        resolve();
      }, 0);
    });
  };
});

function Root() {
  const [theme, setTheme] = useState<ThemeState>(() => {
    const s = getThemeState();
    applyTheme(s);
    return s;
  });

  const changeTheme = (s: ThemeState) => {
    setTheme(s);
    applyTheme(s);
    saveThemeState(s);
  };

  const colorDef = getColorDef(theme.color);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.mode === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: colorDef.colorPrimary,
          borderRadius: 8,
        },
      }}
    >
      <BrowserRouter>
        {/* 错误边界包在最外层：任何页面渲染崩溃显示兜底卡而非白屏，并上报留痕 */}
        <ErrorBoundary>
          <App theme={theme} onChangeTheme={changeTheme} />
        </ErrorBoundary>
      </BrowserRouter>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
