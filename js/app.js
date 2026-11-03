import { Table, MAX_SEATS } from './engine.js';
import { HostNet, GuestNet } from './net.js';
import { SUIT_SYMBOL, RANK_LABEL, bestHand } from './cards.js';

const $ = (sel, root = document) => root.querySelector(sel);
const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const AVATAR_COLORS = ['#f2c45a', '#7cd3a8', '#8ab4ff', '#f59fb8', '#c7a2ff', '#ffb27a', '#6fd6e0', '#e4e88a'];
const BASE_TITLE = document.title;

// ---------- storage (best effort: private windows can throw) ----------

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

function randomString(len, abc) {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => abc[b % abc.length]).join('');
}
const genCode = () => randomString(5, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789');

function tokenFor(code) {
  let t = store.get('flop:token:' + code);
  if (!t) {
    t = randomString(24, 'abcdefghijklmnopqrstuvwxyz0123456789');
    store.set('flop:token:' + code, t);
  }
  return t;
}

// ---------- app state ----------

const app = {
  role: null,
  code: null,
  name: '',
  net: null,
  table: null,
  conns: new Map(), // host only: conn -> player id
  myId: null,
  missing: 0,
};

let prev = null;
let lastView = null;

// ---------- host ----------

function startHost(name, settings, code = genCode(), snapshot = null) {
  app.role = 'host';
  app.code = code;
  app.name = name;
  store.set('flop:role:' + code, 'host');
  const token = tokenFor(code);

  app.table = snapshot ? Table.restore(snapshot, onTableChange) : new Table(settings, onTableChange);
  app.myId = app.table.join(token, name).id;

  app.net = new HostNet(code, {
    onReady: () => setConn(null),
    onMessage: hostMessage,
    onClose: (conn) => {
      const id = app.conns.get(conn);
      app.conns.delete(conn);
      if (id && ![...app.conns.values()].includes(id)) app.table.setConnected(id, false);
    },
    onError: (text) => toast(text, 'error'),
  });
  setConn('Abriendo mesa…');
  app.net.start();
  enterGame();
  broadcast();
}

function hostMessage(conn, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'join') {
    const res = app.table.join(String(msg.token || ''), msg.name);
    if (res.error) return app.net.send(conn, { t: 'error', text: res.error });
    app.conns.set(conn, res.id);
    app.net.send(conn, { t: 'welcome', id: res.id });
    app.net.send(conn, { t: 'state', s: app.table.view(res.id) });
    return;
  }
  const id = app.conns.get(conn);
  if (!id) return;
  app.table.handle(id, msg);
  if (msg.t === 'leave') app.conns.delete(conn);
}

let broadcastQueued = false;
function onTableChange() {
  if (broadcastQueued) return;
  broadcastQueued = true;
  queueMicrotask(() => {
    broadcastQueued = false;
    broadcast();
  });
}

function broadcast() {
  const t = app.table;
  if (!t || app.role !== 'host') return;
  store.set('flop:host:' + app.code, JSON.stringify(t.snapshot()));
  for (const [conn, id] of app.conns) app.net.send(conn, { t: 'state', s: t.view(id) });
  if (app.myId) render(t.view(app.myId));
}

// ---------- guest ----------

function startGuest(name, code) {
  app.role = 'guest';
  app.code = code;
  app.name = name;
  app.missing = 0;
  store.set('flop:role:' + code, 'guest');
  const token = tokenFor(code);

  app.net = new GuestNet(code, {
    onOpen: () => {
      app.missing = 0;
      setConn(null);
      app.net.send({ t: 'join', token, name });
    },
    onMessage: (msg) => {
      if (msg.t === 'welcome') app.myId = msg.id;
      else if (msg.t === 'state') render(msg.s);
      else if (msg.t === 'error') {
        toast(msg.text, 'error');
        exitGame(false);
      }
    },
    onStatus: (s) => {
      if (s === 'missing' && ++app.missing >= 4) {
        toast(`No hay ninguna mesa abierta con el código ${code}.`, 'error');
        store.del('flop:role:' + code);
        return exitGame(false);
      }
      setConn(s === 'missing' ? 'Buscando la mesa…' : 'Reconectando…');
    },
  });
  setConn('Conectando…');
  app.net.start();
  enterGame();
  renderEmpty('Conectando con la mesa…');
}

// ---------- shared actions ----------

function send(msg) {
  if (app.role === 'host') app.table.handle(app.myId, msg);
  else app.net?.send(msg);
}

