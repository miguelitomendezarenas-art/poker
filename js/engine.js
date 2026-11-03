// Authoritative Texas Hold'em table. Runs only in the host's browser and acts as the dealer.
import { newDeck, bestHand, compareScores } from './cards.js';

export const MAX_SEATS = 8;
const STREETS = ['preflop', 'flop', 'turn', 'river'];
const NEXT_HAND_DELAY = 6000;
const UNCONTESTED_DELAY = 3200;
const STREET_DELAY = 750;
const RUNOUT_DELAY = 1300;

const randomId = (len = 10) => {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => abc[b % abc.length]).join('');
};

export class Table {
  constructor(settings, onChange) {
    this.settings = settings; // { stack, sb, bb, turnTime }
    this.onChange = onChange;
    this.players = [];
    this.tokens = {}; // secret token -> public player id
    this.dealerSeat = -1;
    this.phase = 'waiting';
    this.board = [];
    this.deck = [];
    this.currentBet = 0;
    this.minRaise = 0;
    this.toAct = null;
    this.turnDeadline = 0;
    this.result = null;
    this.handNo = 0;
    this.timers = {};
  }

  // ---------- persistence ----------

  snapshot() {
    const { onChange, timers, ...data } = this;
    return JSON.parse(JSON.stringify(data));
  }

  static restore(data, onChange) {
    const t = new Table(data.settings, onChange);
    Object.assign(t, data, { onChange, timers: {} });
    for (const p of t.players) p.connected = false;
    if (STREETS.includes(t.phase) && t.toAct !== null) {
      const p = t.bySeat(t.toAct);
      if (p) t.setTurn(p);
      else t.endStreet();
    } else if (t.phase === 'showdown') {
      t.later('next', () => t.startHand(), NEXT_HAND_DELAY);
    } else if (STREETS.includes(t.phase)) {
      t.endStreet();
    } else {
      t.maybeStart();
    }
    return t;
  }

  // ---------- helpers ----------

  later(key, fn, ms) {
    clearTimeout(this.timers[key]);
    this.timers[key] = setTimeout(fn, ms);
  }

  stopTimers() {
    for (const k in this.timers) clearTimeout(this.timers[k]);
  }

  changed() {
    this.onChange?.();
  }

  byId(id) {
    return this.players.find((p) => p.id === id);
  }

  bySeat(seat) {
    return this.players.find((p) => p.seat === seat);
  }

  // Players in seat order, starting with the first seat after `seat`
  orderAfter(seat, list = this.players) {
    const sorted = [...list].sort((a, b) => a.seat - b.seat);
    const i = sorted.findIndex((p) => p.seat > seat);
    return i === -1 ? sorted : [...sorted.slice(i), ...sorted.slice(0, i)];
  }

  inHand(p) {
    return p.hole.length > 0 && !p.folded;
  }

  canAct(p) {
    return this.inHand(p) && !p.allIn;
  }

  needsAction(p) {
    if (!this.canAct(p)) return false;
    if (p.acted && p.bet >= this.currentBet) return false;
    // Nobody left to bet against: a lone player who has matched the bet is done
    const others = this.players.filter((q) => q !== p && this.canAct(q));
    if (others.length === 0 && p.bet >= this.currentBet) return false;
    return true;
  }

  get pot() {
    return this.players.reduce((sum, p) => sum + p.total - p.bet, 0);
  }

  get isPlaying() {
    return STREETS.includes(this.phase);
  }

  // ---------- seating ----------

