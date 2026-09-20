import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ConfigProvider, theme as antdTheme } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";
import { getThemeKey, applyTheme, getTheme, type ThemeKey } from "./theme";
import "./styles/global.css";

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
