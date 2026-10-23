import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), cloudflare()],
  build: {
    rollupOptions: {
      output: {
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
          if (
            id.includes("node_modules/antd/") ||
            id.includes("node_modules/@ant-design/") ||
            id.includes("node_modules/rc-") ||
            id.includes("node_modules/dayjs/")
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
