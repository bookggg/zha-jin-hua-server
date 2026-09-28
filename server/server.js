/**
 * 在线联机娱乐炸金花 - 服务器入口
 * 职责：
 *   1. HTTP 静态服务：托管 app/ 目录下的前端 H5 页面
 *   2. WebSocket 房间服务器：房间创建 / 加入 / 离开 / 列表 / 断线处理
 * 依赖：仅 ws（原生 http 模块做静态服务，不引入复杂框架）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { RoomManager } = require('./room');

// 优先使用云平台注入的 PORT 环境变量（Zeabur/Render 等），本地默认 3000
const PORT = process.env.PORT || 3000;
const APP_DIR = path.join(__dirname, '..', 'app');

// 房间管理器（单例）
const roomManager = new RoomManager();

// ============================================================
// HTTP 静态服务
// ============================================================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

const server = http.createServer((req, res) => {
  // 只支持 GET，其余方法直接拒绝
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  // 根路径映射到 index.html
  let filePath = path.normalize(path.join(APP_DIR, urlPath === '/' ? 'index.html' : urlPath));

  // 路径穿越防护：最终路径必须位于 APP_DIR 内
  if (!filePath.startsWith(APP_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ============================================================
// WebSocket 房间服务器
// ============================================================
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  // 交由房间管理器统一处理：注册连接、消息路由、断线清理
  roomManager.handleConnection(ws);
});

server.listen(PORT, () => {
  console.log('==============================================');
  console.log('  在线联机娱乐炸金花 - 服务器已启动');
  console.log(`  本机访问: http://localhost:${PORT}`);
  console.log('  （纯娱乐虚拟积分，无现金交易）');
  console.log('==============================================');
});
