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
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/socket.io": { target: "http://localhost:3000", ws: true, changeOrigin: true },
    },
  },
});