  join(token, name) {
    name = String(name || '').trim().slice(0, 16) || 'Jugador';
    const known = this.tokens[token] && this.byId(this.tokens[token]);
    if (known) {
      known.name = name;
      known.connected = true;
      if (known.autoSitOut) {
        known.sittingOut = false;
        known.autoSitOut = false;
      }
      this.maybeStart();
      this.changed();
      return { id: known.id };
    }
    const taken = new Set(this.players.map((p) => p.seat));
    let seat = -1;
    for (let s = 0; s < MAX_SEATS; s++) if (!taken.has(s)) { seat = s; break; }
    if (seat === -1) return { error: 'La mesa está llena (máximo 8 jugadores).' };

    const id = randomId(8);
    this.tokens[token] = id;
    this.players.push({
      id, name, seat,
      stack: this.settings.stack,
      bet: 0, total: 0, hole: [],
      folded: false, allIn: false, acted: false,
      sittingOut: false, autoSitOut: false, connected: true,
      lastAction: null, shown: false, hand: null, won: 0, leaving: false,
    });
    this.maybeStart();
    this.changed();
    return { id };
  }

  setConnected(id, connected) {
    const p = this.byId(id);
    if (!p || p.connected === connected) return;
    p.connected = connected;
    this.changed();
  }

  handle(id, msg) {
    const p = this.byId(id);
    if (!p || !msg) return;
    switch (msg.t) {
      case 'act': return this.act(p, msg.action, msg.amount);
      case 'sit':
        p.sittingOut = !msg.sit;
        p.autoSitOut = false;
        this.maybeStart();
        return this.changed();
      case 'rebuy':
        if (p.stack > 0 || this.inHand(p)) return;
        p.stack = this.settings.stack;
        p.sittingOut = false;
        this.maybeStart();
        return this.changed();
      case 'leave':
        return this.leave(p);
    }
  }

  leave(p) {
    p.leaving = true;
    p.connected = false;
    if (this.isPlaying && this.inHand(p)) {
      p.folded = true;
      p.lastAction = { type: 'fold' };
      if (this.toAct === p.seat) return this.afterAction(p.seat);
      const live = this.players.filter((q) => this.inHand(q));
      if (live.length === 1) return this.winUncontested(live[0]);
      return this.changed();
    }
    if (!this.isPlaying) this.removeLeavers();
    this.changed();
  }

  removeLeavers() {
    this.players = this.players.filter((p) => !p.leaving);
    for (const [tok, id] of Object.entries(this.tokens)) {
      if (!this.byId(id)) delete this.tokens[tok];
    }
  }

  // ---------- hand flow ----------

  readyPlayers() {
    return this.players.filter((p) => !p.sittingOut && !p.leaving && p.stack > 0);
  }

  maybeStart() {
    if (this.isPlaying) return;
    if (this.phase === 'showdown') return; // next hand is already scheduled
    if (this.readyPlayers().length >= 2) this.later('next', () => this.startHand(), 2500);
    else clearTimeout(this.timers.next);
  }

  startHand() {
    if (this.isPlaying) return; // never reset a hand that still holds chips
    this.removeLeavers();
    // Disconnected players sit out until they come back
    for (const p of this.players) {
      if (!p.connected && !p.sittingOut) {
        p.sittingOut = true;
        p.autoSitOut = true;
      }
    }
    const ready = this.readyPlayers();
    for (const p of this.players) {
      Object.assign(p, {
        bet: 0, total: 0, hole: [], folded: false, allIn: false, acted: false,
        lastAction: null, shown: false, hand: null, won: 0,
      });
    }
    if (ready.length < 2) {
      this.phase = 'waiting';
      this.toAct = null;
      this.board = [];
      return this.changed();
    }

    this.handNo++;
    this.result = null;
    this.deck = newDeck();
    this.board = [];
    this.dealerSeat = this.orderAfter(this.dealerSeat, ready)[0].seat;

    const order = this.orderAfter(this.dealerSeat, ready); // dealer is last
    const headsUp = ready.length === 2;
    const sb = headsUp ? order[1] : order[0];
    const bb = headsUp ? order[0] : order[1];
    this.post(sb, this.settings.sb, 'sb');
    this.post(bb, this.settings.bb, 'bb');
    this.currentBet = this.settings.bb;
    this.minRaise = this.settings.bb;

    for (let round = 0; round < 2; round++) for (const p of order) p.hole.push(this.deck.pop());

    this.phase = 'preflop';
    const first = this.nextActor(bb.seat);
    if (first) this.setTurn(first);
    else this.endStreet();
    this.changed();
  }

