FROM node:20-alpine

# 安全: 非 root 运行
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup

WORKDIR /app

# 安装 PM2 用于生产进程管理（多核利用）
RUN npm install -g pm2 && pm2 install pm2-logrotate

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

# PM2 配置: 根据 CPU 核数自动扩进程
RUN echo '{ "apps": [{ "name": "murder-mystery", "script": "server.js", "instances": "max", "exec_mode": "cluster", "max_memory_restart": "500M", "env": { "NODE_ENV": "production" } }] }' > /app/ecosystem.config.json

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["pm2-runtime", "ecosystem.config.json"]
