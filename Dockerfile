# 宜宾炸金花 在线联机服务器 部署配置
# 适用于 Render / Railway / Koyeb / Zeabur 等 Node.js 免费云平台
FROM node:20-slim

WORKDIR /app

# 仅复制后端与前端静态资源
COPY server/package.json ./server/package.json
COPY server/server.js ./server/server.js
COPY server/room.js ./server/room.js
COPY server/game.js ./server/game.js
COPY app/ ./app/

WORKDIR /app/server
RUN npm install --omit=dev

EXPOSE 3000

CMD ["node", "server.js"]