  post(p, amount, type) {
    const a = Math.min(amount, p.stack);
    p.stack -= a;
    p.bet += a;
    p.total += a;
    if (p.stack === 0) p.allIn = true;
    p.lastAction = { type, amount: a };
  }

  nextActor(afterSeat) {
    return this.orderAfter(afterSeat).find((p) => this.needsAction(p)) || null;
  }

  setTurn(p) {
    this.toAct = p.seat;
    const ms = this.settings.turnTime * 1000;
    this.turnDeadline = Date.now() + ms;
    this.later('turn', () => this.timeout(p.id), ms);
  }

  timeout(id) {
    const p = this.byId(id);
    if (!p || this.toAct !== p.seat || !this.isPlaying) return;
    if (!p.connected) {
      p.sittingOut = true;
      p.autoSitOut = true;
    }
    this.act(p, p.bet >= this.currentBet ? 'check' : 'fold');
  }

  act(p, action, amount) {
    if (!this.isPlaying || this.toAct !== p.seat) return;
    const toCall = this.currentBet - p.bet;
    const maxTo = p.bet + p.stack;

    if (action === 'allin') {
      action = maxTo > this.currentBet && !p.acted ? 'raise' : 'call';
      amount = maxTo;
    }

    switch (action) {
      case 'fold':
        if (toCall <= 0) return this.act(p, 'check'); // never fold for free
        p.folded = true;
        p.lastAction = { type: 'fold' };
        break;
      case 'check':
        if (toCall > 0) return;
        p.lastAction = { type: 'check' };
        break;
      case 'call': {
        if (toCall <= 0) return this.act(p, 'check');
        const a = Math.min(toCall, p.stack);
        this.put(p, a);
        p.lastAction = { type: p.allIn ? 'allin' : 'call', amount: p.bet };
        break;
      }
      case 'raise': {
        if (p.acted) return; // an incomplete all-in raise doesn't reopen the action
        let to = Math.min(Math.floor(Number(amount) || 0), maxTo);
        if (to <= this.currentBet) return this.act(p, 'call');
        const minTo = this.currentBet + this.minRaise;
        if (to < minTo && to < maxTo) return;
        const opening = this.currentBet === 0;
        const raiseBy = to - this.currentBet;
        this.put(p, to - p.bet);
        if (raiseBy >= this.minRaise) {
          this.minRaise = raiseBy;
          for (const q of this.players) if (q !== p && this.canAct(q)) q.acted = false;
        }
        this.currentBet = to;
        p.lastAction = { type: p.allIn ? 'allin' : opening ? 'bet' : 'raise', amount: to };
        break;
      }
      default:
        return;
    }
    p.acted = true;
    this.afterAction(p.seat);
  }

  put(p, a) {
    p.stack -= a;
    p.bet += a;
    p.total += a;
    if (p.stack === 0) p.allIn = true;
  }

  afterAction(seat) {
    clearTimeout(this.timers.turn);
    const live = this.players.filter((p) => this.inHand(p));
    if (live.length === 1) return this.winUncontested(live[0]);
    const next = this.nextActor(seat);
    if (next) {
      this.setTurn(next);
      return this.changed();
    }
    this.endStreet();
  }

  // Betting round closed: sweep bets into the pot, then deal the next street
  endStreet() {
    clearTimeout(this.timers.turn);
    this.toAct = null;
    for (const p of this.players) {
      p.bet = 0;
      p.acted = false;
      if (this.canAct(p)) p.lastAction = null;
    }
    this.currentBet = 0;
    this.minRaise = this.settings.bb;
    this.changed();

    const runout = this.players.filter((p) => this.canAct(p)).length <= 1;
    this.later('street', () => this.dealNext(), runout ? RUNOUT_DELAY : STREET_DELAY);
  }