function enterGame() {
  $('#lobby').hidden = true;
  $('#game').hidden = false;
  $('#room-code').textContent = app.code;
  history.replaceState(null, '', '#' + app.code);
  prev = null;
}

function exitGame(notify = true) {
  if (notify && app.role === 'guest') app.net?.send({ t: 'leave' });
  if (app.role === 'host') {
    app.table?.stopTimers();
    store.del('flop:host:' + app.code);
  }
  store.del('flop:role:' + app.code);
  const net = app.net;
  // Give the leave message a moment to flush before tearing down the connection
  setTimeout(() => net?.destroy(), notify ? 300 : 0);
  Object.assign(app, { role: null, code: null, net: null, table: null, myId: null });
  app.conns.clear();
  prev = lastView = null;
  document.title = BASE_TITLE;
  history.replaceState(null, '', location.pathname);
  $('#game').hidden = true;
  $('#lobby').hidden = false;
  $('#seats').replaceChildren();
  $('#board').replaceChildren();
  $('#my-cards').replaceChildren();
  $('#controls').replaceChildren();
  $('#dealer-btn')?.remove();
  controlsKey = '';
  myCardsKey = '';
  seatEls.clear();
}

function setConn(text) {
  const el = $('#conn');
  el.hidden = !text;
  el.textContent = text || '';
}

// ---------- toasts ----------

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }, kind === 'error' ? 4200 : 2400);
}

// ---------- sound ----------

let audio = null;
function unlockAudio() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch {}
}
function ding() {
  if (!audio) return;
  const now = audio.currentTime;
  for (const [i, f] of [[0, 660], [1, 990]]) {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0, now + i * 0.09);
    g.gain.linearRampToValueAtTime(0.06, now + i * 0.09 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.18);
    o.connect(g).connect(audio.destination);
    o.start(now + i * 0.09);
    o.stop(now + i * 0.09 + 0.2);
  }
}

// ---------- geometry ----------

// Seat positions around the oval, rotated so the viewer always sits at the bottom
function spot(seat, mySeat, k, offsetDeg = 0) {
  const r = (seat - mySeat + MAX_SEATS) % MAX_SEATS;
  const a = ((90 + r * (360 / MAX_SEATS) + offsetDeg) * Math.PI) / 180;
  return { x: 50 + Math.cos(a) * 50 * k, y: 50 + Math.sin(a) * 50 * k };
}

function pointIn(el, root = $('#table')) {
  const t = root.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2 - t.left, y: r.top + r.height / 2 - t.top };
}

function delta(from, toEl) {
  const a = from.getBoundingClientRect();
  const b = toEl.getBoundingClientRect();
  return { x: a.left + a.width / 2 - (b.left + b.width / 2), y: a.top + a.height / 2 - (b.top + b.height / 2) };
}

// ---------- cards ----------

function cardEl(code) {
  const el = document.createElement('div');
  el.innerHTML = '<div class="card-inner"><div class="card-face"></div><div class="card-back"></div></div>';
  if (code === '??') {
    el.className = 'card down';
    return el;
  }
  const [r, s] = code;
  const suit = SUIT_SYMBOL[s] + '︎'; // text presentation, never emoji
  el.className = 'card' + (s === 'h' || s === 'd' ? ' red' : '');
  el.dataset.c = code;
  el.querySelector('.card-face').innerHTML =
    `<span class="card-rank">${RANK_LABEL[r] || r}</span><span class="card-suit">${suit}</span><span class="card-pip">${suit}</span>`;
  el.setAttribute('aria-label', code);
  return el;
}

