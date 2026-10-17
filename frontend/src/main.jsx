import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
// 样式放在 src/styles/ 下以便独立构建
// （Docker 构建时 frontend/ 是唯一构建上下文，无法跨 root 引用 public/）
// 分层见 styles/index.css 的说明：tokens → base → components → pages
import "./styles/index.css";

/**
 * 顶层错误边界。
 *
 * 为什么必须有：React 在渲染期抛异常时会**卸载整棵树**，页面只剩 body 的深色背景 ——
 * 也就是一块纯黑屏，看不出任何原因。排查这种问题只能靠翻控制台，非常费时。
 * 有了边界至少能把错误信息直接摆在页面上。
 *
 * 注意它只能接住"渲染期"的错误。如果是 /assets/*.js 本身 404（入口 HTML 过期导致的），
 * 代码根本没机会执行，边界也救不了 —— 那种情况由服务端给入口 HTML 加 no-store 解决。
 */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[ui] 渲染出错:", error, info && info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const msg = String((this.state.error && this.state.error.message) || this.state.error || "未知错误");
    // 用页面自己的类与令牌，而不是内联的硬编码颜色 ——
    // 崩屏也是产品的一部分，不该是整个界面里唯一一块旧配色的地方。
    return (
      <div className="crash">
        <div className="crash-card">
          <div className="kicker" style={{ marginBottom: 14 }}><span style={{ flex: "0 0 auto" }}>渲染异常</span></div>
          <h2>页面出错了</h2>
          <p>
            界面渲染时抛了异常。可以先点下面的按钮重新加载；如果反复出现，
            把下面这段错误信息发出来。
          </p>
          <pre className="crash-msg">{msg}</pre>
          <button className="btn btn-primary btn-auto" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
