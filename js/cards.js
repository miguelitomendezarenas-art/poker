export const RANKS = '23456789TJQKA';
export const SUITS = 'shdc';
export const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
export const RANK_LABEL = { T: '10' };

const PLURAL = {
  14: 'Ases', 13: 'Reyes', 12: 'Damas', 11: 'Jotas', 10: 'Dieces', 9: 'Nueves',
  8: 'Ochos', 7: 'Sietes', 6: 'Seises', 5: 'Cincos', 4: 'Cuatros', 3: 'Treses', 2: 'Doses',
};
const SINGULAR = {
  14: 'As', 13: 'Rey', 12: 'Dama', 11: 'Jota', 10: '10', 9: '9', 8: '8',
  7: '7', 6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
};

const value = (card) => RANKS.indexOf(card[0]) + 2;

// Unbiased random integer in [0, n) using the Web Crypto API
function randInt(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % n;
}

export function newDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Score a 5-card hand as [category, ...tiebreakers]; higher compares better
function score5(cards) {
  const vals = cards.map(value).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  let straightHigh = 0;
  if (new Set(vals).size === 5) {
    if (vals[0] - vals[4] === 4) straightHigh = vals[0];
    else if (vals[0] === 14 && vals[1] === 5) straightHigh = 5; // A-2-3-4-5
  }
  const counts = new Map();
  for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const byGroup = groups.map((g) => g[0]);

  if (straightHigh && flush) return [8, straightHigh];
  if (groups[0][1] === 4) return [7, ...byGroup];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, ...byGroup];
  if (flush) return [5, ...vals];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][1] === 3) return [3, ...byGroup];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, ...byGroup];
  if (groups[0][1] === 2) return [1, ...byGroup];
  return [0, ...vals];
}

export function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

export function handName(score) {
  const [cat, a, b] = score;
  switch (cat) {
    case 8: return a === 14 ? 'Escalera real' : `Escalera de color al ${SINGULAR[a]}`;
    case 7: return `Póker de ${PLURAL[a]}`;
    case 6: return `Full de ${PLURAL[a]} y ${PLURAL[b]}`;
    case 5: return `Color al ${SINGULAR[a]}`;
    case 4: return `Escalera al ${SINGULAR[a]}`;
    case 3: return `Trío de ${PLURAL[a]}`;
    case 2: return `Doble pareja, ${PLURAL[a]} y ${PLURAL[b]}`;
    case 1: return `Pareja de ${PLURAL[a]}`;
    default: return `Carta alta, ${SINGULAR[a]}`;
  }
}

// Best 5-card hand out of 2–7 cards
export function bestHand(cards) {
  if (cards.length < 5) {
    // Preflop/partial: describe what's there (pair or high card)
    const vals = cards.map(value).sort((a, b) => b - a);
    const pair = vals.length === 2 && vals[0] === vals[1];
    const score = pair ? [1, vals[0]] : [0, ...vals];
    return { score, cards: [...cards], name: handName(score) };
  }
  let best = null;
  let bestCards = null;
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const hand = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const s = score5(hand);
            if (!best || compareScores(s, best) > 0) {
              best = s;
              bestCards = hand;
            }
          }
  return { score: best, cards: bestCards, name: handName(best) };
}
