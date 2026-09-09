// Socket.io 单例（玩家端房间实时）
import { io } from "socket.io-client";

let socket = null;

export function getSocket() {
  if (!socket) {
    socket = io("/", {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });
  }
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

/** 订阅 socket 事件（自动清理的便捷函数，供组件 useEffect 使用）
 *  @returns cleanup 函数
 */
export function onSocket(event, handler) {
  const s = getSocket();
  s.on(event, handler);
  return () => s.off(event, handler);
}