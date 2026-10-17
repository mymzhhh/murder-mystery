// API 封装：fetch + 401 处理 + 错误归一
const TOKEN_KEY = "murder_token";
const USER_KEY = "murder_user";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setAuth(token, user) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch (e) { return null; }
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/**
 * 登录/注册**入口接口**：它们的 401 是"这次输入不对"，不是"会话过期"。
 *
 * ⚠️ 实测踩过：`/api/auth/login` 在密码错误时返回 401（`routes/auth.js`），
 * 而下面的全局 401 处理会 clearAuth + 强制跳首页 —— 登录页拿到的错误文案
 * 根本没机会渲染，用户看到的就是"点了登录，页面刷新一下，没有任何提示"。
 * 这两件事必须分开：**会话过期**要清登录态并跳页，**输错密码**要在原地提示。
 */
const AUTH_ENTRY_RE = /^\/api\/auth\/(login|register)$/;

/** 通用请求：自动带 token；401 清登录态并跳登录页（登录/注册入口除外） */
export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (opts.body && typeof opts.body === "string" && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 && !AUTH_ENTRY_RE.test(path)) {
    clearAuth();
    if (window.location.pathname !== "/" ) {
      window.location.href = "/";
    }
    throw new Error("登录已过期，请重新登录");
  }
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try {
      const d = await res.json();
      if (d && d.error) msg = d.error;
    } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  return res;
}

export async function apiJson(path, opts = {}) {
  const res = await api(path, opts);
  return res.json();
}