function flip(el, delay = 0, duration = 380) {
  if (reduceMotion.matches) return el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay, fill: 'backwards' });
  el.querySelector('.card-inner').animate(
    [{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(0deg)' }],
    { duration, delay, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'backwards' },
  );
}

// Card travels from the deck (table centre) to where it sits
function dealFrom(el, origin, delay, { faceUp = false } = {}) {
  if (reduceMotion.matches) {
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay, fill: 'backwards' });
    return;
  }
  const d = delta(origin, el);
  el.animate(
    [{ offset: 0, translate: `${d.x}px ${d.y}px`, scale: 0.55, opacity: 0 }, { offset: 0.25, opacity: 1 }],
    { duration: 420, delay, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'backwards' },
  );
  if (faceUp) {
    el.querySelector('.card-inner').animate(
      [{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(180deg)', offset: 0.55 }, { transform: 'rotateY(0deg)' }],
      { duration: 700, delay, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'backwards' },
    );
  }
}

function flyChip(from, to, delay = 0) {
  const table = $('#table');
  const n = document.createElement('div');
  n.className = 'flying-chip';
  n.innerHTML = '<span class="chip"></span>';
  n.style.left = from.x + 'px';
  n.style.top = from.y + 'px';
  table.append(n);
  const move = reduceMotion.matches
    ? [{ opacity: 1 }, { opacity: 0 }]
    : [
        { transform: 'translate(0, 0)', opacity: 1 },
        { transform: `translate(${to.x - from.x}px, ${to.y - from.y}px)`, opacity: 1, offset: 0.85 },
        { transform: `translate(${to.x - from.x}px, ${to.y - from.y}px)`, opacity: 0 },
      ];
  const anim = n.animate(move, { duration: 520, delay, easing: 'cubic-bezier(0.77, 0, 0.175, 1)', fill: 'both' });
  anim.onfinish = () => n.remove();
}

// ---------- rendering ----------

const seatEls = new Map(); // player id -> { root, cards, plate, avatar, name, stack, tag, cardsKey, tagKey, timerKey }
let myCardsKey = '';
let controlsKey = '';

function actionLabel(a) {
  if (!a) return null;
  switch (a.type) {
    case 'sb': return ['Ciega pequeña', ''];
    case 'bb': return ['Ciega grande', ''];
    case 'check': return ['Pasa', ''];
    case 'call': return ['Iguala', ''];
    case 'bet': return [`Apuesta ${fmt(a.amount)}`, 'bet'];
    case 'raise': return [`Sube a ${fmt(a.amount)}`, 'raise'];
    case 'allin': return ['All-in', 'allin'];
    case 'fold': return ['Se retira', 'fold'];
  }
  return null;
}

function renderEmpty(text) {
  $('#status').innerHTML = esc(text);
  $('#pot').classList.add('empty');
  $('#board').replaceChildren(...Array.from({ length: 5 }, () => slot()));
  $('#controls').replaceChildren();
}

function slot() {
  const s = document.createElement('div');
  s.className = 'board-slot';
  return s;
}

function render(v) {
  v.receivedAt = performance.now();
  const me = v.players.find((p) => p.id === v.you);
  const mySeat = me ? me.seat : 0;
  const newHand = !prev || prev.handNo !== v.handNo;

  // Remember where bets sat before the DOM changes, so swept chips can fly from there
  const betFrom = new Map();
  for (const el of document.querySelectorAll('#seats .bet')) betFrom.set(el.dataset.id, pointIn(el));
  const potPoint = pointIn($('#pot'));

  renderSeats(v, me, mySeat, newHand);
  renderBoard(v, newHand);
  renderCenter(v, me);
  renderDock(v, me, newHand);
  renderTopbar(v, me);

  // Chips: bets swept into the pot at the end of a street, or the pot pushed to winners
  if (prev && !newHand) {
    for (const p of v.players) {
      const was = prev.players.find((q) => q.id === p.id);
      if (was && was.bet > 0 && p.bet === 0 && betFrom.has(p.id)) {
        const target = v.result?.uncontested ? seatPoint(v.result.pots[0].winners[0]) : potPoint;
        if (target) flyChip(betFrom.get(p.id), target);
      }
    }
    if (v.result && !prev.result) celebrate(v, potPoint);
  }

  // Your turn: a gentle chime and a buzz on phones
  const myTurn = me && v.toAct === me.seat;
  const wasMyTurn = prev && me && prev.toAct === me.seat && prev.phase === v.phase && prev.handNo === v.handNo;
  if (myTurn && !wasMyTurn) {
    ding();
    navigator.vibrate?.(25);
  }
  document.title = myTurn ? '● Tu turno · Flop' : BASE_TITLE;

  prev = v;
  lastView = v;
}

function seatPoint(id) {
  const s = seatEls.get(id);
  return s ? pointIn(s.plate) : null;
}

function renderSeats(v, me, mySeat, newHand) {
  const layer = $('#seats');
  const live = new Set(v.players.map((p) => p.id));
  for (const [id, s] of seatEls) {
    if (!live.has(id)) {
      s.root.remove();
      seatEls.delete(id);
    }
  }

  const winners = new Set(v.result?.pots.flatMap((p) => p.winners) || []);
  const occupied = new Set(v.players.map((p) => p.seat));
  const dealOrigin = $('#board');
  let dealIndex = 0;

  for (const p of [...v.players].sort((a, b) => ((a.seat - v.dealerSeat + 7) % 8) - ((b.seat - v.dealerSeat + 7) % 8))) {
    let s = seatEls.get(p.id);
    if (!s) {
      s = createSeat();
      seatEls.set(p.id, s);
      layer.append(s.root);
    }
    const isMe = p.id === v.you;
    const pos = spot(p.seat, mySeat, 1);
    s.root.style.setProperty('--x', pos.x + '%');
    s.root.style.setProperty('--y', pos.y + '%');
    s.root.classList.toggle('me', isMe);
    s.root.classList.toggle('folded', p.folded);
    s.root.classList.toggle('out', (p.sittingOut && !p.inHand) || (!p.connected && !p.inHand));
    s.root.classList.toggle('turn', v.toAct === p.seat);
    s.root.classList.toggle('winner', winners.has(p.id) && v.phase === 'showdown');
    s.root.classList.toggle('shown', !!p.hand);

    s.avatar.firstChild.textContent = p.name.slice(0, 1).toUpperCase();
    s.avatar.style.setProperty('--av', AVATAR_COLORS[p.seat % AVATAR_COLORS.length]);
    s.avatar.classList.toggle('offline', !p.connected);
    s.name.textContent = p.name;
    s.stack.textContent = p.allIn && p.inHand && !p.folded && v.phase !== 'showdown' ? 'All-in' : fmt(p.stack);

    // Hole cards (yours live in the dock instead)
    const cardsKey = isMe ? '' : `${v.handNo}|${p.hole.join(',')}`;
    if (cardsKey !== s.cardsKey) {
      const before = s.cardsKey.split('|')[1]?.split(',') || [];
      s.cards.replaceChildren(...(isMe ? [] : p.hole.map(cardEl)));
      [...s.cards.children].forEach((el, i) => {
        if (newHand) dealFrom(el, dealOrigin, (dealIndex + i * v.players.length) * 60);
        else if (before[i] === '??' && p.hole[i] !== '??') flip(el, i * 90);
      });
      s.cardsKey = cardsKey;
    }
    if (p.inHand) dealIndex++;
    markWinningCards(s.cards, v);

    // Tag under the plate
    let tag = null;
    if (v.phase === 'showdown' && winners.has(p.id) && v.result?.uncontested) tag = [`Gana ${fmt(p.won)}`, 'won'];
    else if (p.hand) tag = [p.hand, winners.has(p.id) ? 'won' : 'hand'];
    else if (p.inHand) tag = actionLabel(p.lastAction);
    else if (!p.connected) tag = ['Desconectado', 'fold'];
    else if (p.sittingOut) tag = [p.stack === 0 ? 'Sin fichas' : 'Levantado', 'fold'];
    const tagKey = tag ? tag.join('|') : '';
    if (tagKey !== s.tagKey) {
      s.tag?.remove();
      s.tag = null;
      if (tag) {
        s.tag = document.createElement('span');
        s.tag.className = 'tag ' + tag[1];
        s.tag.textContent = tag[0];
        s.plate.append(s.tag);
      }
      s.tagKey = tagKey;
    }

    // Turn countdown ring
    const timerKey = v.toAct === p.seat ? `${v.handNo}|${v.phase}|${v.currentBet}|${p.seat}` : '';
    if (timerKey !== s.timerKey) {
      s.avatar.querySelector('.timer')?.remove();
      if (timerKey) {
        const total = v.settings.turnTime;
        const elapsed = total - v.turnRemaining / 1000;
        s.avatar.insertAdjacentHTML('beforeend',
          `<svg class="timer" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18.5" pathLength="100" style="--dur:${total}s;--delay:${-elapsed.toFixed(2)}s"/></svg>`);
      }
      s.timerKey = timerKey;
    }
  }

  // Bets, dealer button and empty seats are cheap: redraw them each time
  for (const el of layer.querySelectorAll('.bet, .dealer, .empty-seat')) el.remove();
  const frag = document.createDocumentFragment();
  for (const p of v.players) {
    if (p.bet <= 0) continue;
    const pos = spot(p.seat, mySeat, 0.6);
    const b = document.createElement('div');
    b.className = 'bet';
    b.dataset.id = p.id;
    b.style.setProperty('--x', pos.x + '%');
    b.style.setProperty('--y', pos.y + '%');
    b.innerHTML = `<span class="chip"></span>${fmt(p.bet)}`;
    frag.append(b);
  }
  for (let seat = 0; seat < MAX_SEATS; seat++) {
    if (occupied.has(seat)) continue;
    const pos = spot(seat, mySeat, 1);
    const e = document.createElement('div');
    e.className = 'empty-seat';
    e.style.setProperty('--x', pos.x + '%');
    e.style.setProperty('--y', pos.y + '%');
    frag.append(e);
  }
  layer.append(frag);

  let dealer = $('#dealer-btn');
  if (v.dealerSeat >= 0 && v.handNo > 0) {
    if (!dealer) {
      dealer = document.createElement('div');
      dealer.id = 'dealer-btn';
      dealer.className = 'dealer';
      dealer.textContent = 'D';
      dealer.setAttribute('aria-label', 'Repartidor');
      $('#table').append(dealer);
    }
    const pos = spot(v.dealerSeat, mySeat, 0.74, -16);
    dealer.style.setProperty('--x', pos.x + '%');
    dealer.style.setProperty('--y', pos.y + '%');
  } else dealer?.remove();
}

function createSeat() {
  const root = document.createElement('div');
  root.className = 'seat';
  root.innerHTML = `
    <div class="seat-cards"></div>
    <div class="plate">
      <div class="avatar"><span></span></div>
      <div class="meta"><span class="name"></span><span class="stack"></span></div>
    </div>`;
  return {
    root,
    cards: $('.seat-cards', root),
    plate: $('.plate', root),
    avatar: $('.avatar', root),
    name: $('.name', root),
    stack: $('.stack', root),
    tag: null,
    cardsKey: '',
    tagKey: '',
    timerKey: '',
  };
}

function markWinningCards(container, v) {
  const showdown = v.phase === 'showdown' && v.result && !v.result.uncontested;
  const winning = new Set(showdown ? v.result.pots.flatMap((p) => p.cards) : []);
  for (const el of container.querySelectorAll('.card')) {
    el.classList.toggle('win', showdown && winning.has(el.dataset.c));
    el.classList.toggle('dim', showdown && !!el.dataset.c && !winning.has(el.dataset.c));
  }
}

function renderBoard(v, newHand) {
  const board = $('#board');
  const shown = [...board.querySelectorAll('.card')].map((c) => c.dataset.c);
  const same = !newHand && shown.every((c, i) => v.board[i] === c);
  if (!same || shown.length !== v.board.length) {
    const keep = same ? shown.length : 0;
    const kids = [];
    v.board.forEach((c, i) => {
      if (i < keep) kids.push(board.children[i]);
      else kids.push(cardEl(c));
    });
    while (kids.length < 5) kids.push(slot());
    board.replaceChildren(...kids);
    v.board.forEach((c, i) => {
      if (i < keep) return;
      const el = board.children[i];
      flip(el, (i - keep) * 110, 420);
      if (!reduceMotion.matches) {
        el.animate([{ translate: '0 -10px', opacity: 0 }, { translate: '0 0', opacity: 1 }], {
          duration: 300, delay: (i - keep) * 110, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'backwards',
        });
      }
    });
  }
  markWinningCards(board, v);
}

function renderCenter(v, me) {
  const pot = $('#pot');
  const total = v.pot + v.players.reduce((s, p) => s + p.bet, 0);
  const showPot = v.phase !== 'waiting' && (v.pot > 0 || total > 0) && !(v.phase === 'showdown');
  pot.classList.toggle('empty', !showPot);
  $('#pot-amount').textContent = fmt(v.pot > 0 ? v.pot : total);

  const name = (id) => `<b>${esc(v.players.find((p) => p.id === id)?.name || '¿?')}</b>`;
  let html = '';
  if (v.phase === 'waiting') {
    const ready = v.players.filter((p) => !p.sittingOut && p.stack > 0 && p.connected).length;
    html = ready < 2
      ? `Esperando jugadores · comparte el código <b>${esc(app.code)}</b>`
      : 'La mano empieza en un momento…';
  } else if (v.phase === 'showdown' && v.result) {
    html = v.result.pots
      .map((pot, i) => {
        const who = pot.winners.map(name).join(' y ');
        const verb = pot.winners.length > 1 ? 'se reparten' : 'gana';
        const label = v.result.pots.length > 1 ? (i === 0 ? 'Bote principal: ' : 'Bote secundario: ') : '';
        return `${label}${who} ${verb} ${fmt(pot.amount)}${pot.hand ? ` con ${esc(pot.hand.toLowerCase())}` : ''}`;
      })
      .join('<br>');
  } else if (v.toAct !== null) {
    const p = v.players.find((q) => q.seat === v.toAct);
    html = p && me && p.id === me.id ? '<b>Tu turno</b>' : p ? `Turno de ${name(p.id)}` : '';
  }
  const status = $('#status');
  if (status.innerHTML !== html) status.innerHTML = html;
}

function renderDock(v, me, newHand) {
  const cards = $('#my-cards');
  const key = me ? `${v.handNo}|${me.hole.join(',')}` : '';
  if (key !== myCardsKey) {
    cards.replaceChildren(...(me ? me.hole.map(cardEl) : []));
    if (newHand && me?.hole.length) [...cards.children].forEach((el, i) => dealFrom(el, $('#board'), 120 + i * 140, { faceUp: true }));
    myCardsKey = key;
  }
  if (me) markWinningCards(cards, v);
  cards.parentElement.classList.toggle('folded', !!me?.folded);
  cards.style.opacity = me?.folded ? 0.4 : '';

  let handName = '';
  if (me?.inHand && me.hole[0] !== '??') {
    handName = me.folded ? 'Te retiraste' : bestHand([...me.hole, ...v.board]).name;
  }
  $('#my-hand-name').textContent = handName;
  $('#my-stack').textContent = me ? `${fmt(me.stack)} fichas` : '';

  renderControls(v, me);
}

function renderControls(v, me) {
  const box = $('#controls');
  const myTurn = me && v.toAct === me.seat && v.phase !== 'showdown';
  let key;
  if (!me) key = 'none';
  else if (myTurn) key = `turn|${v.handNo}|${v.phase}|${v.currentBet}|${me.bet}|${me.stack}`;
  else if (me.stack === 0 && !(me.inHand && !me.folded) && v.phase !== 'showdown') key = 'broke';
  else if (me.sittingOut && !me.inHand) key = 'sitting';
  else key = `wait|${v.phase}|${v.toAct}|${v.players.length}`;
  if (key === controlsKey) return;
  controlsKey = key;

  const inner = document.createElement('div');
  inner.className = 'controls-inner';

  if (!me) {
    inner.innerHTML = '<p class="waiting-text">Conectando…</p>';
  } else if (key === 'broke') {
    inner.innerHTML = `<p class="waiting-text">Te has quedado sin fichas.</p>
      <button class="btn btn-gold" data-do="rebuy">Recomprar ${fmt(v.settings.stack)} fichas</button>`;
  } else if (key === 'sitting') {
    inner.innerHTML = `<p class="waiting-text">Estás levantado. No te repartirán cartas.</p>
      <button class="btn btn-primary" data-do="sit">Volver a la mesa</button>`;
  } else if (myTurn) {
    buildActions(inner, v, me);
  } else {
    let text = '';
    if (v.phase === 'waiting') {
      const alone = v.players.filter((p) => p.connected).length < 2;
      text = alone ? 'Invita a tus amigos para empezar.' : 'Preparando la siguiente mano…';
      inner.innerHTML = `<p class="waiting-text">${text}</p>${alone ? '<button class="btn btn-gold" data-do="invite">Copiar enlace de invitación</button>' : ''}`;
    } else if (v.phase === 'showdown') {
      inner.innerHTML = '<p class="waiting-text">Siguiente mano en unos segundos…</p>';
    } else if (me.inHand && !me.folded) {
      const p = v.players.find((q) => q.seat === v.toAct);
      text = me.allIn ? 'Estás all-in. Que hablen las cartas.' : p ? `Esperando a <b>${esc(p.name)}</b>…` : 'Repartiendo…';
      inner.innerHTML = `<p class="waiting-text">${text}</p>`;
    } else {
      inner.innerHTML = `<p class="waiting-text">${me.inHand ? 'Te retiraste. Esperando a la próxima mano.' : 'Entrarás en la próxima mano.'}</p>`;
    }
  }
  box.replaceChildren(inner);
}

function buildActions(inner, v, me) {
  const toCall = Math.max(0, v.currentBet - me.bet);
  const maxTo = me.bet + me.stack;
  const othersCanAct = v.players.some((p) => p.id !== me.id && p.inHand && !p.folded && !p.allIn);
  const canRaise = !me.acted && maxTo > v.currentBet && othersCanAct;
  const minTo = Math.min(v.currentBet + v.minRaise, maxTo);
  const potTotal = v.pot + v.players.reduce((s, p) => s + p.bet, 0);
  const opening = v.currentBet === 0;
  const step = v.settings.sb;
  const clamp = (n) => Math.max(minTo, Math.min(maxTo, Math.round(n / step) * step || minTo));

  const callAll = toCall >= me.stack;
  inner.innerHTML = `
    ${canRaise && maxTo > minTo ? `
    <div class="raise-row">
      <div class="presets">
        <button type="button" data-to="${minTo}">Mín</button>
        <button type="button" data-to="${clamp(v.currentBet + (potTotal + toCall) / 2)}">½ bote</button>
        <button type="button" data-to="${clamp(v.currentBet + potTotal + toCall)}">Bote</button>
        <button type="button" data-to="${maxTo}">All-in</button>
      </div>
      <input class="slider" type="range" min="${minTo}" max="${maxTo}" step="${step}" value="${minTo}" aria-label="Cantidad" />
    </div>` : ''}
    <div class="actions">
      <button class="btn btn-dark" data-act="fold" ${toCall === 0 ? 'disabled' : ''}>Retirarse <span class="kbd">F</span></button>
      <button class="btn btn-primary" data-act="${toCall ? 'call' : 'check'}">
        ${toCall ? (callAll ? `All-in <small>${fmt(me.stack)}</small>` : `Igualar <small>${fmt(toCall)}</small>`) : 'Pasar'} <span class="kbd">C</span>
      </button>
      <button class="btn btn-gold" data-act="raise" ${canRaise ? '' : 'disabled'}>
        <span class="raise-label"></span> <span class="kbd">R</span>
      </button>
    </div>`;

  const slider = $('.slider', inner);
  const raiseBtn = $('[data-act="raise"]', inner);
  let amount = minTo;
  const setAmount = (n) => {
    amount = Math.max(minTo, Math.min(maxTo, n));
    if (slider) {
      slider.value = amount;
      slider.style.setProperty('--fill', ((amount - minTo) / Math.max(1, maxTo - minTo)) * 100 + '%');
    }
    const label = amount >= maxTo ? `All-in <small>${fmt(maxTo)}</small>` : `${opening ? 'Apostar' : 'Subir a'} <small>${fmt(amount)}</small>`;
    $('.raise-label', raiseBtn).innerHTML = canRaise ? label : 'Subir';
  };
  setAmount(minTo);
  slider?.addEventListener('input', () => setAmount(Number(slider.value)));
  inner.querySelectorAll('[data-to]').forEach((b) => b.addEventListener('click', () => setAmount(Number(b.dataset.to))));
  raiseBtn.dataset.amount = '';
  raiseBtn.addEventListener('click', () => act(amount >= maxTo ? 'allin' : 'raise', amount));
  inner.querySelectorAll('[data-act]:not([data-act="raise"])').forEach((b) =>
    b.addEventListener('click', () => act(b.dataset.act)));
}

function act(action, amount) {
  for (const b of document.querySelectorAll('#controls button')) b.disabled = true;
  send({ t: 'act', action, amount });
}

function renderTopbar(v, me) {
  $('#blinds-label').textContent = `Ciegas ${fmt(v.settings.sb)}/${fmt(v.settings.bb)}`;
  const sit = $('#sit-toggle');
  sit.hidden = !me || me.stack === 0;
  sit.textContent = me?.sittingOut ? 'Sentarme' : 'Levantarme';
}

function celebrate(v, potPoint) {
  if (v.result.uncontested) return;
  v.result.pots.forEach((pot, i) => {
    for (const id of pot.winners) {
      const to = seatPoint(id);
      if (!to) continue;
      for (let k = 0; k < 4; k++) flyChip(potPoint, to, 500 + i * 450 + k * 70);
    }
  });
  for (const p of v.players) {
    if (p.won <= 0) continue;
    const to = seatPoint(p.id);
    if (!to) continue;
    const n = document.createElement('div');
    n.className = 'float-win';
    n.textContent = '+' + fmt(p.won);
    n.style.left = to.x + 'px';
    n.style.top = to.y - 34 + 'px';
    $('#table').append(n);
    const frames = reduceMotion.matches
      ? [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }]
      : [
          { opacity: 0, translate: '0 8px' },
          { opacity: 1, translate: '0 0', offset: 0.2 },
          { opacity: 1, translate: '0 -10px', offset: 0.8 },
          { opacity: 0, translate: '0 -16px' },
        ];
    n.animate(frames, { duration: 2200, delay: 900, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'both' }).onfinish = () => n.remove();
  }
}

