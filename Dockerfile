FROM node:20-alpine

WORKDIR /app

# 复制依赖文件并安装
COPY package.json ./
RUN npm install --production

# 复制源代码
COPY server.js ./
COPY modules/ ./modules/
COPY templates/ ./templates/
COPY routes/ ./routes/
COPY socket/ ./socket/
COPY public/ ./public/
COPY data/ ./data/

# 确保数据目录存在
RUN mkdir -p /app/data/sessions

EXPOSE 3000

CMD ["node", "server.js"]
