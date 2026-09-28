/**
 * 炸金花牌局状态机（宜宾玩法完整实现）
 *
 * 玩法规则（严格按宜宾玩法）：
 *   1. 3-8 人可开局
 *   2. 头家为上一把赢家的下一家（首局随机指定）；头家第一轮必须闷一次（下闷注），
 *      且第一轮不可弃牌；之后可选择看牌
 *   3. 闷牌可一直闷到开牌；闷牌下注 = 看牌下注的一半（向上取整）
 *   4. 特殊牌型：235（杂牌）可吃豹子
 *   5. 235 吃鸡：235 玩家一直闷牌到最后，其他玩家都弃牌无人开他，则 235 吃鸡，
 *      除底池外额外按"同花顺分值 + 豹子分值"奖励
 *   6. 虚拟积分：底分创建房间时可配置
 *   7. 封顶：单局输赢封顶可配置
 *   8. 开牌轮数可配置（达到轮数后强制开牌）
 *   9. 中途可弃牌（头家第一轮除外）
 *
 * 阶段流转：IDLE -> BETTING -> SHOWDOWN -> SETTLEMENT -> IDLE
 *
 * 消息推送：
 *   gameStart(每人单独发自己的手牌) / turn(轮到谁) / bet(下注广播)
 *   fold(弃牌广播) / open(开牌广播) / roundResult(结算明细) / gameConfig(房间配置)
 */

const PHASE = {
  IDLE: 'IDLE',             // 空闲（等待开局）
  BETTING: 'BETTING',       // 下注
  SHOWDOWN: 'SHOWDOWN',     // 开牌
  SETTLEMENT: 'SETTLEMENT', // 结算
};

// 牌型等级（越大越强）
const HAND_RANK = {
  HIGH: 1,           // 单张
  PAIR: 2,           // 对子
  STRAIGHT: 3,       // 顺子
  FLUSH: 4,          // 金花（同花）
  STRAIGHT_FLUSH: 5, // 同花顺
  TRIPLET: 6,        // 豹子
};

const HAND_RANK_NAME = {
  1: '单张',
  2: '对子',
  3: '顺子',
  4: '金花',
  5: '同花顺',
  6: '豹子',
};

// 房间配置默认值
const DEFAULT_CONFIG = {
  baseScore: 10,            // 底分（虚拟积分）
  maxLoss: 1000,            // 单局输赢封顶（虚拟积分）
  openAfterRounds: 5,       // 开牌轮数（达到后强制开牌）
  blindRatio: 0.5,          // 闷注比例（闷牌下注 = 看牌下注 * 该比例，向上取整）
  initialScore: 1000,       // 每位玩家初始虚拟积分
  bonusStraightFlush: 50,   // 235 吃鸡奖励：同花顺分值
  bonusTriplet: 100,        // 235 吃鸡奖励：豹子分值
};

/** 校验并归一化房间配置（非法值回落默认） */
function normalizeConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG };
  if (raw && typeof raw === 'object') {
    const num = (v, d, min, max) => {
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n)) return d;
      return Math.min(max, Math.max(min, n));
    };
    cfg.baseScore = num(raw.baseScore, DEFAULT_CONFIG.baseScore, 1, 10000);
    cfg.maxLoss = num(raw.maxLoss, DEFAULT_CONFIG.maxLoss, cfg.baseScore * 2, 1000000);
    cfg.openAfterRounds = num(raw.openAfterRounds, DEFAULT_CONFIG.openAfterRounds, 1, 20);
    cfg.initialScore = num(raw.initialScore, DEFAULT_CONFIG.initialScore, 100, 1000000);
    cfg.bonusStraightFlush = num(raw.bonusStraightFlush, DEFAULT_CONFIG.bonusStraightFlush, 0, 100000);
    cfg.bonusTriplet = num(raw.bonusTriplet, DEFAULT_CONFIG.bonusTriplet, 0, 100000);
    const br = Number(raw.blindRatio);
    if (Number.isFinite(br) && br >= 0.1 && br <= 1) {
      cfg.blindRatio = Math.round(br * 100) / 100;
    }
  }
  return cfg;
}

