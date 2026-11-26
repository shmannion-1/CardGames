const test = require('node:test');
const assert = require('node:assert');
const E = require('../public/js/engine.js');
const AI = require('../public/js/ai.js');

const c = (id) => { const suit = id.slice(-1); const r = id.slice(0, -1); const rank = ({A:1,J:11,Q:12,K:13})[r] || +r; return { id, suit, rank }; };
const cs = (s) => s.split(' ').map(c);

test('card values', () => {
  assert.strictEqual(E.handValue(cs('AS KH QD JC 10S')), 41);
  assert.strictEqual(E.newDeck().length, 52);
  assert.strictEqual(new Set(E.newDeck().map(x => x.id)).size, 52);
});

test('discard classification', () => {
  assert.strictEqual(E.classifyGroup(cs('7H')).type, 'single');
  assert.strictEqual(E.classifyGroup(cs('7H 7S 7C')).type, 'set');
  assert.strictEqual(E.classifyGroup(cs('5H 3H 4H')).type, 'run');
  assert.deepStrictEqual(E.classifyGroup(cs('5H 3H 4H')).cards.map(x => x.id), ['3H', '4H', '5H']);
  assert.strictEqual(E.classifyGroup(cs('AH 2H 3H')).type, 'run');
  assert.strictEqual(E.classifyGroup(cs('QH KH AH')), null, 'ace is low only');
  assert.strictEqual(E.classifyGroup(cs('3H 4H')), null, 'two-card run not allowed');
  assert.strictEqual(E.classifyGroup(cs('3H 4S 5H')), null, 'mixed suits');
  assert.strictEqual(E.classifyGroup(cs('3H 5H 6H')), null, 'gap');
});

test('pickable: ends of runs only', () => {
  const run = E.classifyGroup(cs('3H 4H 5H 6H'));
  assert.deepStrictEqual(E.pickableFrom(run).map(x => x.id), ['3H', '6H']);
  const set = E.classifyGroup(cs('9H 9S'));
  assert.strictEqual(E.pickableFrom(set).length, 2);
});

test('allDiscards enumerates sets and runs', () => {
  const d = E.allDiscards(cs('4H 5H 6H 6S 7H'));
  const keys = d.map(g => g.map(x => x.id).sort().join(','));
  assert.ok(keys.includes('4H,5H,6H'));
  assert.ok(keys.includes('4H,5H,6H,7H'));
  assert.ok(keys.includes('5H,6H,7H'));
  assert.ok(keys.includes('6H,6S'));
  assert.strictEqual(d.filter(g => g.length === 1).length, 5);
});

function rigged(hands, top, rules) {
  const s = E.newGame(hands.map((_, i) => ({ name: 'P' + i })), rules, 1);
  const used = new Set(hands.flat().concat([top]));
  s.players.forEach((p, i) => { p.hand = cs(hands[i]); });
  s.deck = E.newDeck().filter(x => !used.has(x.id) && !hands.join(' ').split(' ').includes(x.id) && x.id !== top);
  s.discard = [{ type: 'single', cards: [c(top)], by: null }];
  s.turn = 0; s.phase = 'discard';
  return s;
}

test('turn flow: discard then draw from pile', () => {
  const s = rigged(['KH KS 2C 3D 9H', 'AH 2H 3H 4S 5S'], '8D');
  assert.throws(() => E.draw(s, 0, 'deck'), /Discard first/);
  E.discard(s, 0, ['KH', 'KS']);
  assert.strictEqual(s.phase, 'draw');
  E.draw(s, 0, '8D');
  assert.deepStrictEqual(s.players[0].hand.map(x => x.id).sort(), ['2C', '3D', '8D', '9H']);
  assert.deepStrictEqual(s.players[0].known.map(x => x.id), ['8D']);
  assert.deepStrictEqual(s.discard[0].cards.map(x => x.id), ['KH', 'KS']);
  assert.strictEqual(s.turn, 1);
  assert.throws(() => E.draw(s, 1, 'KH'), /Discard first/);
  E.discard(s, 1, ['AH', '2H', '3H']);
  assert.throws(() => E.draw(s, 1, 'nope'), /top of the discard/);
});

test('illegal discards rejected', () => {
  const s = rigged(['KH QS 2C 3D 9H', 'AH 2H 3H 4S 5S'], '8D');
  assert.throws(() => E.discard(s, 0, ['KH', 'QS']), E.YanivError);
  assert.throws(() => E.discard(s, 1, ['AH']), /Not your turn/);
  assert.throws(() => E.discard(s, 0, ['AH']), /do not hold/);
});

test('successful Yaniv', () => {
  const s = rigged(['AH 2C 3D', 'KH 5S'], '8D');
  E.callYaniv(s, 0);
  assert.strictEqual(s.roundResult.assaf, false);
  assert.strictEqual(s.players[0].score, 0);
  assert.strictEqual(s.players[1].score, 15);
  assert.strictEqual(s.roundResult.winner, 0);
});

test('Assaf: tie counts against the caller', () => {
  const s = rigged(['AH 2C 3D', 'AS 5S', 'KH KD'], '8D');
  E.callYaniv(s, 0);
  assert.strictEqual(s.roundResult.assaf, true);
  assert.deepStrictEqual(s.players.map(p => p.score), [36, 0, 20]);
  assert.strictEqual(s.roundResult.winner, 1);
  E.nextRound(s);
  assert.strictEqual(s.turn, 1);
  assert.strictEqual(s.players[0].hand.length, 5);
});

