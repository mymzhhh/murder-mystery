// 端口转发代理 — 将 localhost:3000 转发到 Docker 容器内部 IP
// 解决 Docker Desktop Windows 端口映射不生效的问题

const net = require("net");
const http = require("http");

const PROXY_PORT = 3000;
const TARGET_HOST = "172.22.0.2"; // 容器内部 IP
const TARGET_PORT = 3000;

const server = net.createServer((clientSocket) => {
  const targetSocket = net.createConnection(TARGET_PORT, TARGET_HOST);

  targetSocket.on("connect", () => {
    clientSocket.pipe(targetSocket);
    targetSocket.pipe(clientSocket);
  });

  targetSocket.on("error", (err) => {
    console.error("容器连接失败：", err.message);
    clientSocket.end();
  });

  clientSocket.on("error", (err) => {
    targetSocket.end();
  });
});

server.listen(PROXY_PORT, "127.0.0.1", () => {
  console.log(`端口转发已启动: http://localhost:${PROXY_PORT} → ${TARGET_HOST}:${TARGET_PORT}`);
  console.log("按 Ctrl+C 停止");
});
