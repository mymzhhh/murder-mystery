/**
 * 诡计类型多样性记忆：记住最近几次用过的类型，下次生成时禁掉。
 *
 * 为什么（2026-10-20 用户实测反馈）：
 *   连着生成的本子**全部是时间诡计**（钟表调慢 + 潮汐/暴雪混淆）。原因是提示词里
 *   把 6 种类型并列让模型自由选，而推理模型天然偏好"最容易自证"的那一类 ——
 *   时钟偏移既能给出精确时刻、又能被物证锚定，于是它总是选时间诡计。
 *
 * 做法（简单、可测、失败不影响生成）：
 *   · Redis 存一个最近类型列表（最多 10 条）；
 *   · 下次生成时把最近 N 种类型作为 bannedTypes 传给诡计设计；
 *   · 但**永远保留至少 3 种可选**，避免把路堵死。
 */
const KEY = "trick:recent_types";
const MAX_KEEP = 10;
const MIN_OPTIONS = 3;

/** 纯函数：由"最近用过的类型"算出本次要禁掉的类型（便于单测，不依赖 Redis） */
function computeBannedTypes(recent, allTypes) {
  const all = Array.isArray(allTypes) ? allTypes.filter(Boolean) : [];
  if (!all.length) return [];
  const list = Array.isArray(recent) ? recent.filter((t) => all.includes(t)) : [];
  if (!list.length) return [];
  // 最近用过的排前面（去重保序）
  const ordered = [...new Set(list.slice().reverse())];
  const maxBan = Math.max(0, all.length - MIN_OPTIONS);
  return ordered.slice(0, maxBan);
}

function getRedisSafe() {
  try {
    // 延迟 require：避免在不需要生成的场景（如单测）拉起连接
    return require("../core/redis-client");
  } catch (e) {
    return null;
  }
}

async function getRecentTrickTypes() {
  const rc = getRedisSafe();
  if (!rc || typeof rc.getRedis !== "function") return [];
  try {
    const redis = await rc.getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.warn("[trick-types] 读取历史类型失败（忽略）:", e.message);
    return [];
  }
}

async function rememberTrickType(type) {
  if (!type) return;
  const rc = getRedisSafe();
  if (!rc || typeof rc.getRedis !== "function") return;
  try {
    const redis = await rc.getRedis();
    const recent = await getRecentTrickTypes();
    const next = [...recent, String(type)].slice(-MAX_KEEP);
    await redis.set(KEY, JSON.stringify(next));
  } catch (e) {
    console.warn("[trick-types] 记录类型失败（忽略）:", e.message);
  }
}

module.exports = { computeBannedTypes, getRecentTrickTypes, rememberTrickType, KEY };
