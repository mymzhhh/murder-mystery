import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
// 复用原公共样式（黑金主题等）；已复制到 src/styles/ 以便独立构建
// （Docker 构建时 frontend/ 是唯一构建上下文，无法跨 root 引用 public/）
import "./styles/common.css";

createRoot(document.getElementById("root")).render(<App />);