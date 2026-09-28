/**
 * 房间管理模块
 * 职责：
 *   - 创建房间：生成 4-6 位纯数字房间号（去重），接收房主配置（底分/封顶/开牌轮数）
 *   - 加入房间 / 离开房间
 *   - 房间列表查询
 *   - 断线处理（标记离线并广播，牌局中轮到断线玩家自动弃牌）
 *   - 牌局消息路由（startGame / bet）
 *
 * 消息协议（JSON，{type, data}）：
 *   客户端 -> 服务端：
 *     createRoom(nickname, config) / joinRoom(nickname, roomId)
 *     leaveRoom / getRooms / startGame / bet(action, amount)
 *   服务端 -> 客户端：
 *     roomCreated(roomId, playerId, players, config) / roomJoined(...)
 *     playerJoined(player, players) / playerLeft(player, players, reason)
 *     roomList(rooms) / error(message)
 *     gameConfig(config) / gameStart / turn / bet / fold / open / roundResult
 */
const { Game, PHASE } = require('./game');

// 单房间人数上限（宜宾玩法：3-8 人）
const MAX_PLAYERS_PER_ROOM = 8;
// 房间号位数范围
const ROOM_ID_MIN_LEN = 4;
const ROOM_ID_MAX_LEN = 6;

class Room {
  constructor(id, ownerId, ownerNickname, config) {
    this.id = id;
    this.ownerId = ownerId;
    this.createdAt = Date.now();
    /** playerId -> { id, nickname, ws, online } */
    this.players = new Map();
    // 创建房间的人默认即为第一位玩家
    this.players.set(ownerId, {
      id: ownerId,
      nickname: ownerNickname,
      ws: null, // ws 由 RoomManager 登记，避免循环引用
      online: true,
    });
    /** 上一局赢家（用于确定下一局头家 = 赢家的下一家） */
    this.lastWinnerId = null;
    /** 牌局状态机（宜宾玩法完整实现） */
    this.game = new Game(this, config);
    this.game.ensureScore(ownerId);
  }

  /** 给房间内单个玩家发消息 */
  sendToPlayer(playerId, type, data) {
    const player = this.players.get(playerId);
    if (player && player.ws && player.ws.readyState === player.ws.OPEN) {
      player.ws.send(JSON.stringify({ type, data }));
    }
  }

  /** 给房间内所有玩家广播（可排除某连接） */
  broadcast(type, data, exceptWs) {
    for (const player of this.players.values()) {
      if (player.ws && player.ws !== exceptWs && player.ws.readyState === player.ws.OPEN) {
        player.ws.send(JSON.stringify({ type, data }));
      }
    }
  }

  /** 房间公开信息（含配置与牌局状态） */
  toPublic() {
    const gameState = this.game.toPublic();
    return {
      roomId: this.id,
      playerCount: this.players.size,
      config: this.game.config,
      phase: gameState.phase,
      round: gameState.round,
      headPlayerId: gameState.headPlayerId,
      players: [...this.players.values()].map((p) => {
        const s = this.game.getPlayerState(p.id);
        return {
          id: p.id,
          nickname: p.nickname,
          online: p.online,
          score: s.score,
          folded: s.folded,
          looked: s.looked,
          bet: s.bet,
        };
      }),
    };
  }
}

class RoomManager {
  constructor() {
    /** roomId -> Room */
    this.rooms = new Map();
    /** ws -> { playerId, roomId } */
    this.clientMap = new Map();
    // 自增玩家 id（简单方案，后续可换成 uuid）
    this._playerSeq = 0;
  }