// ---------- invite ----------

async function invite() {
  const url = `${location.origin}${location.pathname}#${app.code}`;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ title: 'Flop · Póker', text: `Únete a mi mesa de póker (código ${app.code})`, url });
      return;
    } catch (e) {
      if (e?.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Enlace copiado. Pásaselo a tus amigos.');
  } catch {
    toast(`Comparte este enlace: ${url}`);
  }
}

// ---------- lobby ----------

function initLobby() {
  const form = $('#lobby-form');
  const nameInput = $('#name');
  const codeInput = $('#code');
  const seg = $('.segmented');
  const submit = $('#lobby-submit .btn-label');
  const hint = $('#lobby-hint');
  nameInput.value = store.get('flop:name') || '';

  const setTab = (tab) => {
    seg.dataset.value = tab;
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    for (const p of form.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab;
    submit.textContent = tab === 'create' ? 'Crear mesa' : 'Entrar a la mesa';
    hint.textContent = tab === 'create'
      ? 'Tu navegador hará de crupier automático: tú juegas igual que los demás.'
      : 'Pídele el código o el enlace a quien creó la mesa.';
  };
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) setTab(b.dataset.tab);
  });

  for (const group of form.querySelectorAll('.chips')) {
    group.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      for (const x of group.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    });
  }

  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    unlockAudio();
    const name = nameInput.value.trim();
    if (!name) return nameInput.focus();
    store.set('flop:name', name);
    if (!window.Peer) return toast('No se pudo cargar el módulo de conexión. Recarga la página.', 'error');

    if (seg.dataset.value === 'create') {
      const pick = (n) => form.querySelector(`.chips[data-name="${n}"] [aria-pressed="true"]`).dataset.v;
      const [sb, bb] = pick('blinds').split('/').map(Number);
      startHost(name, { stack: Number(pick('stack')), sb, bb, turnTime: Number(pick('turnTime')) });
    } else {
      const code = codeInput.value.trim();
      if (code.length !== 5) {
        toast('El código tiene 5 caracteres.', 'error');
        return codeInput.focus();
      }
      startGuest(name, code);
    }
  });

  const fromHash = () => {
    const code = location.hash.slice(1).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    if (code.length !== 5 || app.role) return;
    const name = store.get('flop:name');
    const role = store.get('flop:role:' + code);
    const snapshot = store.get('flop:host:' + code);
    // Reloaded mid-game: pick up where we left off
    if (name && role === 'host' && snapshot) {
      try {
        return startHost(name, null, code, JSON.parse(snapshot));
      } catch {
        store.del('flop:host:' + code);
      }
    }
    if (name && role === 'guest') return startGuest(name, code);
    setTab('join');
    codeInput.value = code;
    (name ? $('#lobby-submit') : nameInput).focus();
  };
  window.addEventListener('hashchange', fromHash);
  // PeerJS loads with `defer`; wait for it before auto-resuming
  if (document.readyState === 'complete') fromHash();
  else window.addEventListener('load', fromHash, { once: true });
}

