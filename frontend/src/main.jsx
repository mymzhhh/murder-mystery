import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
// 复用原公共样式（黑金主题等），渐进迁移
import "../../public/common.css";

createRoot(document.getElementById("root")).render(<App />);