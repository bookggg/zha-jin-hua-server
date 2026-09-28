/**
 * WebSocket 客户端封装
 * 功能：连接、断线自动重连、消息收发、事件订阅
 *
 * 消息协议（与服务端一致）：
 *   发送：send(type, data)  ->  {type, data}
 *   接收：{type, data}      -> 触发 on(type, callback)
 */
class NetClient {
  constructor() {
    this.ws = null;
    this._handlers = new Map(); // type -> [cb, ...]
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._maxReconnect = 5;
    this._closedByUser = false;
    this.onStatusChange = null; // (status: 'connecting'|'online'|'offline') => void
  }

  /**
   * 解析服务器地址：
   *   1) 优先读取 localStorage 中 key=zjh_server_url 的配置（https->wss，http->ws）
   *   2) 无配置时按当前页面地址推断（http->ws，https->wss）
   *   3) file:// 协议且无配置：触发 system 事件提示用户先设置服务器地址
   */
  _resolveServerUrl() {
    let saved = '';
    try {
      saved = (localStorage.getItem('zjh_server_url') || '').trim();
    } catch (e) {
      saved = '';
    }
    if (saved) {
      let base = saved.replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
      const proto = /^https:/i.test(base) ? 'wss' : 'ws';
      return `${proto}://${base.replace(/^https?:\/\//i, '')}`;
    }
    // 正常 http/https 页面：沿用原逻辑按 location 推断
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      return `${proto}://${location.host}`;
    }
    // file:// 等协议且未配置服务器地址
    this._emit('system', { message: '请先设置服务器地址' });
    return null;
  }

  /** 建立连接（优先使用 localStorage 中配置的服务器地址，否则按当前页面地址推断） */
  connect() {
    this._closedByUser = false;
    const url = this._resolveServerUrl();
    if (!url) {
      // 无可用地址（如 file:// 下未配置服务器地址），保持离线状态
      this._setStatus('offline');
      return;
    }
    this._setStatus('connecting');

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this._reconnectAttempts = 0;
      this._setStatus('online');
    };

    this.ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        console.warn('[net] 无法解析的消息:', event.data);
        return;
      }
      this._emit(msg.type, msg.data);
    };

    this.ws.onclose = () => {
      this._setStatus('offline');
      // 断线自动重连（指数退避）
      if (!this._closedByUser && this._reconnectAttempts < this._maxReconnect) {
        const delay = 1000 * Math.pow(2, this._reconnectAttempts);
        this._reconnectAttempts += 1;
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(() => {
          this._emit('system', { message: '连接断开，正在重连...' });
          this.connect();
        }, delay);
      } else if (this._reconnectAttempts >= this._maxReconnect) {
        this._emit('system', { message: '连接失败，请刷新页面重试' });
      }
    };

    this.ws.onerror = () => {
      // onclose 会兜底处理，这里只打印日志
      console.warn('[net] WebSocket 错误');
    };
  }

  /** 主动断开（不再重连） */
  disconnect() {
    this._closedByUser = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** 当前是否已建立连接 */
  isConnected() {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  /** 读取已配置的服务器地址（localStorage key=zjh_server_url） */
  getConfiguredServerUrl() {
    try {
      return (localStorage.getItem('zjh_server_url') || '').trim();
    } catch (e) {
      return '';
    }
  }

  /** 保存服务器地址到 localStorage（空串/纯空格则清除配置） */
  setServerUrl(url) {
    const v = (url || '').trim();
    try {
      if (v) {
        localStorage.setItem('zjh_server_url', v);
      } else {
        localStorage.removeItem('zjh_server_url');
      }
    } catch (e) {
      console.warn('[net] 无法写入 localStorage:', e);
    }
  }

  /** 按当前配置强制重连（先断开旧连接，再用新地址连接） */
  reconnect() {
    this._closedByUser = true;
    if (this.ws) {
      // 忽略旧连接的 close 事件，避免触发断线重连逻辑
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch (e) { /* 忽略 */ }
      this.ws = null;
    }
    this.connect();
  }

  /** 发送消息：{type, data} */
  send(type, data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, data: data || {} }));
      return true;
    }
    console.warn('[net] 未连接，消息未发送:', type);
    return false;
  }

  /** 订阅事件：on(type, callback)，返回取消订阅函数 */
  on(type, cb) {
    if (!this._handlers.has(type)) {
      this._handlers.set(type, []);
    }
    this._handlers.get(type).push(cb);
    return () => {
      const list = this._handlers.get(type) || [];
      const idx = list.indexOf(cb);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  _emit(type, data) {
    const list = this._handlers.get(type) || [];
    for (const cb of list.slice()) {
      try {
        cb(data);
      } catch (e) {
        console.error('[net] 事件回调异常:', type, e);
      }
    }
  }

  _setStatus(status) {
    if (this.onStatusChange) {
      this.onStatusChange(status);
    }
  }
}

/** 全局单例 */
window.net = new NetClient();
