import React, { useState, Suspense } from "react";
import { clearAuth, getUser } from "../lib/api.js";
import PipelinePage from "./PipelinePage.jsx";
import ScriptsPage from "./ScriptsPage.jsx";
import StatsPage from "./StatsPage.jsx";
import ModelsPage from "./ModelsPage.jsx";
import UsersPage from "./UsersPage.jsx";
import RoomsPage from "./RoomsPage.jsx";
import TestRunPage from "./TestRunPage.jsx";
import TestReportsPage from "./TestReportsPage.jsx";

const TABS = [
  { key: "pipeline", label: "剧本生成", comp: PipelinePage },
  { key: "scripts", label: "剧本管理", comp: ScriptsPage },
  { key: "testrun", label: "测试剧本", comp: TestRunPage },
  { key: "testreports", label: "测试报告", comp: TestReportsPage },
  { key: "stats", label: "仪表盘", comp: StatsPage },
  { key: "models", label: "模型管理", comp: ModelsPage },
  { key: "users", label: "用户管理", comp: UsersPage },
  { key: "rooms", label: "房间管理", comp: RoomsPage },
];

export default function AdminApp() {
  const [tab, setTab] = useState("pipeline");
  // 懒挂载：只挂载"访问过"的页面（keep-alive 保留状态），避免登录即触发 6 个页面的请求
  const [mounted, setMounted] = useState(() => new Set(["pipeline"]));
  const user = getUser() || {};

  function switchTab(key) {
    setTab(key);
    setMounted((prev) => (prev.has(key) ? prev : new Set([...prev, key])));
  }

  function logout() {
    if (!confirm("确定退出登录？")) return;
    clearAuth();
    window.location.hash = "#/";
    window.location.reload();
  }

  return (
    <div>
      <header className="app-header">
        <h1>
          <span className="brand" style={{ cursor: "pointer" }} onClick={() => switchTab("pipeline")}>
            剧本杀 · 管理端
          </span>
        </h1>
        <nav className="nav-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`nav-tab ${tab === t.key ? "active" : ""}`}
              onClick={() => switchTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="header-right">
          <span className="tag tag-admin">管理员</span>
          <span className="user-info">{user.username || ""}</span>
          <button className="btn btn-outline btn-sm" onClick={logout}>退出</button>
        </div>
      </header>

      <div className="main-content">
        <Suspense fallback={<div className="state-loading">加载中…</div>}>
          {/* keep-alive：已访问的页面保持挂载（display 切换），生成进度等状态不会因切页丢失 */}
          {TABS.filter((t) => mounted.has(t.key)).map((t) => (
            <div key={t.key} style={{ display: tab === t.key ? "block" : "none" }}>
              <t.comp onNavigate={switchTab} />
            </div>
          ))}
        </Suspense>
      </div>
    </div>
  );
}
