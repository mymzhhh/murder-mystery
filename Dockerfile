FROM node:20-alpine AS web-build

WORKDIR /build

# 前端依赖 + 构建（Vite + React）
COPY package.json package-lock.json ./
RUN npm install --ignore-scripts --no-audit --no-fund
COPY frontend/ ./frontend/
RUN cd frontend && npx vite build

# ===== 运行时 =====
FROM node:20-alpine

# 安全: 非 root 运行
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup

WORKDIR /app

# 生产环境（Express 在 NODE_ENV=production 下关闭调试栈与详细错误）
ENV NODE_ENV=production

# 分层缓存：先装依赖
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# 复制源码
COPY server.js ./
COPY modules/ ./modules/
COPY templates/ ./templates/
COPY routes/ ./routes/
COPY socket/ ./socket/
COPY public/ ./public/
# 运维/数据脚本（如模型注册），随镜像分发以便在容器内直接执行
COPY scripts/ ./scripts/

# React 构建产物（来自 web-build 阶段）
COPY --from=web-build /build/frontend/dist ./frontend/dist

# 运行时目录
RUN mkdir -p /app/data/sessions && chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

# healthcheck 使用 Node.js 内置 http（Alpine 无 wget/curl）
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health',r=>{process.exit(r.statusCode===200?0:1)})"

CMD ["node", "server.js"]