test('cannot call Yaniv above the limit', () => {
  const s = rigged(['AH 2C 5D', 'KH 5S'], '8D');
  assert.strictEqual(E.canCallYaniv(s, 0), false);
  assert.throws(() => E.callYaniv(s, 0), E.YanivError);
});

test('fifty rule and elimination', () => {
  assert.strictEqual(E.applyFiftyRule(100, 'subtract'), 50);
  assert.strictEqual(E.applyFiftyRule(100, 'halve'), 50);
  assert.strictEqual(E.applyFiftyRule(99, 'subtract'), 99);
  const s = rigged(['AH', 'KH 5S', 'KS KD'], '8D');
  s.players[1].score = 35;   // +15 => 50 => 0
  s.players[2].score = 190;  // +20 => 210 => out
  E.callYaniv(s, 0);
  assert.strictEqual(s.players[1].score, 0);
  assert.strictEqual(s.players[2].out, true);
  assert.strictEqual(s.phase, 'roundOver');
});

test('game over when one player remains', () => {
  const s = rigged(['AH', 'KH KS'], '8D');
  s.players[1].score = 190;
  E.callYaniv(s, 0);
  assert.strictEqual(s.phase, 'gameOver');
  assert.strictEqual(s.winner, 0);
});

test('slap-down after drawing matching rank', () => {
  const s = rigged(['7H 2C 3D 9H', 'AH 2H 3H 4S 5S'], '8D');
  s.deck.push(c('7S'));
  E.discard(s, 0, ['7H']);
  E.draw(s, 0, 'deck');
  assert.strictEqual(s.phase, 'slap');
  E.slapDown(s, 0);
  assert.strictEqual(s.players[0].hand.length, 3);
  assert.deepStrictEqual(s.discard[0].cards.map(x => x.id), ['7H', '7S']);
  assert.strictEqual(s.turn, 1);
});

test('reshuffle when deck runs out keeps card count at 52', () => {
  const s = E.newGame([{ name: 'a' }, { name: 'b' }], null, 42);
  for (let i = 0; i < 300 && s.phase !== 'roundOver'; i++) {
    const p = s.players[s.turn];
    E.discard(s, s.turn, [p.hand[0].id]);
    E.draw(s, s.turn, 'deck');
    if (s.phase === 'slap') E.passSlap(s);
    const total = s.deck.length + s.buried.length + s.discard.reduce((n, g) => n + g.cards.length, 0) + s.players.reduce((n, q) => n + q.hand.length, 0);
    assert.strictEqual(total, 52);
  }
});

test('viewFor hides other hands and the deck', () => {
  const s = E.newGame([{ name: 'a' }, { name: 'b' }], null, 3);
  const v = E.viewFor(s, 0);
  assert.ok(Array.isArray(v.players[0].hand));
  assert.strictEqual(v.players[1].hand, null);
  assert.strictEqual(v.players[1].handCount, 5);
  assert.strictEqual(v.deck, undefined);
});

test('simulated full CPU games finish and conserve cards', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const n = 2 + (seed % 5);
    const levels = ['easy', 'normal', 'hard'];
    const s = E.newGame(Array.from({ length: n }, (_, i) => ({ name: 'c' + i, type: 'cpu', level: levels[(i + seed) % 3] })), null, seed);
    let turns = 0;
    while (s.phase !== 'gameOver') {
      if (s.phase === 'roundOver') { E.nextRound(s); continue; }
      AI.playTurn(s, s.turn);
      const total = s.deck.length + s.buried.length + s.discard.reduce((m, g) => m + g.cards.length, 0) + s.players.reduce((m, q) => m + q.hand.length, 0);
      if (s.phase !== 'roundOver' && s.phase !== 'gameOver') assert.strictEqual(total, 52, 'seed ' + seed);
      assert.ok(++turns < 20000, 'game should end');
    }
    assert.ok(s.winner !== null);
  }
});

test('applyAction play is atomic on a bad draw', () => {
  const s = rigged(['KH KS 2C 3D 9H', 'AH 2H 3H 4S 5S'], '8D');
  assert.throws(() => E.applyAction(s, 0, { type: 'play', cards: ['KH', 'KS'], source: '9C' }));
  assert.strictEqual(s.players[0].hand.length, 5);
  assert.strictEqual(s.phase, 'discard');
  E.applyAction(s, 0, { type: 'play', cards: ['KH', 'KS'], source: '8D' });
  assert.strictEqual(s.turn, 1);
});

test('custom card art file names map to card ids', () => {
  const T = require('../public/js/theme.js');
  assert.strictEqual(T.idFromFileName('AS.png'), 'AS');
  assert.strictEqual(T.idFromFileName('10h.jpg'), '10H');
  assert.strictEqual(T.idFromFileName('queen_of_hearts.png'), 'QH');
  assert.strictEqual(T.idFromFileName('King of Clubs.webp'), 'KC');
  assert.strictEqual(T.idFromFileName('back.png'), 'back');
  assert.strictEqual(T.idFromFileName('holiday-photo.png'), null);
});
