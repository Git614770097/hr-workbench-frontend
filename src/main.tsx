import React, { useState } from "react";
import ReactDOM from "react-dom/client";
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
import { getThemeKey, applyTheme, getTheme, type ThemeKey } from "./theme";
import "./styles/global.css";

dayjs.locale("zh-cn");

function Root() {
  const [themeKey, setThemeKey] = useState<ThemeKey>(() => {
    const key = getThemeKey();
    applyTheme(key);
    return key;
  });

  const changeTheme = (key: ThemeKey) => {
    setThemeKey(key);
    applyTheme(key);
  };

  const theme = getTheme(themeKey);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: theme.colorPrimary,
          borderRadius: 8,
        },
      }}
    >
      <BrowserRouter>
        <App themeKey={themeKey} onChangeTheme={changeTheme} />
      </BrowserRouter>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
