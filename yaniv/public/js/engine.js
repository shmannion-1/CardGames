/*
 * Yaniv rules engine.
 *
 * Pure game logic with no DOM access, so the same file can run in the browser,
 * in Node tests, and later on a server for online play (the server would own
 * the state and clients would only send actions).
 *
 * State is a plain JSON-serialisable object. Every action function takes the
 * state, validates the move, mutates the state, and returns it. Illegal moves
 * throw a YanivError so the UI (or a server) can reject them cleanly.
 */
(function (root) {
  'use strict';

  var SUITS = ['S', 'H', 'D', 'C']; // spades, hearts, diamonds, clubs
  var RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]; // A..K

  var DEFAULT_RULES = {
    handSize: 5,          // cards dealt to each player
    yanivMax: 7,          // you may call Yaniv when your hand totals this or less
    assafPenalty: 30,     // added to the caller's hand total when someone ties or beats them
    eliminateAbove: 200,  // a score strictly above this knocks you out
    fiftyRule: 'subtract',// landing exactly on 50/100/150...: 'subtract' 50, 'halve', or 'none'
    minRun: 3,            // shortest same-suit run you may discard
    slapDown: true,       // drawing a card of the rank you just discarded lets you throw it straight away
    noYanivFirstTurn: false // if true, nobody may call Yaniv before everyone has had one turn
  };

  function YanivError(msg) { this.name = 'YanivError'; this.message = msg; this.stack = (new Error(msg)).stack; }
  YanivError.prototype = Object.create(Error.prototype);

  // ---------- cards ----------

  function cardId(suit, rank) { return rankLabel(rank) + suit; }
  function rankLabel(rank) { return ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' })[rank] || String(rank); }
  function cardValue(card) { return card.rank > 10 ? 10 : card.rank; }
  function handValue(hand) { var t = 0; for (var i = 0; i < hand.length; i++) t += cardValue(hand[i]); return t; }

  function newDeck() {
    var d = [];
    for (var s = 0; s < SUITS.length; s++)
      for (var r = 0; r < RANKS.length; r++)
        d.push({ id: cardId(SUITS[s], RANKS[r]), suit: SUITS[s], rank: RANKS[r] });
    return d;
  }

  // Small seedable PRNG (mulberry32) so games and tests are reproducible.
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // The RNG position is kept in state.rngState so a saved game resumes identically.
  function rand(state) {
    var r = makeRng(state.rngState)();
    state.rngState = (state.rngState + 0x6D2B79F5) >>> 0;
    return r;
  }
  function shuffle(state, arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rand(state) * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // ---------- discard validation ----------

  // Returns {type:'single'|'set'|'run', cards:[sorted]} or null if not a legal discard.
  function classifyGroup(cards, rules) {
    rules = rules || DEFAULT_RULES;
    if (!cards || cards.length === 0) return null;
    if (cards.length === 1) return { type: 'single', cards: cards.slice() };
    var sameRank = cards.every(function (c) { return c.rank === cards[0].rank; });
    if (sameRank) return { type: 'set', cards: cards.slice() };
    if (cards.length < rules.minRun) return null;
    var sameSuit = cards.every(function (c) { return c.suit === cards[0].suit; });
    if (!sameSuit) return null;
    var sorted = cards.slice().sort(function (a, b) { return a.rank - b.rank; });
    for (var i = 1; i < sorted.length; i++) if (sorted[i].rank !== sorted[i - 1].rank + 1) return null;
    return { type: 'run', cards: sorted }; // Ace is low only: A-2-3 is a run, Q-K-A is not
  }

  // Cards a player may pick up from a discarded group: any card of a set, only the ends of a run.
  function pickableFrom(group) {
    if (!group) return [];
    if (group.type === 'run') return [group.cards[0], group.cards[group.cards.length - 1]];
    return group.cards.slice();
  }

  // Every legal discard from a hand (used by the AI and for UI hints).
  function allDiscards(hand, rules) {
    rules = rules || DEFAULT_RULES;
    var out = [];
    var i, j;
    for (i = 0; i < hand.length; i++) out.push([hand[i]]);
    // sets: every subset of size >= 2 of each rank
    var byRank = {};
    hand.forEach(function (c) { (byRank[c.rank] = byRank[c.rank] || []).push(c); });
    Object.keys(byRank).forEach(function (r) {
      var g = byRank[r];
      var n = g.length;
      for (var mask = 1; mask < (1 << n); mask++) {
        var sub = g.filter(function (_, k) { return mask & (1 << k); });
        if (sub.length >= 2) out.push(sub);
      }
    });
    // runs: every consecutive window of length >= minRun in each suit
    var bySuit = {};
    hand.forEach(function (c) { (bySuit[c.suit] = bySuit[c.suit] || []).push(c); });
    Object.keys(bySuit).forEach(function (s) {
      var g = bySuit[s].slice().sort(function (a, b) { return a.rank - b.rank; });
      for (i = 0; i < g.length; i++) {
        var run = [g[i]];
        for (j = i + 1; j < g.length && g[j].rank === run[run.length - 1].rank + 1; j++) {
          run.push(g[j]);
          if (run.length >= rules.minRun) out.push(run.slice());
        }
      }
    });
    return out;
  }

  // ---------- game setup ----------

  /*
   * players: [{name, type:'human'|'cpu', level?:'easy'|'normal'|'hard'}]
   */
  function newGame(players, rules, seed) {
    if (!players || players.length < 2 || players.length > 8) throw new YanivError('Yaniv needs 2 to 8 players.');
    var r = {};
    Object.keys(DEFAULT_RULES).forEach(function (k) { r[k] = DEFAULT_RULES[k]; });
    if (rules) Object.keys(rules).forEach(function (k) { r[k] = rules[k]; });
    if (players.length * r.handSize > 40) throw new YanivError('Too many cards per hand for this many players.');
    var state = {
      version: 1,
      rules: r,
      rngState: (seed == null ? Math.floor(Math.random() * 4294967296) : seed) >>> 0,
      players: players.map(function (p, i) {
        return { id: i, name: p.name || ('Player ' + (i + 1)), type: p.type || 'human', level: p.level || 'normal',
                 hand: [], score: 0, out: false, known: [] };
      }),
      round: 0,
      dealer: -1,
      starter: 0,
      deck: [], discard: [], buried: [],
      turn: 0, phase: 'idle', turnsTaken: 0,
      pending: null,      // group discarded this turn, waiting for the draw
      slap: null,         // {playerId, cardId} when a slap-down is on offer
      lastAction: null,
      roundResult: null,
      history: [],        // per-round score deltas
      winner: null
    };
    startRound(state, 0);
    return state;
  }

  function activePlayers(state) { return state.players.filter(function (p) { return !p.out; }); }

  function nextActive(state, from) {
    var n = state.players.length;
    for (var k = 1; k <= n; k++) {
      var i = (from + k) % n;
      if (!state.players[i].out) return i;
    }
    return from;
  }

  function startRound(state, starter) {
    state.round += 1;
    state.deck = shuffle(state, newDeck());
    state.discard = []; state.buried = [];
    state.players.forEach(function (p) { p.hand = []; p.known = []; });
    for (var c = 0; c < state.rules.handSize; c++)
      state.players.forEach(function (p) { if (!p.out) p.hand.push(state.deck.pop()); });
    state.discard.push({ type: 'single', cards: [state.deck.pop()], by: null });
    if (state.players[starter].out) starter = nextActive(state, starter);
    state.starter = starter;
    state.turn = starter;
    state.phase = 'discard';
    state.turnsTaken = 0;
    state.pending = null; state.slap = null; state.roundResult = null;
    state.lastAction = { type: 'deal', round: state.round };
    return state;
  }

  // ---------- turn actions ----------

  function current(state) { return state.players[state.turn]; }

  function takeFromHand(player, ids) {
    var cards = ids.map(function (id) {
      var c = player.hand.find(function (h) { return h.id === id; });
      if (!c) throw new YanivError('You do not hold ' + id + '.');
      return c;
    });
    if (new Set(ids).size !== ids.length) throw new YanivError('Duplicate card in discard.');
    return cards;
  }

  function canCallYaniv(state, playerId) {
    if (state.phase !== 'discard' || state.turn !== playerId) return false;
    if (state.players[playerId].hand.length === 0) return true;
    if (state.rules.noYanivFirstTurn && state.turnsTaken < activePlayers(state).length) return false;
    return handValue(state.players[playerId].hand) <= state.rules.yanivMax;
  }

  function discard(state, playerId, cardIds) {
    if (state.phase === 'slap' && state.slap && state.slap.playerId !== playerId) passSlap(state);
    if (state.phase !== 'discard') throw new YanivError('Not time to discard.');
    if (state.turn !== playerId) throw new YanivError('Not your turn.');
    var p = current(state);
    var cards = takeFromHand(p, cardIds);
    var group = classifyGroup(cards, state.rules);
    if (!group) throw new YanivError('Discard one card, a set of the same rank, or a run of ' + state.rules.minRun + '+ in one suit.');
    p.hand = p.hand.filter(function (c) { return cardIds.indexOf(c.id) < 0; });
    p.known = p.known.filter(function (c) { return cardIds.indexOf(c.id) < 0; });
    group.by = playerId;
    state.pending = group;
    state.phase = 'draw';
    state.lastAction = { type: 'discard', player: playerId, group: group };
    return state;
  }

  function refillDeck(state) {
    if (state.deck.length > 0) return;
    // Everything under the top group goes back in the deck.
    var pool = state.buried.slice();
    for (var i = 0; i < state.discard.length - 1; i++) pool = pool.concat(state.discard[i].cards);
    state.discard = state.discard.slice(-1);
    state.buried = [];
    state.deck = shuffle(state, pool);
    state.lastAction = { type: 'reshuffle' };
  }

  // source: 'deck' or a card id from the top discard group.
  function draw(state, playerId, source) {
    if (state.phase !== 'draw') throw new YanivError('Discard first, then draw.');
    if (state.turn !== playerId) throw new YanivError('Not your turn.');
    var p = current(state);
    var top = state.discard[state.discard.length - 1];
    var drawn, fromPile = false;
    if (source === 'deck') {
      refillDeck(state);
      if (state.deck.length === 0) throw new YanivError('No cards left to draw.');
      drawn = state.deck.pop();
    } else {
      var options = pickableFrom(top);
      drawn = options.find(function (c) { return c.id === source; });
      if (!drawn) throw new YanivError('You can only take a card from the top of the discard pile (the end of a run).');
      fromPile = true;
      top.cards = top.cards.filter(function (c) { return c.id !== drawn.id; });
    }
    // The previous top group is now covered: its remaining cards are dead until a reshuffle.
    if (top && top.cards.length) state.buried = state.buried.concat(top.cards);
    state.discard.pop();
    state.discard.push(state.pending);
    // keep the visible pile short; older groups are dead cards
    while (state.discard.length > 1) state.buried = state.buried.concat(state.discard.shift().cards);
    p.hand.push(drawn);
    if (fromPile) p.known.push(drawn); // everyone saw which card was taken
    var discarded = state.pending;
    state.pending = null;
    state.lastAction = { type: 'draw', player: playerId, threw: discarded.cards.slice(), from: fromPile ? 'pile' : 'deck', card: fromPile ? drawn : null };
    state.turnsTaken += 1;

    if (!fromPile && state.rules.slapDown && discarded.type !== 'run' &&
        drawn.rank === discarded.cards[0].rank) {
      state.phase = 'slap';
      state.slap = { playerId: playerId, cardId: drawn.id };
      return state;
    }
    endTurn(state);
    return state;
  }

  function slapDown(state, playerId) {
    if (state.phase !== 'slap' || !state.slap || state.slap.playerId !== playerId) throw new YanivError('No slap-down available.');
    var p = state.players[playerId];
    var card = p.hand.find(function (c) { return c.id === state.slap.cardId; });
    p.hand = p.hand.filter(function (c) { return c !== card; });
    var top = state.discard[state.discard.length - 1];
    top.cards.push(card);
    top.type = 'set';
    state.lastAction = { type: 'slap', player: playerId, card: card };
    state.slap = null;
    // Slapping your last card leaves an empty hand: zero points, an automatic Yaniv next turn.
    endTurn(state);
    return state;
  }

  function passSlap(state) {
    if (state.phase !== 'slap') return state;
    state.slap = null;
    endTurn(state);
    return state;
  }

  function endTurn(state) {
    state.turn = nextActive(state, state.turn);
    state.phase = 'discard';
  }

  // ---------- Yaniv / Assaf ----------

  function applyFiftyRule(score, rule) {
    if (score > 0 && score % 50 === 0) {
      if (rule === 'subtract') return score - 50;
      if (rule === 'halve') return score / 2;
    }
    return score;
  }

  function callYaniv(state, playerId) {
    if (state.phase === 'slap') passSlap(state);
    if (!canCallYaniv(state, playerId)) throw new YanivError('You can call Yaniv at the start of your turn with ' + state.rules.yanivMax + ' or less.');
    var caller = state.players[playerId];
    var callerValue = handValue(caller.hand);
    var totals = state.players.map(function (p) { return p.out ? null : handValue(p.hand); });
    // Assaf: anyone else holding the same or less.
    var assafers = state.players.filter(function (p) { return !p.out && p.id !== playerId && totals[p.id] <= callerValue; });
    var lowest = Math.min.apply(null, totals.filter(function (t) { return t !== null; }));
    var deltas = {};
    var roundWinner;
    state.players.forEach(function (p) {
      if (p.out) return;
      if (assafers.length === 0) {
        deltas[p.id] = p.id === playerId ? 0 : totals[p.id];
      } else if (p.id === playerId) {
        deltas[p.id] = totals[p.id] + state.rules.assafPenalty;
      } else if (assafers.indexOf(p) >= 0) {
        deltas[p.id] = 0;
      } else {
        deltas[p.id] = totals[p.id];
      }
    });
    if (assafers.length) {
      // the Assafer with the lowest hand wins the round (nearest after the caller breaks ties)
      var best = assafers.filter(function (p) { return totals[p.id] === lowest; });
      best.sort(function (a, b) { return seatDist(state, playerId, a.id) - seatDist(state, playerId, b.id); });
      roundWinner = best[0].id;
    } else roundWinner = playerId;

    var before = state.players.map(function (p) { return p.score; });
    var resets = {};
    var eliminated = [];
    state.players.forEach(function (p) {
      if (p.out) return;
      var s = p.score + deltas[p.id];
      var adj = deltas[p.id] > 0 ? applyFiftyRule(s, state.rules.fiftyRule) : s;
      if (adj !== s) resets[p.id] = { from: s, to: adj };
      p.score = adj;
      if (p.score > state.rules.eliminateAbove) { p.out = true; eliminated.push(p.id); }
    });

    state.roundResult = {
      round: state.round,
      caller: playerId,
      callerValue: callerValue,
      assaf: assafers.length > 0,
      assafers: assafers.map(function (p) { return p.id; }),
      winner: roundWinner,
      hands: state.players.map(function (p) { return p.hand.slice(); }),
      totals: totals,
      deltas: deltas,
      before: before,
      after: state.players.map(function (p) { return p.score; }),
      resets: resets,
      eliminated: eliminated
    };
    state.history.push({ round: state.round, deltas: deltas, after: state.roundResult.after });
    state.lastAction = { type: 'yaniv', player: playerId, assaf: assafers.length > 0 };

    var alive = activePlayers(state);
    if (alive.length <= 1) {
      state.phase = 'gameOver';
      state.winner = alive.length ? alive[0].id : lowestScorer(state);
    } else {
      state.phase = 'roundOver';
    }
    return state;
  }

  function seatDist(state, from, to) { var n = state.players.length; return (to - from + n) % n; }
  function lowestScorer(state) {
    return state.players.slice().sort(function (a, b) { return a.score - b.score; })[0].id;
  }

  function nextRound(state) {
    if (state.phase !== 'roundOver') throw new YanivError('The round is not over.');
    // Whoever won the round starts the next one (if they were knocked out, the next seat does).
    startRound(state, state.roundResult.winner);
    return state;
  }

  // ---------- single entry point for actions (used by the local session and the server) ----------

  // action: {type:'play', cards:[ids], source:'deck'|cardId}  (discard + draw in one tap)
  //         {type:'discard', cards} | {type:'draw', source} | {type:'yaniv'} | {type:'slap'} | {type:'passSlap'} | {type:'nextRound'}
  function applyAction(state, seat, action) {
    switch (action && action.type) {
      case 'play':
        // validate the draw choice before touching the state so a bad tap changes nothing
        if (action.source !== 'deck') {
          var top = state.discard[state.discard.length - 1];
          if (!pickableFrom(top).some(function (c) { return c.id === action.source; }))
            throw new YanivError('You can only take a card from the top of the discard pile (the end of a run).');
        }
        if (state.phase === 'slap' && state.slap && state.slap.playerId !== seat) passSlap(state);
        var p = state.players[seat];
        if (state.phase === 'discard' && state.turn === seat) {
          var cards = (action.cards || []).map(function (id) { return p.hand.find(function (c) { return c.id === id; }); });
          if (cards.some(function (c) { return !c; }) || !classifyGroup(cards, state.rules))
            throw new YanivError('Discard one card, a set of the same rank, or a run of ' + state.rules.minRun + '+ in one suit.');
        }
        discard(state, seat, action.cards || []);
        return draw(state, seat, action.source);
      case 'discard': return discard(state, seat, action.cards || []);
      case 'draw': return draw(state, seat, action.source);
      case 'yaniv': return callYaniv(state, seat);
      case 'slap': return slapDown(state, seat);
      case 'passSlap':
        if (!state.slap || state.slap.playerId !== seat) throw new YanivError('No slap-down to pass.');
        return passSlap(state);
      case 'nextRound': return nextRound(state);
      default: throw new YanivError('Unknown action.');
    }
  }

  // ---------- views ----------

  // What a given player is allowed to see. A server would send this instead of the full state.
  function viewFor(state, playerId) {
    var v = JSON.parse(JSON.stringify(state));
    v.players.forEach(function (p) {
      p.handCount = p.hand.length;
      if (p.id !== playerId && state.phase !== 'roundOver' && state.phase !== 'gameOver') p.hand = null;
    });
    if (v.slap && v.slap.playerId !== playerId) delete v.slap.cardId; // others don't see the drawn card
    v.deckCount = state.deck.length;
    delete v.deck; delete v.buried; delete v.rngState;
    return v;
  }

  var api = {
    SUITS: SUITS, RANKS: RANKS, DEFAULT_RULES: DEFAULT_RULES, YanivError: YanivError,
    cardValue: cardValue, handValue: handValue, rankLabel: rankLabel, newDeck: newDeck,
    classifyGroup: classifyGroup, pickableFrom: pickableFrom, allDiscards: allDiscards,
    applyAction: applyAction, newGame: newGame, nextRound: nextRound, discard: discard, draw: draw,
    slapDown: slapDown, passSlap: passSlap, callYaniv: callYaniv, canCallYaniv: canCallYaniv,
    applyFiftyRule: applyFiftyRule, activePlayers: activePlayers, viewFor: viewFor
  };
  root.YanivEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
