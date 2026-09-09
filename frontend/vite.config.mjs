import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// React 前端：开发时 proxy 到后端 3000；构建产物输出到 dist/ 供生产托管
export default defineConfig({
  plugins: [react()],
  root: ".",
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1024,
    rollupOptions: {
      output: {
        // 拆包：react 运行时与 socket.io 单独成块，利用浏览器缓存（改业务代码不必重下框架）
        // 注：Vite 8 使用 rolldown，manualChunks 需为函数形式
        manualChunks(id) {
          if (id.includes("node_modules/react-dom") || id.includes("node_modules/react/")) return "react";
          if (id.includes("node_modules/socket.io-client") || id.includes("node_modules/engine.io-client")) return "socketio";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/socket.io": { target: "http://localhost:3000", ws: true, changeOrigin: true },
    },
  },
});