// ---------- game chrome ----------

function initGame() {
  $('#invite').addEventListener('click', invite);
  $('#leave').addEventListener('click', () => {
    const others = lastView?.players.filter((p) => p.id !== app.myId && p.connected).length;
    if (app.role === 'host' && others && !confirm('Eres el anfitrión: si sales, la mesa se cierra para todos. ¿Salir?')) return;
    exitGame(true);
  });
  $('#sit-toggle').addEventListener('click', () => {
    const me = lastView?.players.find((p) => p.id === lastView.you);
    if (me) send({ t: 'sit', sit: me.sittingOut });
  });
  $('#controls').addEventListener('click', (e) => {
    const b = e.target.closest('[data-do]');
    if (!b) return;
    if (b.dataset.do === 'invite') invite();
    if (b.dataset.do === 'rebuy') send({ t: 'rebuy' });
    if (b.dataset.do === 'sit') send({ t: 'sit', sit: true });
  });

  // Keyboard shortcuts when it's your turn (no animation on these, by design)
  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input:not([type="range"]), textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const map = { f: '[data-act="fold"]', c: '[data-act="call"], [data-act="check"]', r: '[data-act="raise"]' };
    const sel = map[e.key.toLowerCase()];
    const btn = sel && $('#controls').querySelector(sel);
    if (btn && !btn.disabled) {
      e.preventDefault();
      btn.click();
    }
  });

  document.addEventListener('pointerdown', unlockAudio, { passive: true });

  window.addEventListener('beforeunload', (e) => {
    if (app.role !== 'host') return;
    const others = lastView?.players.some((p) => p.id !== app.myId && p.connected);
    if (others) e.preventDefault();
  });

  // Keep layout-dependent positions honest after rotation/resizes
  window.addEventListener('resize', () => {
    for (const el of document.querySelectorAll('.flying-chip, .float-win')) el.remove();
  });
}

initLobby();
initGame();
