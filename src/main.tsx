import React, { useState } from "react";
import ReactDOM from "react-dom/client";
// React 19 + antd v5 官方兼容补丁：必须放在所有 antd 引用之前。
// 没有它，antd 的静态方法（Modal.confirm / message / notification）在
// React 19 下静默失败——点击后什么都不渲染，表现为「点了没反应」。
import "@ant-design/v5-patch-for-react-19";
import { BrowserRouter } from "react-router-dom";
import { ConfigProvider, theme as antdTheme } from "antd";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
// 日期组件中文化必须显式引入 dayjs 的 zh-cn 语言包并设为默认：
// antd 的 ConfigProvider locale 只能翻译「组件外壳」文案（如月份选择器的按钮），
// DatePicker / Calendar 面板内部的星期、月份名称来自 dayjs 自身 locale，
// 只传 antd locale 会出现「外壳中文、面板英文」的混合状态。
import "dayjs/locale/zh-cn";
import App from "./App";
import { getThemeState, applyTheme, getColorDef, saveThemeState, type ThemeState } from "./theme";
import "./styles/global.css";

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
