/**
 * 牌局交互逻辑（宜宾玩法完整实现）
 * 职责：
 *   - 渲染玩家列表（昵称 / 积分 / 在线 / 弃牌 / 看牌状态）
 *   - 渲染手牌：闷牌显示牌背，看牌后显示正面
 *   - 下注操作：看牌 / 闷牌 / 跟注 / 加注 / 弃牌 / 开牌
 *   - 头家第一轮强制闷牌提示
 *   - 开牌结果与结算明细展示
 *   - 积分变化展示
 *
 * 协议消息（服务端 -> 客户端）：
 *   gameConfig / gameStart / turn / bet / fold / open / roundResult
 */
const GameUI = {
  /** 当前玩家自己的 playerId（进房后由 ui.js 写入） */
  myPlayerId: null,
  /** 当前房间信息 */
  room: null,
  /** 房间配置 */
  config: null,
  /** 当前阶段 IDLE / BETTING / SHOWDOWN / SETTLEMENT */
  phase: 'IDLE',
  /** 当前局数 */
  round: 0,
  /** 自己手牌（3 张，闷牌时为空） */
  myHand: [],
  /** 自己是否已看牌 */
  myLooked: false,
  /** 自己是否已弃牌 */
  myFolded: false,
  /** 玩家列表（含积分/状态） */
  players: [],
  /** 当前行动玩家 id */
  currentPlayerId: null,
  /** 当前行动者是否必须闷牌（头家第一轮） */
  mustBlind: false,
  /** 底池 */
  pot: 0,
  /** 当前跟注额 */
  currentBet: 0,
  /** 头家 id */
  headPlayerId: null,

  // ============================================================
  // 状态重置与进入
  // ============================================================

  /** 进入房间时初始化（由 ui.js 在 roomCreated/roomJoined 时调用） */
  enterRoom(data) {
    this.myPlayerId = data.playerId;
    this.room = { roomId: data.roomId };
    this.config = data.config || null;
    this.phase = data.phase || 'IDLE';
    this.round = data.round || 0;
    this.headPlayerId = data.headPlayerId || null;
    this.players = data.players || [];
    this.myHand = [];
    this.myLooked = false;
    this.myFolded = false;
    this.currentPlayerId = null;
    this.mustBlind = false;
    this.pot = 0;
    this.currentBet = this.config ? this.config.baseScore : 0;
    this.lastResult = null;
  },

  /** 新一局开始时重置牌局状态（保留玩家积分） */
  resetGame(gameStartData) {
    this.phase = 'BETTING';
    this.round = gameStartData.round;
    this.headPlayerId = gameStartData.headPlayerId;
    this.config = gameStartData.config || this.config;
    this.myHand = gameStartData.myHand || [];
    this.myLooked = false;
    this.myFolded = false;
    this.players = gameStartData.players || [];
    this.currentPlayerId = gameStartData.currentPlayerId || null;
    this.mustBlind = !!gameStartData.mustBlind;
    this.pot = 0;
    this.currentBet = this.config ? this.config.baseScore : 0;
    this.lastResult = null;
    this._hideResultPanel();
  },

  // ============================================================
  // 渲染：玩家列表
  // ============================================================
  renderPlayers(players) {
    if (players) this.players = players;
    const container = document.getElementById('playerList');
    if (!container) return;
    const list = this.players;
    if (!list || list.length === 0) {
      container.innerHTML = '<p class="empty-tip">暂无玩家</p>';
      return;
    }
    container.innerHTML = list.map((p) => {
      const isMe = p.id === this.myPlayerId;
      const offline = p.online === false;
      const isTurn = p.id === this.currentPlayerId && this.phase === 'BETTING' && !p.folded;
      const chips = [];
      if (p.folded) chips.push('<span class="tag tag-fold">弃牌</span>');
      if (p.looked) chips.push('<span class="tag tag-look">看牌</span>');
      if (isTurn) chips.push('<span class="tag tag-turn">行动中</span>');
      return `
        <div class="player-chip ${isMe ? 'me' : ''} ${offline ? 'offline' : ''} ${isTurn ? 'turn' : ''}">
          <div class="nick">${this._esc(p.nickname)}${isMe ? '（我）' : ''}</div>
          <div class="score">${this._fmtNum(p.score)} 分</div>
          <div class="state">${chips.join('') || (offline ? '<span class="tag tag-off">离线</span>' : '<span class="tag tag-on">在线</span>')}</div>
        </div>`;
    }).join('');
  },

  // ============================================================
  // 渲染：手牌
  // ============================================================
  renderHand() {
    const area = document.getElementById('handArea');
    if (!area) return;

    // 非下注阶段（或已看牌）显示手牌正面；闷牌中显示牌背
    const showFace = this.myLooked || this.phase === 'SHOWDOWN' || this.phase === 'SETTLEMENT';
    let html = '';
    if (this.phase === 'IDLE') {
      html = '<p class="empty-tip">牌局未开始</p>';
    } else if (this.myFolded) {
      html = '<p class="empty-tip">你已弃牌，等待本局结束...</p>';
    } else if (!this.myHand || this.myHand.length === 0) {
      html = '<p class="empty-tip">等待发牌...</p>';
    } else if (showFace) {
      html = this.myHand.map((c) => this._cardHtml(c, true)).join('');
      html += `<p class="hand-hint">你的手牌：${this._handTypeHint(this.myHand)}</p>`;
    } else {
      html = this.myHand.map(() => this._cardHtml(null, false)).join('');
      html += '<p class="hand-hint">闷牌中：不看牌，下注只需看注一半。可点击「看牌」亮出底牌</p>';
    }
    area.innerHTML = html;
  },

  /** 简易本地牌型提示（仅展示用，最终以服务端判定为准） */
  _handTypeHint(cards) {
    if (!cards || cards.length !== 3) return '';
    const ranks = cards.map((c) => c.rank).sort((a, b) => a - b);
    const suits = cards.map((c) => c.suit);
    const flush = suits[0] === suits[1] && suits[1] === suits[2];
    const uniq = [...new Set(ranks)];
    let straight = false;
    if (uniq.length === 3) {
      straight = (ranks[1] === ranks[0] + 1 && ranks[2] === ranks[1] + 1) ||
        (ranks[0] === 2 && ranks[1] === 3 && ranks[2] === 14);
    }
    const counts = {};
    for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
    const values = Object.values(counts);
    if (ranks.join(',') === '2,3,5' && !flush && !straight) return '杂牌 235（可吃豹子）';
    if (values.includes(3)) return '豹子';
    if (flush && straight) return '同花顺';
    if (flush) return '金花';
    if (straight) return '顺子';
    if (values.includes(2)) return '对子';
    return '单张';
  },

  // ============================================================
  // 渲染：牌桌信息（底池 / 注额 / 阶段 / 头家）
  // ============================================================
  renderTable() {
    const phaseMap = {
      IDLE: '阶段：空闲',
      BETTING: '阶段：下注中',
      SHOWDOWN: '阶段：开牌中',
      SETTLEMENT: '阶段：结算中',
    };
    const label = document.getElementById('phaseLabel');
    const roundLabel = document.getElementById('roundLabel');
    const potLabel = document.getElementById('potLabel');
    const betLabel = document.getElementById('betLabel');
    const turnTip = document.getElementById('turnTip');

    if (label) label.textContent = phaseMap[this.phase] || `阶段：${this.phase}`;
    if (roundLabel) roundLabel.textContent = `第 ${this.round || 0} 局`;
    if (potLabel) potLabel.textContent = `底池：${this._fmtNum(this.pot)}`;
    if (betLabel) betLabel.textContent = `当前跟注：${this._fmtNum(this.currentBet)}`;

    if (turnTip) {
      if (this.phase === 'BETTING') {
        if (this.currentPlayerId === this.myPlayerId && !this.myFolded) {
          if (this.mustBlind) {
            turnTip.textContent = '你是头家，第一轮必须闷一次（不可弃牌）';
            turnTip.classList.add('must');
          } else {
            turnTip.textContent = '轮到你操作了';
            turnTip.classList.remove('must');
          }
        } else {
          const cur = this.players.find((p) => p.id === this.currentPlayerId);
          turnTip.textContent = cur ? `等待 ${cur.nickname} 操作...` : '等待玩家操作...';
          turnTip.classList.remove('must');
        }
      } else if (this.phase === 'IDLE') {
        turnTip.textContent = '等待房主开始游戏';
        turnTip.classList.remove('must');
      } else {
        turnTip.textContent = this.phase === 'SHOWDOWN' ? '开牌中...' : '本局结束';
        turnTip.classList.remove('must');
      }
    }
  },

  // ============================================================
  // 渲染：操作按钮
  // ============================================================
  renderActions() {
    const btnStart = document.getElementById('btnStartRound');
    const btnLook = document.getElementById('btnLook');
    const btnBlind = document.getElementById('btnBlind');
    const btnCall = document.getElementById('btnCall');
    const btnRaise = document.getElementById('btnRaise');
    const raiseBox = document.getElementById('raiseBox');
    const btnFold = document.getElementById('btnFold');
    const btnOpen = document.getElementById('btnOpen');

    const hideAll = () => {
      [btnStart, btnLook, btnBlind, btnCall, btnRaise, btnFold, btnOpen].forEach((b) => {
        if (b) b.classList.add('hidden');
      });
      if (raiseBox) raiseBox.classList.add('hidden');
    };
    hideAll();

    if (!this.room) return;

    // 空闲阶段：房主显示开始按钮
    if (this.phase === 'IDLE') {
      const isOwner = this.players.find((p) => p.id === this.myPlayerId);
      if (btnStart) {
        btnStart.classList.toggle('hidden', !isOwner);
        btnStart.textContent = '开始游戏';
      }
      return;
    }

    // 下注阶段：轮到自己且未弃牌
    if (this.phase === 'BETTING' && this.currentPlayerId === this.myPlayerId && !this.myFolded) {
      // 头家第一轮：只能闷牌
      if (this.mustBlind) {
        if (btnBlind) btnBlind.classList.remove('hidden');
        return;
      }
      if (!this.myLooked) {
        if (btnLook) btnLook.classList.remove('hidden');
        if (btnBlind) btnBlind.classList.remove('hidden'); // 继续闷（跟闷注）
      } else {
        if (btnCall) btnCall.classList.remove('hidden');
      }
      if (btnRaise) btnRaise.classList.remove('hidden');
      if (raiseBox) raiseBox.classList.remove('hidden');
      if (btnFold) btnFold.classList.remove('hidden');
      if (btnOpen) btnOpen.classList.remove('hidden');
    }
  },

  // ============================================================
  // 渲染：结算明细
  // ============================================================
  renderResult(result) {
    this.lastResult = result;
    this.phase = 'SETTLEMENT';
    const panel = document.getElementById('resultPanel');
    if (!panel) return;

    const winner = result.hands.find((h) => h.playerId === result.winnerId);
    const winnerName = winner ? winner.nickname : '（平局/无人）';
    const potWin = result.potWin || 0;
    const bonus = result.bonus || 0;

    const reasons = {
      fold: '其余玩家全部弃牌',
      showdown: '开牌比大小',
    };
    let title = `🎉 ${winnerName} 获胜！`;
    if (result.reason === 'fold') title = `🎉 ${winnerName} 赢下底池！`;

    let bonusHtml = '';
    if (bonus > 0) {
      bonusHtml = `<div class="result-bonus">💰 235 吃鸡额外奖励 +${this._fmtNum(bonus)}（${this._esc(result.bonusDesc || '')}）</div>`;
    }
    let capHtml = '';
    if (result.capped) {
      capHtml = `<div class="result-cap">⚠️ 已触发单局封顶，赢家实际获得 ${this._fmtNum(result.potWin)} 分</div>`;
    }

    const handsHtml = result.hands.map((h) => {
      const cards = h.cards.map((c) => this._cardHtml(c, true)).join('');
      const mark = h.folded ? '（弃牌）' : (h.is235 ? '（235）' : '');
      return `
        <div class="result-hand ${h.playerId === result.winnerId ? 'win' : ''} ${h.folded ? 'folded' : ''}">
          <div class="result-nick">${this._esc(h.nickname)}${h.playerId === this.myPlayerId ? '（我）' : ''} ${mark}</div>
          <div class="result-cards">${cards}</div>
          <div class="result-type">${this._esc(h.handTypeName)}${h.looked ? '' : '（闷）'} · 下注 ${this._fmtNum(h.bet)}</div>
        </div>`;
    }).join('');

    panel.innerHTML = `
      <div class="result-head">
        <div class="result-title">${title}</div>
        <div class="result-sub">${reasons[result.reason] || ''} · 底池 ${this._fmtNum(result.pot)} · 赢家得 ${this._fmtNum(potWin)} 分</div>
        ${bonusHtml}
        ${capHtml}
        <button class="btn btn-secondary btn-sm" id="btnCloseResult">关闭</button>
      </div>
      <div class="result-hands">${handsHtml}</div>
      <div class="result-scores">${this._renderScores(result.scores)}</div>
    `;
    panel.classList.remove('hidden');

    const closeBtn = document.getElementById('btnCloseResult');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this._hideResultPanel());
    }
  },

  /** 积分变化一览 */
  _renderScores(scores) {
    if (!scores) return '';
    const before = this._scoreBefore || {};
    const rows = Object.keys(scores).map((pid) => {
      const p = this.players.find((x) => x.id === pid);
      const name = p ? p.nickname : pid;
      const now = scores[pid];
      const diff = before[pid] != null ? now - before[pid] : null;
      const diffHtml = diff == null ? '' : (diff >= 0
        ? `<span class="diff up">+${this._fmtNum(diff)}</span>`
        : `<span class="diff down">${this._fmtNum(diff)}</span>`);
      return `<div class="score-row">${this._esc(name)}：${this._fmtNum(now)} 分 ${diffHtml}</div>`;
    }).join('');
    return `<div class="result-scores-title">积分一览</div>${rows}`;
  },

  _hideResultPanel() {
    const panel = document.getElementById('resultPanel');
    if (panel) panel.classList.add('hidden');
  },

  // ============================================================
  // 服务端消息处理（由 ui.js 分发调用）
  // ============================================================

  onGameConfig(data) {
    if (data.config) this.config = data.config;
    const betLabel = document.getElementById('betLabel');
    if (betLabel && this.config) betLabel.textContent = `当前跟注：${this._fmtNum(this.config.baseScore)}`;
  },

  onGameStart(data) {
    this.resetGame(data);
    this.renderPlayers();
    this.renderTable();
    this.renderHand();
    this.renderActions();
    const head = this.players.find((p) => p.id === data.headPlayerId);
    this.log(`第 ${data.round} 局开始！头家：${head ? head.nickname : ''}（头家第一轮必须闷一次）`);
  },

  onTurn(data) {
    this.currentPlayerId = data.currentPlayerId;
    this.round = data.round;
    this.mustBlind = !!data.mustBlind;
    this.renderPlayers();
    this.renderTable();
    this.renderActions();
    const cur = this.players.find((p) => p.id === data.currentPlayerId);
    if (data.currentPlayerId === this.myPlayerId) {
      this.log(data.mustBlind ? '轮到你：你是头家，第一轮必须闷一次' : '轮到你操作了');
    } else {
      this.log(`等待 ${cur ? cur.nickname : '玩家'} 操作（第 ${data.round} 轮）`);
    }
  },

  onBet(data) {
    this.pot = data.pot;
    this.currentBet = data.currentBet;
    this.round = data.round;
    this.players = data.players || this.players;
    this.mustBlind = !!data.mustBlind;
    // 下注消息里的 currentPlayerId：仅 look（不轮转）时更新为自己；
    // blind/call/raise 后以紧随的 turn 消息为准，避免按钮闪烁
    if (data.action === 'look') {
      this.currentPlayerId = data.currentPlayerId || this.currentPlayerId;
    }
    if (data.playerId === this.myPlayerId && data.action === 'look') {
      this.myLooked = true;
      this.myHand = this.myHand; // 手牌已在 gameStart 下发，无需重取
    }
    const p = this.players.find((x) => x.id === data.playerId);
    const name = p ? p.nickname : data.playerId;
    const actionText = {
      look: '看了牌',
      blind: `闷牌下注 ${data.amount}`,
      call: `跟注 ${data.amount}`,
      raise: `加注到 ${data.currentBet}（本次投入 ${data.amount}）`,
    };
    this.log(`${name} ${actionText[data.action] || data.action}，底池 ${this._fmtNum(data.pot)}`);
    this.renderPlayers();
    this.renderTable();
    this.renderHand();
    this.renderActions();
  },

  onFold(data) {
    this.players = data.players || this.players;
    if (data.playerId === this.myPlayerId) this.myFolded = true;
    this.log(`${data.reason === 'disconnect' ? '（离线）' : ''}${this._playerName(data.playerId)} 弃牌，剩余 ${data.remain} 人`);
    this.renderPlayers();
    this.renderTable();
    this.renderHand();
    this.renderActions();
  },

  onOpen(data) {
    this.phase = 'SHOWDOWN';
    this.players = data.players || this.players;
    const reason = data.reason === 'rounds' ? '达到开牌轮数，强制开牌' : `${this._playerName(data.playerId)} 选择开牌`;
    this.log(reason);
    this.renderPlayers();
    this.renderTable();
    this.renderHand();
    this.renderActions();
  },

  onRoundResult(data) {
    this.phase = 'SETTLEMENT';
    // 记录积分变化前基准
    const before = {};
    (data.hands || []).forEach((h) => {
      const old = this.players.find((x) => x.id === h.playerId);
      if (old) before[h.playerId] = old.score;
    });
    this._scoreBefore = before;
    this.players = data.hands.map((h) => {
      const s = data.scores || {};
      return {
        id: h.playerId,
        nickname: h.nickname,
        online: true,
        score: s[h.playerId] != null ? s[h.playerId] : 0,
        folded: h.folded,
        looked: h.looked,
        bet: h.bet,
      };
    });
    if (data.winnerId === this.myPlayerId) {
      this.log(`🎉 你赢了！获得 ${data.potWin + (data.bonus || 0)} 分`);
    } else {
      this.log(`本局结束，赢家：${this._playerName(data.winnerId)}`);
    }
    if (data.bonusDesc) this.log(data.bonusDesc);
    this.renderPlayers();
    this.renderTable();
    this.renderHand();
    this.renderActions();
    this.renderResult(data);
  },

  // ============================================================
  // 操作发送
  // ============================================================
  sendLook() {
    if (!net.send('bet', { action: 'look' })) return;
    // 本地即时反馈（等待服务端广播确认最终状态）
    this.myLooked = true;
    this.renderHand();
  },

  sendBlind() {
    net.send('bet', { action: 'blind' });
  },

  sendCall() {
    net.send('bet', { action: 'call' });
  },

  sendRaise() {
    const input = document.getElementById('raiseAmount');
    if (!input) return;
    const amount = parseInt(input.value, 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      this.log('请输入有效的加注金额（加注后跟注额需至少比当前高一个底分）');
      return;
    }
    net.send('bet', { action: 'raise', amount });
  },

  sendFold() {
    net.send('bet', { action: 'fold' });
  },

  sendOpen() {
    net.send('bet', { action: 'open' });
  },

  // ============================================================
  // 工具
  // ============================================================

  _playerName(playerId) {
    const p = this.players.find((x) => x.id === playerId);
    return p ? p.nickname : playerId;
  },

  _cardHtml(card, faceUp) {
    if (!faceUp || !card) {
      return '<div class="card face-down"><span class="rank">?</span><span class="suit">?</span></div>';
    }
    const red = card.suit === '♥' || card.suit === '♦';
    return `<div class="card ${red ? 'red' : ''}"><span class="rank">${this._rankText(card.rank)}</span><span class="suit">${card.suit}</span></div>`;
  },

  /** 追加一条游戏日志 */
  log(message) {
    const box = document.getElementById('gameLog');
    if (!box) return;
    const first = box.querySelector('.empty-tip');
    if (first) first.remove();
    const p = document.createElement('p');
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    p.textContent = `[${time}] ${message}`;
    box.appendChild(p);
    box.scrollTop = box.scrollHeight;
  },

  _rankText(rank) {
    const map = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
    return map[rank] || String(rank);
  },

  _fmtNum(n) {
    return Number(n || 0).toLocaleString('zh-CN');
  },

  _esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },
};