  dealNext() {
    if (this.phase === 'river') return this.showdown();
    this.deck.pop(); // burn
    if (this.phase === 'preflop') {
      this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.phase = 'flop';
    } else {
      this.board.push(this.deck.pop());
      this.phase = this.phase === 'flop' ? 'turn' : 'river';
    }
    const first = this.nextActor(this.dealerSeat);
    if (first) {
      this.setTurn(first);
      this.changed();
    } else {
      this.endStreet();
    }
  }

  winUncontested(winner) {
    clearTimeout(this.timers.turn);
    const amount = this.players.reduce((s, p) => s + p.total, 0);
    winner.stack += amount;
    winner.won = amount;
    for (const p of this.players) p.bet = 0;
    this.toAct = null;
    this.phase = 'showdown';
    this.result = { uncontested: true, pots: [{ amount, winners: [winner.id], hand: null, cards: [] }] };
    this.changed();
    this.later('next', () => this.startHand(), UNCONTESTED_DELAY);
  }

  showdown() {
    this.toAct = null;
    this.phase = 'showdown';
    const live = this.players.filter((p) => this.inHand(p));
    for (const p of live) {
      const best = bestHand([...p.hole, ...this.board]);
      p.shown = true;
      p.hand = best;
    }

    // Side pots: one layer per distinct all-in level among live players
    const levels = [...new Set(live.map((p) => p.total))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const level of levels) {
      let amount = 0;
      for (const p of this.players) amount += Math.max(0, Math.min(p.total, level) - prev);
      const eligible = live.filter((p) => p.total >= level);
      prev = level;
      if (amount > 0) pots.push({ amount, eligible });
    }
    // Chips from folded players above the top live level go to the last pot
    const leftover = this.players.reduce((s, p) => s + Math.max(0, p.total - prev), 0);
    if (leftover && pots.length) pots[pots.length - 1].amount += leftover;

    const resultPots = [];
    for (const pot of pots) {
      let winners = [];
      for (const p of pot.eligible) {
        const cmp = winners.length ? compareScores(p.hand.score, winners[0].hand.score) : 1;
        if (cmp > 0) winners = [p];
        else if (cmp === 0) winners.push(p);
      }
      if (pot.eligible.length === 1 && resultPots.length) {
        // Uncalled excess goes straight back; don't present it as a won pot
        winners[0].stack += pot.amount;
        continue;
      }
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      for (const w of this.orderAfter(this.dealerSeat, winners)) {
        const extra = remainder > 0 ? 1 : 0;
        remainder -= extra;
        w.stack += share + extra;
        w.won += share + extra;
      }
      resultPots.push({
        amount: pot.amount,
        winners: winners.map((w) => w.id),
        hand: winners[0].hand.name,
        cards: [...new Set(winners.flatMap((w) => w.hand.cards))],
      });
    }
    this.result = { uncontested: false, pots: resultPots };
    this.changed();
    this.later('next', () => this.startHand(), NEXT_HAND_DELAY);
  }

  // ---------- per-player view (hides other players' hole cards) ----------

  view(forId) {
    return {
      phase: this.phase,
      handNo: this.handNo,
      board: this.board,
      dealerSeat: this.dealerSeat,
      toAct: this.toAct,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      turnRemaining: this.toAct === null ? 0 : Math.max(0, this.turnDeadline - Date.now()),
      settings: this.settings,
      pot: this.pot,
      result: this.result,
      you: forId,
      players: this.players
        .filter((p) => !p.leaving || this.inHand(p))
        .map((p) => {
          const visible = p.id === forId || p.shown;
          return {
            id: p.id,
            name: p.name,
            seat: p.seat,
            stack: p.stack,
            bet: p.bet,
            folded: p.folded,
            allIn: p.allIn,
            acted: p.acted,
            sittingOut: p.sittingOut,
            connected: p.connected,
            lastAction: p.lastAction,
            inHand: p.hole.length > 0,
            hole: visible ? p.hole : p.hole.map(() => '??'),
            hand: p.shown && p.hand ? p.hand.name : null,
            won: p.won,
          };
        }),
    };
  }
}
