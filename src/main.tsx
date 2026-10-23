import React, { useState } from "react";
import ReactDOM from "react-dom/client";
// React 19 + antd v5 官方兼容补丁：必须放在所有 antd 引用之前。
// 没有它，antd 的静态方法（Modal.confirm / message / notification）在
// React 19 下静默失败——点击后什么都不渲染，表现为「点了没反应」。
import "@ant-design/v5-patch-for-react-19";
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
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import App from "./App";
import { getThemeState, applyTheme, getColorDef, saveThemeState, type ThemeState } from "./theme";
import "./styles/global.css";
import "./styles/mobile.css";

dayjs.locale("zh-cn");

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
        <App theme={theme} onChangeTheme={changeTheme} />
      </BrowserRouter>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