// ============================================================
// 牌型评估（独立导出便于测试）
// ============================================================

/**
 * 评估一手牌（3 张）
 * @returns {{handType:number, compare:number[], is235:boolean, straightHigh:number|null}}
 */
function evaluateHand(cards) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => a - b); // 升序
  const suits = cards.map((c) => c.suit);
  const isFlush = suits[0] === suits[1] && suits[1] === suits[2];
  const uniq = [...new Set(ranks)];

  // 顺子判定（A-2-3 为最小顺子，高点按 3 计）
  let straightHigh = null;
  if (uniq.length === 3) {
    if (ranks[1] === ranks[0] + 1 && ranks[2] === ranks[1] + 1) {
      straightHigh = ranks[2];
    } else if (ranks[0] === 2 && ranks[1] === 3 && ranks[2] === 14) {
      straightHigh = 3; // A-2-3
    }
  }
  const isStraight = straightHigh !== null;

  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const entries = Object.entries(counts)
    .map(([r, c]) => ({ rank: Number(r), count: c }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  let handType;
  let compare = [];
  if (entries[0].count === 3) {
    handType = HAND_RANK.TRIPLET;
    compare = [entries[0].rank];
  } else if (isFlush && isStraight) {
    handType = HAND_RANK.STRAIGHT_FLUSH;
    compare = [straightHigh];
  } else if (isFlush) {
    handType = HAND_RANK.FLUSH;
    compare = ranks.slice().reverse();
  } else if (isStraight) {
    handType = HAND_RANK.STRAIGHT;
    compare = [straightHigh];
  } else if (entries[0].count === 2) {
    handType = HAND_RANK.PAIR;
    compare = [entries[0].rank, entries[1].rank];
  } else {
    handType = HAND_RANK.HIGH;
    compare = ranks.slice().reverse();
  }

  // 235 杂牌（不同花色，非顺子非金花）：2,3,5 各一张
  const is235 = handType === HAND_RANK.HIGH && uniq.length === 3 && ranks.join(',') === '2,3,5';

  return { handType, compare, is235, straightHigh };
}

/**
 * 比较两手牌
 * @returns {number} 正数 a 赢；负数 b 赢；0 平局
 */
function compareHands(a, b) {
  // 235 吃豹子（无论花色）
  if (a.is235 && b.handType === HAND_RANK.TRIPLET) return 1;
  if (b.is235 && a.handType === HAND_RANK.TRIPLET) return -1;
  if (a.handType !== b.handType) return a.handType - b.handType;
  const len = Math.max(a.compare.length, b.compare.length);
  for (let i = 0; i < len; i++) {
    const av = a.compare[i] || 0;
    const bv = b.compare[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0; // 完全相等 -> 平局
}

// ============================================================
// 牌局
// ============================================================

class Game {
  /**
   * @param {object} room 所属房间（room.js 的 Room 实例）
   * @param {object} rawConfig 创建房间时的配置
   */
  constructor(room, rawConfig) {
    this.room = room;
    this.config = normalizeConfig(rawConfig);

    this.phase = PHASE.IDLE;
    this.round = 0;
    /** 座位顺序（playerId 数组，开局时锁定） */
    this.seatOrder = [];
    /** 当前行动者索引 */
    this.actionIndex = 0;
    /** 本轮起始索引（用于判定一轮结束） */
    this.roundStartIndex = 0;
    /** 头家 playerId */
    this.headPlayerId = null;
    /** 头家第一轮必闷是否已完成 */
    this.headFirstActionDone = false;

    /** playerId -> [3 张牌] */
    this.hands = new Map();
    /** playerId -> 本局累计下注 */
    this.bets = new Map();
    /** 已弃牌玩家 Set */
    this.folded = new Set();
    /** 已看牌玩家 Set */
    this.looked = new Set();
    /** 当前跟注额（看牌玩家一次跟注的金额） */
    this.currentBet = this.config.baseScore;
    /** 底池（本局总下注） */
    this.pot = 0;
    /** playerId -> 累计虚拟积分 */
    this.scores = new Map();
  }

  // ============================================================
  // 公开状态
  // ============================================================

  /** 确保某玩家有积分记录（进房/开局时调用） */
  ensureScore(playerId) {
    if (!this.scores.has(playerId)) {
      this.scores.set(playerId, this.config.initialScore);
    }
  }

  /** 获取某玩家牌局状态（供房间公开信息用） */
  getPlayerState(playerId) {
    return {
      score: this.scores.get(playerId) || this.config.initialScore,
      folded: this.folded.has(playerId),
      looked: this.looked.has(playerId),
      bet: this.bets.get(playerId) || 0,
    };
  }

  /** 牌局摘要（不含手牌） */
  toPublic() {
    return {
      phase: this.phase,
      round: this.round,
      headPlayerId: this.headPlayerId,
      config: this.config,
      currentBet: this.currentBet,
      pot: this.pot,
      currentPlayerId: this.seatOrder.length ? this.seatOrder[this.actionIndex] : null,
      seatOrder: this.seatOrder,
    };
  }

  // ============================================================
  // 开局
  // ============================================================

  /**
   * 开始一局
   * @returns {{ok:boolean, message?:string}}
   */
  startRound() {
    const playerCount = this.room.players.size;
    if (playerCount < 3 || playerCount > 8) {
      return { ok: false, message: `需要 3-8 人才能开局（当前 ${playerCount} 人）` };
    }
    if (this.phase !== PHASE.IDLE) {
      return { ok: false, message: '牌局进行中，请等待本局结束' };
    }

    // 锁定座位（房间当前玩家顺序）
    this.seatOrder = [...this.room.players.keys()];
    for (const pid of this.seatOrder) this.ensureScore(pid);

    this.round = 1;
    this.phase = PHASE.BETTING;
    this.hands = new Map();
    this.bets = new Map();
    this.folded = new Set();
    this.looked = new Set();
    this.pot = 0;
    this.currentBet = this.config.baseScore;
    this.headFirstActionDone = false;

    // 头家：上一把赢家的下一家；首局随机
    this.headPlayerId = this._pickHeadPlayer();
    this.actionIndex = this.seatOrder.indexOf(this.headPlayerId);
    this.roundStartIndex = this.actionIndex;

    this._deal();

    // 广播配置
    this.room.broadcast('gameConfig', { config: this.config });

    // 每人单独发自己的手牌（他人手牌保密）
    for (const pid of this.seatOrder) {
      this.room.sendToPlayer(pid, 'gameStart', {
        round: this.round,
        headPlayerId: this.headPlayerId,
        config: this.config,
        myHand: this.hands.get(pid),
        players: this._playersPublic(),
        currentPlayerId: this.seatOrder[this.actionIndex],
        mustBlind: this._isHeadFirstAction(),
      });
    }
    this._broadcastTurn();
    return { ok: true };
  }

  /** 首局随机头家；非首局取上一把赢家的下一家 */
  _pickHeadPlayer() {
    const lastWinner = this.room.lastWinnerId;
    if (lastWinner) {
      const idx = this.seatOrder.indexOf(lastWinner);
      if (idx >= 0) {
        return this.seatOrder[(idx + 1) % this.seatOrder.length];
      }
    }
    return this.seatOrder[Math.floor(Math.random() * this.seatOrder.length)];
  }

  /** 是否为"头家第一轮第一次行动"（必须闷一次、不可弃牌） */
  _isHeadFirstAction() {
    return (
      this.phase === PHASE.BETTING &&
      this.round === 1 &&
      this.seatOrder[this.actionIndex] === this.headPlayerId &&
      !this.headFirstActionDone
    );
  }

  /** 发牌：52 张去大小王，每人 3 张 */
  _deal() {
    const deck = this._buildDeck();
    this._shuffle(deck);
    for (let i = 0; i < this.seatOrder.length; i++) {
      this.hands.set(this.seatOrder[i], [deck[i * 3], deck[i * 3 + 1], deck[i * 3 + 2]]);
    }
  }

  // ============================================================
  // 玩家行动
  // ============================================================

  /**
   * 处理玩家行动
   * @param {string} playerId
   * @param {string} action look|blind|call|raise|fold|open
   * @param {number} [amount] raise 时的新跟注额
   */
  handleAction(playerId, action, amount) {
    if (this.phase !== PHASE.BETTING) {
      return { ok: false, message: '当前不在下注阶段' };
    }
    if (playerId !== this.seatOrder[this.actionIndex]) {
      return { ok: false, message: '还没轮到你操作' };
    }
    if (this.folded.has(playerId)) {
      return { ok: false, message: '你已弃牌，无法操作' };
    }
    if (this._isHeadFirstAction() && action !== 'blind') {
      return { ok: false, message: '你是头家，第一轮必须先闷一次，且不可弃牌' };
    }

    switch (action) {
      case 'look': {
        this.looked.add(playerId);
        this.room.broadcast('bet', this._betPayload(playerId, 'look', 0, playerId));
        break;
      }
      case 'blind':
      case 'call': {
        // 跟注：闷牌付 ceil(当前跟注额 * 闷注比例)，看牌付全额
        const pay = this.looked.has(playerId)
          ? this._capPay(playerId, this.currentBet)
          : this._capPay(playerId, Math.ceil(this.currentBet * this.config.blindRatio));
        const real = this._pay(playerId, pay);
        if (this._isHeadFirstAction()) this.headFirstActionDone = true;
        this.room.broadcast('bet', this._betPayload(playerId, action, real, playerId));
        // 下注完成后轮到下一家（look 不轮转：看牌后仍由当前玩家继续决策）
        this._advanceTurn();
        break;
      }
      case 'raise': {
        const target = Math.floor(Number(amount));
        if (!Number.isFinite(target) || target < this.currentBet + this.config.baseScore) {
          return { ok: false, message: `加注后跟注额需至少比当前高一个底分（≥ ${this.currentBet + this.config.baseScore}）` };
        }
        const pay = this.looked.has(playerId)
          ? this._capPay(playerId, target)
          : this._capPay(playerId, Math.ceil(target * this.config.blindRatio));
        const real = this._pay(playerId, pay);
        this.currentBet = target;
        this.room.broadcast('bet', this._betPayload(playerId, 'raise', real, playerId));
        this._advanceTurn();
        break;
      }
      case 'fold': {
        // 头家第一轮不可弃牌（前面已拦截）
        this.folded.add(playerId);
        const remain = this._remainPlayers();
        this.room.broadcast('fold', {
          playerId,
          players: this._playersPublic(),
          remain: remain.length,
        });
        if (remain.length === 1) {
          // 只剩一人 -> 直接结算（可能触发 235 吃鸡）
          this._settle(remain[0], 'fold');
        } else {
          this._advanceTurn();
        }
        break;
      }
      case 'open': {
        // 全员开牌比大小
        this.phase = PHASE.SHOWDOWN;
        this.room.broadcast('open', {
          playerId,
          reason: 'open',
          players: this._playersPublic(),
        });
        this._settle(null, 'showdown');
        break;
      }
      default:
        return { ok: false, message: `未知操作: ${action}` };
    }
    return { ok: true };
  }

  /** 玩家断线兜底：轮到其行动时自动弃牌 */
  onPlayerDisconnect(playerId) {
    if (this.phase !== PHASE.BETTING) return;
    if (this.folded.has(playerId)) return;
    if (this.seatOrder[this.actionIndex] === playerId) {
      // 头家第一轮断线：也按弃牌处理（房间无人操作，自动结束该玩家）
      this.folded.add(playerId);
      const remain = this._remainPlayers();
      this.room.broadcast('fold', {
        playerId,
        reason: 'disconnect',
        players: this._playersPublic(),
        remain: remain.length,
      });
      if (remain.length === 1) {
        this._settle(remain[0], 'fold');
      } else {
        this._advanceTurn();
      }
    }
  }

  // ============================================================
  // 轮转与开牌判定
  // ============================================================

  /** 当前未弃牌玩家列表 */
  _remainPlayers() {
    return this.seatOrder.filter((id) => !this.folded.has(id));
  }

  /** 行动后轮转；一轮结束则 round+1；超过开牌轮数则强制开牌 */
  _advanceTurn() {
    let guard = 0;
    while (guard++ <= this.seatOrder.length * 2) {
      this.actionIndex = (this.actionIndex + 1) % this.seatOrder.length;
      const pid = this.seatOrder[this.actionIndex];
      if (this.folded.has(pid)) continue;

      // 一轮结束判定：回到本轮起点
      if (this.actionIndex === this.roundStartIndex) {
        this.round += 1;
        this.roundStartIndex = this.actionIndex;
        if (this.round > this.config.openAfterRounds) {
          // 达到开牌轮数 -> 强制开牌
          this.phase = PHASE.SHOWDOWN;
          this.room.broadcast('open', {
            playerId: null,
            reason: 'rounds',
            players: this._playersPublic(),
          });
          this._settle(null, 'showdown');
          return;
        }
      }

      // 断线玩家自动弃牌
      const player = this.room.players.get(pid);
      if (player && player.online === false) {
        this.folded.add(pid);
        const remain = this._remainPlayers();
        this.room.broadcast('fold', {
          playerId: pid,
          reason: 'disconnect',
          players: this._playersPublic(),
          remain: remain.length,
        });
        if (remain.length === 1) {
          this._settle(remain[0], 'fold');
          return;
        }
        continue;
      }

      this._broadcastTurn();
      return;
    }
    // 兜底：理论上到不了这里；若只剩一人则直接结算
    const remain = this._remainPlayers();
    if (remain.length === 1) {
      this._settle(remain[0], 'fold');
    }
  }

  /** 广播轮到谁行动 */
  _broadcastTurn() {
    const pid = this.seatOrder[this.actionIndex];
    this.room.broadcast('turn', {
      currentPlayerId: pid,
      round: this.round,
      mustBlind: this._isHeadFirstAction(),
    });
  }

  // ============================================================
  // 结算
  // ============================================================

  /**
   * 结算一局
   * @param {string|null} winnerId 已知赢家（fold 场景）；null 表示开牌比牌
   * @param {string} reason fold | showdown
   */
  _settle(winnerId, reason) {
    const remain = this._remainPlayers();
    let finalWinner = winnerId;
    let tieWinners = [];

    if (reason === 'showdown') {
      const evaluated = remain.map((pid) => ({
        pid,
        hand: this.hands.get(pid),
        eval: evaluateHand(this.hands.get(pid)),
      }));
      // 找出最强（支持平局）
      let best = [];
      for (const item of evaluated) {
        if (best.length === 0) {
          best = [item];
          continue;
        }
        const cmp = compareHands(item.eval, best[0].eval);
        if (cmp > 0) best = [item];
        else if (cmp === 0) best.push(item);
      }
      tieWinners = best.map((b) => b.pid);
      finalWinner = best[0] ? best[0].pid : null;
    }

    // ---- 235 吃鸡奖励 ----
    let bonus = 0;
    let bonusDesc = null;
    if (reason === 'fold' && finalWinner && !this.looked.has(finalWinner)) {
      const ev = evaluateHand(this.hands.get(finalWinner));
      if (ev.is235) {
        bonus = this.config.bonusStraightFlush + this.config.bonusTriplet;
        bonusDesc = `235 闷牌吃鸡：额外奖励 同花顺(${this.config.bonusStraightFlush}) + 豹子(${this.config.bonusTriplet}) = ${bonus}`;
      }
    }

    // ---- 底池分配（含封顶） ----
    let potWin = this.pot;
    let capped = false;
    if (potWin > this.config.maxLoss) {
      potWin = this.config.maxLoss;
      capped = true;
    }
    // 平局平分
    const shareCount = tieWinners.length > 0 ? tieWinners.length : 1;
    const share = Math.floor(potWin / shareCount);

    let finalPotWin = 0;
    if (finalWinner) {
      if (tieWinners.length > 0) {
        for (const pid of tieWinners) {
          this.scores.set(pid, this.scores.get(pid) + share);
          finalPotWin += share;
        }
      } else {
        this.scores.set(finalWinner, this.scores.get(finalWinner) + potWin + bonus);
        finalPotWin = potWin + bonus;
      }
    }

    this.room.lastWinnerId = finalWinner;
    this.phase = PHASE.SETTLEMENT;

    const result = {
      round: this.round,
      reason,                       // fold | showdown
      winnerId: finalWinner,
      tieWinners,
      pot: this.pot,
      potWin,
      capped,                       // 是否触发封顶截断
      bonus,
      bonusDesc,
      hands: this.seatOrder.map((pid) => {
        const ev = evaluateHand(this.hands.get(pid));
        return {
          playerId: pid,
          nickname: (this.room.players.get(pid) || {}).nickname || '',
          cards: this.hands.get(pid),
          handType: ev.handType,
          handTypeName: HAND_RANK_NAME[ev.handType],
          is235: ev.is235,
          folded: this.folded.has(pid),
          looked: this.looked.has(pid),
          bet: this.bets.get(pid) || 0,
        };
      }),
      scores: Object.fromEntries([...this.scores.entries()]),
      config: this.config,
    };

    this.room.broadcast('roundResult', result);
    this.phase = PHASE.IDLE;
  }

  // ============================================================
  // 下注工具
  // ============================================================

  /** 封顶截断：玩家本局累计下注不得超过 maxLoss */
  _capPay(playerId, pay) {
    const used = this.bets.get(playerId) || 0;
    return Math.max(0, Math.min(pay, this.config.maxLoss - used));
  }

  /** 执行下注（已截断金额），返回实际入池金额 */
  _pay(playerId, pay) {
    this.bets.set(playerId, (this.bets.get(playerId) || 0) + pay);
    this.pot += pay;
    return pay;
  }

  /** 构造 bet 广播数据 */
  _betPayload(playerId, action, amount, currentPlayerId) {
    return {
      playerId,
      action,
      amount,
      currentBet: this.currentBet,
      pot: this.pot,
      round: this.round,
      players: this._playersPublic(),
      currentPlayerId,
      mustBlind: this._isHeadFirstAction(),
    };
  }

  /** 玩家公开信息（含积分与牌局状态，不含手牌） */
  _playersPublic() {
    return this.seatOrder.map((pid) => {
      const p = this.room.players.get(pid) || {};
      const s = this.getPlayerState(pid);
      return {
        id: pid,
        nickname: p.nickname || '',
        online: p.online !== false,
        score: s.score,
        folded: s.folded,
        looked: s.looked,
        bet: s.bet,
        seat: this.seatOrder.indexOf(pid) + 1,
      };
    });
  }

  // ============================================================
  // 工具
  // ============================================================

  _buildDeck() {
    const suits = ['♠', '♥', '♣', '♦'];
    const deck = [];
    for (const suit of suits) {
      for (let rank = 2; rank <= 14; rank++) {
        deck.push({ suit, rank });
      }
    }
    return deck;
  }

  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
}

module.exports = {
  Game,
  PHASE,
  HAND_RANK,
  HAND_RANK_NAME,
  DEFAULT_CONFIG,
  normalizeConfig,
  evaluateHand,
  compareHands,
};
