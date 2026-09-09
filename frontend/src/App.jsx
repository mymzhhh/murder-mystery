import React, { useState, useEffect } from "react";
import { getUser, getToken } from "./lib/api.js";
import LoginPage from "./pages/LoginPage.jsx";
import PlayerApp from "./player/PlayerApp.jsx";
import AdminApp from "./admin/AdminApp.jsx";

// 简单 hash 路由： #/player(玩家端)  #/admin(管理端)  默认按登录角色分流
export default function App() {
  const [route, setRoute] = useState(() => window.location.hash || "#/");
  const [authed, setAuthed] = useState(!!getToken());
  const [user, setUser] = useState(() => getUser());

  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || "#/");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const page = route.split("?")[0];

  if (!authed) {
    return (
      <LoginPage
        onLogin={() => {
          setUser(getUser());
          setAuthed(true);
        }}
      />
    );
  }

  if (page.startsWith("#/player")) return <PlayerApp />;
  if (page.startsWith("#/admin")) return <AdminApp />;

  // 默认按角色分流：管理员→管理端，普通玩家→玩家端
  return (user && user.role === "admin") ? <AdminApp /> : <PlayerApp />;
}