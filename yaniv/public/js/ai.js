/*
 * Computer players. They only use information a human at the table would have:
 * their own hand, the discard pile, hand sizes, and cards other players were seen
 * taking from the pile (state.players[i].known).
 *
 * Strategy, in short:
 *  1. Call Yaniv when the hand is low enough AND the risk of an Assaf looks small,
 *     judged from the opponents' hand sizes and the cards we know they hold.
 *  2. Otherwise pick the discard + draw pair that leaves the lowest "effective"
 *     hand: point total minus a bonus for pairs and near-runs we can dump next turn.
 */
(function (root) {
  'use strict';
  var E = root.YanivEngine || (typeof require !== 'undefined' ? require('./engine.js') : null);

  // How much of the hand we can expect to throw next turn in one go.
  function potential(hand, rules) {
    var best = 0;
    E.allDiscards(hand, rules).forEach(function (g) {
      if (g.length > 1) best = Math.max(best, E.handValue(g) - Math.max.apply(null, g.map(E.cardValue)));
    });
    // near-runs: two suited cards one or two apart (could become a run)
    var near = 0;
    for (var i = 0; i < hand.length; i++)
      for (var j = i + 1; j < hand.length; j++)
        if (hand[i].suit === hand[j].suit && Math.abs(hand[i].rank - hand[j].rank) <= 2 && hand[i].rank !== hand[j].rank) near = 1;
    return best + near;
  }

  // Utility of holding `hand` after our turn (lower is better): points, minus a bonus for
  // combos we can dump next turn, minus a reward for being able to call Yaniv next turn.
  // The Yaniv reward matters: without it, two bots happily swap 5s and 6s forever.
  function effective(hand, rules, level) {
    var w = level === 'easy' ? 0 : level === 'hard' ? 0.8 : 0.5;
    var v = E.handValue(hand);
    var yanivBonus = v <= rules.yanivMax ? (level === 'easy' ? 2 : 5) : 0;
    return v - w * potential(hand, rules) - yanivBonus;
  }

  // Expected utility of drawing blind from the deck: average over the 13 ranks.
  // (A finer version would weight by unseen cards; ranks are close to uniform anyway.)
  function deckUtility(rest, rules, level) {
    var total = 0;
    for (var r = 1; r <= 13; r++) total += effective(rest.concat([{ id: '?' + r, suit: '?', rank: r }]), rules, level);
    return total / 13;
  }

  // Lowest total each opponent could plausibly hold.
  function opponentFloor(state, me) {
    var floors = [];
    state.players.forEach(function (p) {
      if (p.out || p.id === me) return;
      var n = p.hand ? p.hand.length : p.handCount;
      var known = p.known || [];
      var unknown = Math.max(0, n - known.length);
      // unknown cards: assume they kept their low cards, so ~2 each is a cautious guess
      floors.push(E.handValue(known) + unknown * 2);
    });
    return Math.min.apply(null, floors);
  }

  function shouldCallYaniv(state, me) {
    if (!E.canCallYaniv(state, me)) return false;
    var p = state.players[me];
    var v = E.handValue(p.hand);
    var lvl = p.level;
    if (lvl === 'easy' || stalled(state)) return true;
    if (v <= 2) return true;
    var floor = opponentFloor(state, me);
    var margin = lvl === 'hard' ? 1 : 0;
    return v + margin < floor || v <= (lvl === 'hard' ? 3 : 4) && floor >= v;
  }

  // A round that drags on (bots trading the same low cards back and forth) makes them bolder.
  function stalled(state) { return state.turnsTaken > 12 * E.activePlayers(state).length; }

  // Deterministic jitter so replays and tests are reproducible.
  function noise(state, key) {
    var h = (state.rngState ^ (state.turnsTaken * 2654435761)) >>> 0;
    for (var i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
    return (h % 1000) / 1000;
  }

  // Choose {discard:[ids], draw:'deck'|cardId}
  function chooseMove(state, me) {
    var p = state.players[me];
    var rules = state.rules;
    var top = state.discard[state.discard.length - 1];
    var pickable = E.pickableFrom(top);
    var best = null;
    E.allDiscards(p.hand, rules).forEach(function (group) {
      var ids = group.map(function (c) { return c.id; });
      var rest = p.hand.filter(function (c) { return ids.indexOf(c.id) < 0; });
      // option: draw from deck (unknown card)
      var deckScore = deckUtility(rest, rules, p.level);
      consider(ids, 'deck', deckScore, group);
      pickable.forEach(function (c) {
        var s = effective(rest.concat([c]), rules, p.level);
        consider(ids, c.id, s, group);
      });
    });
    function consider(ids, draw, score, group) {
      // tie-break: dump more points now (they are guaranteed gone)
      score -= E.handValue(group) * 0.01;
      if (draw !== 'deck' && stalled(state)) score += 2; // break swap loops in long rounds
      if (p.level === 'easy') score += noise(state, ids.join() + draw) * 3;
      if (!best || score < best.score) best = { discard: ids, draw: draw, score: score };
    }
    return best;
  }

  // The actions a computer player wants to take now, in order, without applying them.
  function decide(state, me) {
    if (state.phase === 'slap' && state.slap && state.slap.playerId === me) return [{ type: 'slap' }];
    if (state.phase !== 'discard' || state.turn !== me) return [];
    if (shouldCallYaniv(state, me)) return [{ type: 'yaniv' }];
    var m = chooseMove(state, me);
    return [{ type: 'play', cards: m.discard, source: m.draw }];
  }

  // Performs one full computer turn on the state. Returns a list of the actions taken (for animation).
  function playTurn(state, me) {
    var steps = [];
    if (state.phase === 'slap') {
      if (state.slap.playerId === me) { E.slapDown(state, me); steps.push({ type: 'slap' }); return steps; }
      E.passSlap(state);
    }
    if (shouldCallYaniv(state, me)) { E.callYaniv(state, me); steps.push({ type: 'yaniv' }); return steps; }
    var m = chooseMove(state, me);
    E.discard(state, me, m.discard); steps.push({ type: 'discard', cards: m.discard });
    E.draw(state, me, m.draw); steps.push({ type: 'draw', from: m.draw });
    if (state.phase === 'slap' && state.slap.playerId === me) { E.slapDown(state, me); steps.push({ type: 'slap' }); }
    return steps;
  }

  var api = { decide: decide, chooseMove: chooseMove, shouldCallYaniv: shouldCallYaniv, playTurn: playTurn };
  root.YanivAI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