  // ============================================================
  // 连接生命周期
  // ============================================================
  handleConnection(ws) {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw) => this.handleMessage(ws, raw));
    ws.on('close', () => this.handleDisconnect(ws));
    ws.on('error', () => { /* 连接错误由 close 兜底清理 */ });
  }

  handleMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch (e) {
      this.send(ws, 'error', { message: '消息格式错误，请使用 JSON' });
      return;
    }

    const type = msg && msg.type;
    const data = msg && msg.data ? msg.data : {};

    switch (type) {
      case 'createRoom':
        this.createRoom(ws, data.nickname, data.config);
        break;
      case 'joinRoom':
        this.joinRoom(ws, data.nickname, data.roomId);
        break;
      case 'leaveRoom':
        this.leaveRoom(ws);
        break;
      case 'getRooms':
        this.sendRoomList(ws);
        break;
      case 'startGame':
        this.startGame(ws);
        break;
      case 'bet':
        this.handleBet(ws, data);
        break;
      default:
        this.send(ws, 'error', { message: `未知消息类型: ${type}` });
    }
  }

  handleDisconnect(ws) {
    const entry = this.clientMap.get(ws);
    if (!entry) return;
    const { playerId, roomId } = entry;
    const room = this.rooms.get(roomId);
    if (room && room.players.has(playerId)) {
      const player = room.players.get(playerId);
      player.online = false;
      this.broadcast(room, 'playerLeft', {
        player: { id: playerId, nickname: player.nickname },
        players: room.toPublic().players,
        reason: 'disconnect',
      });
      // 牌局中轮到断线玩家则自动弃牌
      room.game.onPlayerDisconnect(playerId);
    }
    this.clientMap.delete(ws);
    // 断线后保留房间与玩家信息，方便重连恢复（TODO：后续实现按房间号重连）
  }

  // ============================================================
  // 房间操作
  // ============================================================
  createRoom(ws, nickname, config) {
    const safeNick = this._sanitizeNickname(nickname);
    if (!safeNick) {
      this.send(ws, 'error', { message: '昵称不能为空' });
      return;
    }
    // 一个人不能同时占多个房间，先清理旧席位
    this._cleanupClient(ws);

    const roomId = this._generateRoomId();
    const playerId = this._nextPlayerId();
    const room = new Room(roomId, playerId, safeNick, config);
    room.players.get(playerId).ws = ws;
    this.rooms.set(roomId, room);
    this.clientMap.set(ws, { playerId, roomId });

    this.send(ws, 'roomCreated', room.toPublic());
  }

  joinRoom(ws, nickname, roomId) {
    const safeNick = this._sanitizeNickname(nickname);
    if (!safeNick) {
      this.send(ws, 'error', { message: '昵称不能为空' });
      return;
    }
    const room = this.rooms.get(String(roomId).trim());
    if (!room) {
      this.send(ws, 'error', { message: `房间 ${roomId} 不存在，请检查房间号` });
      return;
    }
    if (room.game.phase !== PHASE.IDLE) {
      this.send(ws, 'error', { message: '牌局进行中，暂不能加入，请等本局结束' });
      return;
    }
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
      this.send(ws, 'error', { message: `房间已满（最多 ${MAX_PLAYERS_PER_ROOM} 人）` });
      return;
    }
    // 一人不能同时占两个房间
    this._cleanupClient(ws);

    const playerId = this._nextPlayerId();
    room.players.set(playerId, {
      id: playerId,
      nickname: safeNick,
      ws,
      online: true,
    });
    room.game.ensureScore(playerId);
    this.clientMap.set(ws, { playerId, roomId: room.id });

    // 先通知新玩家进房成功（含当前玩家列表、配置、牌局状态）
    this.send(ws, 'roomJoined', room.toPublic());
    // 再广播给房间内其他人
    this.broadcast(room, 'playerJoined', {
      player: { id: playerId, nickname: safeNick },
      players: room.toPublic().players,
    }, ws);
  }

  leaveRoom(ws) {
    const entry = this.clientMap.get(ws);
    if (!entry) return;
    const { playerId, roomId } = entry;
    const room = this.rooms.get(roomId);
    if (room) {
      room.players.delete(playerId);
      const remains = room.toPublic().players;
      this.broadcast(room, 'playerLeft', {
        player: { id: playerId },
        players: remains,
        reason: 'leave',
      });
      // 房间空了则销毁
      if (room.players.size === 0) {
        this.rooms.delete(roomId);
      } else if (room.ownerId === playerId) {
        // 房主离开则顺位转让房主（简单取第一位）
        room.ownerId = [...room.players.keys()][0];
      }
    }
    this.clientMap.delete(ws);
  }

  sendRoomList(ws) {
    const rooms = [...this.rooms.values()]
      .filter((r) => r.players.size < MAX_PLAYERS_PER_ROOM)
      .map((r) => r.toPublic());
    this.send(ws, 'roomList', { rooms });
  }

  // ============================================================
  // 牌局消息路由
  // ============================================================

  /** 开始游戏：仅房主可发起 */
  startGame(ws) {
    const entry = this.clientMap.get(ws);
    if (!entry) return;
    const { playerId, roomId } = entry;
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (playerId !== room.ownerId) {
      this.send(ws, 'error', { message: '只有房主可以开始游戏' });
      return;
    }
    const result = room.game.startRound();
    if (!result.ok) {
      this.send(ws, 'error', { message: result.message });
    }
  }

  /** 玩家牌局操作：bet(action, amount) */
  handleBet(ws, data) {
    const entry = this.clientMap.get(ws);
    if (!entry) return;
    const { playerId, roomId } = entry;
    const room = this.rooms.get(roomId);
    if (!room) return;
    const action = String(data.action || '');
    const amount = Number(data.amount);
    const result = room.game.handleAction(playerId, action, amount);
    if (!result.ok) {
      this.send(ws, 'error', { message: result.message });
    }
  }

  // ============================================================
  // 工具方法
  // ============================================================
  _cleanupClient(ws) {
    // 如果该连接已在某个房间，先按离开处理
    if (this.clientMap.has(ws)) {
      this.leaveRoom(ws);
    }
  }

  _nextPlayerId() {
    this._playerSeq += 1;
    return `p${this._playerSeq}`;
  }

  _sanitizeNickname(nickname) {
    if (typeof nickname !== 'string') return '';
    const trimmed = nickname.trim().slice(0, 12);
    return trimmed;
  }

  _generateRoomId() {
    // 生成 4-6 位纯数字房间号
    for (let i = 0; i < 100; i++) {
      const len = ROOM_ID_MIN_LEN +
        Math.floor(Math.random() * (ROOM_ID_MAX_LEN - ROOM_ID_MIN_LEN + 1));
      let id = '';
      for (let j = 0; j < len; j++) {
        // 首位不为 0
        const digit = j === 0
          ? Math.floor(Math.random() * 9) + 1
          : Math.floor(Math.random() * 10);
        id += String(digit);
      }
      if (!this.rooms.has(id)) return id;
    }
    // 极端碰撞场景：追加时间戳尾号保证唯一
    return String(Date.now()).slice(-6);
  }

  send(ws, type, data) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type, data }));
    }
  }

  broadcast(room, type, data, exceptWs) {
    for (const player of room.players.values()) {
      if (player.ws && player.ws !== exceptWs && player.ws.readyState === player.ws.OPEN) {
        player.ws.send(JSON.stringify({ type, data }));
      }
    }
  }
}

module.exports = { RoomManager, Room, MAX_PLAYERS_PER_ROOM };
