/**
 * 大厅 / 房间 UI 渲染与事件绑定
 * 职责：
 *   - 页面切换（大厅 <-> 房间）
 *   - 大厅：创建房间（含底分/封顶/开牌轮数配置）/ 加入房间 / 房间列表
 *   - 房间：玩家列表、退出房间、开始游戏、下注操作
 *   - 统一处理服务端推送（roomCreated / roomJoined / playerJoined / playerLeft /
 *     error / roomList / gameConfig / gameStart / turn / bet / fold / open / roundResult）
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ============================================================
  // 页面切换
  // ============================================================
  function showLobby() {
    $('view-lobby').classList.remove('hidden');
    $('view-room').classList.add('hidden');
    GameUI.room = null;
    GameUI.myPlayerId = null;
    GameUI.players = [];
    GameUI.phase = 'IDLE';
  }

  function showRoom() {
    $('view-lobby').classList.add('hidden');
    $('view-room').classList.remove('hidden');
  }

  // ============================================================
  // 轻提示
  // ============================================================
  let toastTimer = null;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2500);
  }

  // ============================================================
  // 大厅渲染
  // ============================================================
  function renderRoomList(rooms) {
    const box = $('roomList');
    if (!rooms || rooms.length === 0) {
      box.innerHTML = '<p class="empty-tip">暂无空闲房间，去创建一间吧</p>';
      return;
    }
    box.innerHTML = rooms.map((r) => {
      const cfg = r.config || {};
      return `
      <div class="room-item">
        <div>
          <div class="room-no">房间 ${r.roomId}</div>
          <div style="font-size:12px;color:var(--text-dim)">
            ${r.playerCount} / 8 人 · 底分 ${cfg.baseScore} · 封顶 ${cfg.maxLoss} · ${cfg.openAfterRounds} 轮开牌
          </div>
        </div>
        <button class="join-btn" data-join="${r.roomId}">加入</button>
      </div>`;
    }).join('');

    // 绑定列表内加入按钮
    box.querySelectorAll('[data-join]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nickname = getNickname();
        if (!nickname) return;
        net.send('joinRoom', { nickname, roomId: btn.dataset.join });
      });
    });
  }

  function getNickname() {
    const nickname = $('nicknameInput').value.trim();
    if (!nickname) {
      toast('请先输入昵称');
      return '';
    }
    return nickname;
  }

  /** 读取创建房间配置（合法数字；非法回落默认值） */
  function readRoomConfig() {
    const clamp = (v, d, min, max) => {
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n)) return d;
      return Math.min(max, Math.max(min, n));
    };
    const baseScore = clamp($('baseScoreInput').value, 10, 1, 10000);
    const maxLoss = clamp($('maxLossInput').value, 1000, baseScore * 2, 1000000);
    const openAfterRounds = clamp($('openRoundsInput').value, 5, 1, 20);
    return { baseScore, maxLoss, openAfterRounds };
  }

  // ============================================================
  // 房间渲染
  // ============================================================
  function enterRoom(data) {
    // data: roomCreated / roomJoined 的完整房间信息（含 playerId / config / phase / players）
    GameUI.enterRoom(data);
    $('roomIdLabel').textContent = data.roomId;
    const cfg = data.config || {};
    const pCount = data.players ? data.players.length : 0;
    $('roomTip').textContent = `房主配置：底分 ${cfg.baseScore} · 单局封顶 ${cfg.maxLoss} · 第 ${cfg.openAfterRounds} 轮强制开牌。凑够 3-8 人即可开局（纯娱乐虚拟积分）`;
    GameUI.renderPlayers(data.players);
    GameUI.renderTable();
    GameUI.renderHand();
    GameUI.renderActions();
    showRoom();
    GameUI.log(`你已进入房间 ${data.roomId}（当前 ${pCount} 人）`);
  }

  // ============================================================
  // 事件绑定（大厅）
  // ============================================================
  function bindLobbyEvents() {
    $('btnCreateRoom').addEventListener('click', () => {
      const nickname = getNickname();
      if (!nickname) return;
      net.send('createRoom', { nickname, config: readRoomConfig() });
    });

    $('btnJoinRoom').addEventListener('click', () => {
      const nickname = getNickname();
      if (!nickname) return;
      const roomId = $('roomIdInput').value.trim();
      if (!/^\d{4,6}$/.test(roomId)) {
        toast('请输入 4-6 位数字房间号');
        return;
      }
      net.send('joinRoom', { nickname, roomId });
    });

    $('btnRefreshRooms').addEventListener('click', () => {
      net.send('getRooms', {});
      toast('已刷新房间列表');
    });
  }

  // ============================================================
  // 服务器设置弹窗
  // ============================================================
  function bindServerSettingEvents() {
    const modal = $('serverModal');

    $('btnServerSetting').addEventListener('click', () => {
      // 默认值取已保存的地址
      $('serverUrlInput').value = net.getConfiguredServerUrl();
      modal.classList.remove('hidden');
    });

    $('btnServerCancel').addEventListener('click', () => {
      modal.classList.add('hidden');
    });

    $('btnServerSave').addEventListener('click', saveServerUrl);

    // 点击遮罩空白处关闭
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  }

  function saveServerUrl() {
    const url = $('serverUrlInput').value.trim();
    if (url && !/^https?:\/\//i.test(url)) {
      toast('地址需以 http:// 或 https:// 开头');
      return;
    }
    // 保存到 localStorage（net 内部实现）
    net.setServerUrl(url);
    $('serverModal').classList.add('hidden');
    if (net.isConnected()) {
      toast('已保存，当前连接保持，重连时生效');
    } else {
      net.reconnect();
      toast('已保存，正在重新连接...');
    }
  }

  // ============================================================
  // 事件绑定（房间）
  // ============================================================
  function bindRoomEvents() {
    $('btnLeaveRoom').addEventListener('click', () => {
      net.send('leaveRoom', {});
      GameUI.log('已退出房间');
      showLobby();
    });

    // 开始游戏（房主发起）
    $('btnStartRound').addEventListener('click', () => {
      const count = GameUI.players.length;
      if (count < 3) {
        toast(`人数不足，还需 ${3 - count} 人才能开局（当前 ${count} 人）`);
        return;
      }
      net.send('startGame', {});
    });

    // 下注操作
    $('btnLook').addEventListener('click', () => GameUI.sendLook());
    $('btnBlind').addEventListener('click', () => GameUI.sendBlind());
    $('btnCall').addEventListener('click', () => GameUI.sendCall());
    $('btnRaise').addEventListener('click', () => GameUI.sendRaise());
    $('btnFold').addEventListener('click', () => GameUI.sendFold());
    $('btnOpen').addEventListener('click', () => GameUI.sendOpen());
  }

  // ============================================================
  // 连接状态展示
  // ============================================================
  function bindNetStatus() {
    net.onStatusChange = (status) => {
      const el = $('connStatus');
      el.classList.remove('online', 'offline');
      if (status === 'online') {
        el.textContent = '已连接';
        el.classList.add('online');
      } else if (status === 'connecting') {
        el.textContent = '连接中...';
      } else {
        el.textContent = '已断开';
        el.classList.add('offline');
      }
    };
  }

  // ============================================================
  // 服务端消息分发
  // ============================================================
  function bindServerEvents() {
    net.on('roomCreated', (data) => {
      enterRoom(data);
    });

    net.on('roomJoined', (data) => {
      enterRoom(data);
    });

    net.on('playerJoined', (data) => {
      if (GameUI.room && data.players) {
        GameUI.renderPlayers(data.players);
      }
      if (data.player) {
        GameUI.log(`${data.player.nickname} 加入了房间`);
        toast(`${data.player.nickname} 加入了房间`);
      }
    });

    net.on('playerLeft', (data) => {
      if (GameUI.room && data.players) {
        GameUI.renderPlayers(data.players);
      }
      const name = data.player ? data.player.nickname : '一名玩家';
      GameUI.log(`${name} 离开了房间（${data.reason === 'disconnect' ? '断线' : '主动退出'}）`);
    });

    net.on('error', (data) => {
      toast(data.message || '操作失败');
      GameUI.log(`错误：${data.message || '未知错误'}`);
    });

    net.on('roomList', (data) => {
      renderRoomList(data.rooms);
    });

    // 牌局消息
    net.on('gameConfig', (data) => GameUI.onGameConfig(data));
    net.on('gameStart', (data) => GameUI.onGameStart(data));
    net.on('turn', (data) => GameUI.onTurn(data));
    net.on('bet', (data) => GameUI.onBet(data));
    net.on('fold', (data) => GameUI.onFold(data));
    net.on('open', (data) => GameUI.onOpen(data));
    net.on('roundResult', (data) => GameUI.onRoundResult(data));

    // 系统提示（断线重连等）
    net.on('system', (data) => {
      if (data.message) toast(data.message);
    });
  }

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    bindLobbyEvents();
    bindServerSettingEvents();
    bindRoomEvents();
    bindNetStatus();
    bindServerEvents();
    net.connect();
    // 进入页面先拉一次房间列表
    setTimeout(() => net.send('getRooms', {}), 300);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
