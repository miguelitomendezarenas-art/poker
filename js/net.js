// Peer-to-peer transport. The host's browser owns the table; guests connect to it over WebRTC.
// Signalling and TURN relays come from PeerJS's free public cloud, so nothing needs a server.
const PREFIX = 'flop-poker-v1-';
const PING_EVERY = 4000;
const STALE_AFTER = 14000;

export const peerIdFor = (code) => PREFIX + code;

const RECOVERABLE = new Set(['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected']);

export class HostNet {
  constructor(code, cb) {
    this.code = code;
    this.cb = cb; // { onReady, onMessage(conn, msg), onClose(conn), onError(text) }
    this.conns = new Set();
    this.retries = 0;
    this.destroyed = false;
  }

  start() {
    this.peer = new window.Peer(peerIdFor(this.code));
    this.peer.on('open', () => {
      this.retries = 0;
      this.cb.onReady();
    });
    this.peer.on('connection', (conn) => this.accept(conn));
    this.peer.on('disconnected', () => {
      if (!this.destroyed) setTimeout(() => this.reconnectPeer(), 1500);
    });
    this.peer.on('error', (err) => {
      if (this.destroyed) return;
      if (err.type === 'unavailable-id' || RECOVERABLE.has(err.type)) {
        // After a reload the old registration can linger for a few seconds
        this.peer.destroy();
        if (this.retries++ < 20) setTimeout(() => !this.destroyed && this.start(), 2000);
        else this.cb.onError('No se pudo abrir la mesa. Revisa tu conexión.');
      }
    });
    clearInterval(this.pinger);
    this.pinger = setInterval(() => this.heartbeat(), PING_EVERY);
  }

  accept(conn) {
    conn.lastSeen = Date.now();
    conn.on('open', () => this.conns.add(conn));
    conn.on('data', (msg) => {
      conn.lastSeen = Date.now();
      if (msg?.t !== 'pong') this.cb.onMessage(conn, msg);
    });
    const close = () => {
      if (!this.conns.has(conn)) return;
      this.conns.delete(conn);
      this.cb.onClose(conn);
    };
    conn.on('close', close);
    conn.on('error', close);
    conn._close = close;
  }

  heartbeat() {
    const now = Date.now();
    for (const conn of this.conns) {
      if (now - conn.lastSeen > STALE_AFTER) {
        conn._close();
        conn.close();
      } else {
        this.send(conn, { t: 'ping' });
      }
    }
  }

  reconnectPeer() {
    if (!this.destroyed && this.peer.disconnected && !this.peer.destroyed) this.peer.reconnect();
  }

  send(conn, msg) {
    if (conn.open) {
      try { conn.send(msg); } catch { /* channel closing */ }
    }
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.pinger);
    this.peer?.destroy();
  }
}

export class GuestNet {
  constructor(code, cb) {
    this.code = code;
    this.cb = cb; // { onOpen, onMessage(msg), onStatus('connecting'|'lost'|'missing') }
    this.destroyed = false;
    this.everOpened = false;
  }

  start() {
    this.peer = new window.Peer();
    this.peer.on('open', () => this.connect());
    this.peer.on('disconnected', () => {
      if (!this.destroyed) setTimeout(() => this.reconnectPeer(), 1500);
    });
    this.peer.on('error', (err) => {
      if (this.destroyed) return;
      if (err.type === 'peer-unavailable') {
        this.cb.onStatus(this.everOpened ? 'lost' : 'missing');
        this.retry();
      } else if (RECOVERABLE.has(err.type)) {
        this.cb.onStatus('lost');
        this.retry();
      }
    });
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.conn?.open && Date.now() - this.lastMsg > STALE_AFTER) {
        this.conn.close();
        this.cb.onStatus('lost');
        this.retry();
      }
    }, PING_EVERY);
  }

  connect() {
    if (this.destroyed) return;
    this.conn?.close();
    const conn = this.peer.connect(peerIdFor(this.code), { reliable: true });
    this.conn = conn;
    conn.on('open', () => {
      this.everOpened = true;
      this.lastMsg = Date.now();
      this.cb.onOpen();
    });
    conn.on('data', (msg) => {
      this.lastMsg = Date.now();
      if (msg?.t === 'ping') this.send({ t: 'pong' });
      else this.cb.onMessage(msg);
    });
    conn.on('close', () => {
      if (this.conn !== conn || this.destroyed) return;
      this.cb.onStatus('lost');
      this.retry();
    });
  }

  retry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.destroyed) return;
      if (this.peer.destroyed) return this.start();
      if (this.peer.disconnected) return this.reconnectPeer(); // 'open' fires again and reconnects
      this.connect();
    }, 2500);
  }

  reconnectPeer() {
    if (!this.destroyed && this.peer.disconnected && !this.peer.destroyed) this.peer.reconnect();
  }

  send(msg) {
    if (this.conn?.open) {
      try { this.conn.send(msg); } catch { /* channel closing */ }
    }
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.watchdog);
    clearTimeout(this.retryTimer);
    this.conn?.close();
    this.peer?.destroy();
  }
}
