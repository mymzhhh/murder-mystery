import React, { useState, Suspense } from "react";
import { clearAuth } from "../lib/api.js";
import PipelinePage from "./PipelinePage.jsx";
import ScriptsPage from "./ScriptsPage.jsx";
import StatsPage from "./StatsPage.jsx";
import ModelsPage from "./ModelsPage.jsx";
import UsersPage from "./UsersPage.jsx";
import RoomsPage from "./RoomsPage.jsx";

const TABS = [
  { key: "pipeline", label: "剧本生成", comp: PipelinePage },
  { key: "scripts", label: "剧本管理", comp: ScriptsPage },
  { key: "stats", label: "仪表盘", comp: StatsPage },
  { key: "models", label: "模型管理", comp: ModelsPage },
  { key: "users", label: "用户管理", comp: UsersPage },
  { key: "rooms", label: "房间管理", comp: RoomsPage },
];

export default function AdminApp() {
  const [tab, setTab] = useState("pipeline");
  // 懒挂载：只挂载"访问过"的页面（keep-alive 保留状态），避免登录即触发 6 个页面的请求
  const [mounted, setMounted] = useState(() => new Set(["pipeline"]));

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
        <h1 style={{ cursor: "pointer" }} onClick={() => switchTab("pipeline")}>剧本杀管理端</h1>
        <div className="nav-tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`nav-tab ${tab === t.key ? "active" : ""}`} onClick={() => switchTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        <span className="user-info" style={{ marginLeft: "auto", padding: "0 10px" }}></span>
        <button className="btn btn-outline btn-sm" onClick={logout}>退出</button>
      </header>

      <div className="main-content" style={{ padding: 20 }}>
        <Suspense fallback={<div className="state-loading">加载中...</div>}>
          {/* keep-alive：已访问的页面保持挂载（display 切换），生成进度等状态不会因切页丢失 */}
          {TABS.filter((t) => mounted.has(t.key)).map((t) => (
            <div key={t.key} style={{ display: tab === t.key ? "block" : "none" }}>
              <t.comp />
            </div>
          ))}
        </Suspense>
      </div>
    </div>
  );
}