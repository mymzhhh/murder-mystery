FROM node:20-alpine

# 安全: 非 root 运行
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup

WORKDIR /app

# 分层缓存：先装依赖
COPY package.json package-lock.json ./
RUN npm ci --production --ignore-scripts && npm cache clean --force

# 复制源码
COPY server.js ./
COPY modules/ ./modules/
COPY templates/ ./templates/
COPY routes/ ./routes/
COPY socket/ ./socket/
COPY public/ ./public/

# 运行时目录
RUN mkdir -p /app/data/sessions && chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

# healthcheck 使用 Node.js 内置 http（Alpine 无 wget/curl）
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health',r=>{process.exit(r.statusCode===200?0:1)})"

CMD ["node", "server.js"]
