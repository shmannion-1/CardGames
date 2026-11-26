/*
 * The interface. Renders from the latest session payload; every button carries a
 * data-act attribute handled by one delegated click listener at the bottom.
 */
(function () {
  'use strict';
  var E = window.YanivEngine, T = window.YanivTheme, S = window.YanivSession;
  var app = document.getElementById('app');
  var toastEl = document.getElementById('toast');

  var ui = {
    screen: 'home',            // home | setup | online | cardart | rules  (when no session)
    session: null,
    payload: null,
    selected: [],              // selected card ids in my hand
    sort: S.load('yaniv.sort') || 'rank',
    shownSeat: null,           // pass-and-play: whose hand is currently uncovered
    sheet: null,               // menu | rules | scores | cardart (overlay during a game)
    log: [], lastActionKey: '',
    lastHandIds: [], newCardId: null,
    setupPlayers: S.load('yaniv.setup') || [
      { name: S.load('yaniv.name') || 'You', type: 'human' },
      { name: 'Avi', type: 'cpu', level: 'normal' },
      { name: 'Noa', type: 'cpu', level: 'normal' }
    ],
    rules: Object.assign({}, E.DEFAULT_RULES, S.load('yaniv.rules') || {}),
    joinCode: '',
    artMsg: ''
  };

  // ---------------------------------------------------------------- helpers
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function short(card) {
    var red = card.suit === 'H' || card.suit === 'D';
    return '<span class="' + (red ? 'suit-r' : '') + '">' + T.rankLabel(card.rank) + T.SUIT_SYMBOL[card.suit] + '</span>';
  }
  function shortList(cards) { return cards.map(short).join(' '); }
  function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(function () { toastEl.classList.remove('show'); }, 2600);
  }
  function cardHtml(card, cls, attrs) {
    return '<button type="button" class="card ' + (cls || '') + '" ' + (attrs || '') + ' aria-label="' + esc(T.label(card)) + '">' + T.face(card) + '</button>';
  }
  function backHtml(cls) { return '<span class="card ' + (cls || '') + '" aria-hidden="true">' + T.back() + '</span>'; }
  function myName() { return S.load('yaniv.name') || ''; }
  function sortHand(hand) {
    var suitOrder = { S: 0, H: 1, C: 2, D: 3 };
    return hand.slice().sort(ui.sort === 'suit'
      ? function (a, b) { return suitOrder[a.suit] - suitOrder[b.suit] || a.rank - b.rank; }
      : function (a, b) { return a.rank - b.rank || suitOrder[a.suit] - suitOrder[b.suit]; });
  }
  function haptic() { if (navigator.vibrate) try { navigator.vibrate(12); } catch (e) {} }

  // ---------------------------------------------------------------- session wiring
  function startSession(session) {
    if (ui.session) ui.session.leave();
    ui.session = session; ui.payload = null; ui.selected = []; ui.log = []; ui.lastActionKey = ''; ui.shownSeat = null; ui.sheet = null;
    session.onUpdate(onUpdate);
    session.start();
    render();
  }
  function endSession() {
    if (ui.session) ui.session.leave();
    ui.session = null; ui.payload = null; ui.screen = 'home'; ui.sheet = null;
    history.replaceState(null, '', location.pathname);
    render();
  }

  function onUpdate(p) {
    ui.busy = false; // the server (or local engine) answered; accept input again
    if (p.error) toast(p.error);
    if (p.fatal) { ui.session = null; ui.payload = null; ui.screen = 'online'; render(); return; }
    var v = p.view;
    if (v) {
      // keep only selections that are still in my hand and still my turn
      var me = v.players[p.seat];
      var ids = me && me.hand ? me.hand.map(function (c) { return c.id; }) : [];
      ui.selected = ui.selected.filter(function (id) { return ids.indexOf(id) >= 0; });
      if (!(v.phase === 'discard' && v.turn === p.seat)) ui.selected = [];
      // highlight a newly drawn card
      var added = ids.filter(function (id) { return ui.lastHandIds.indexOf(id) < 0; });
      ui.newCardId = (added.length === 1 && ui.lastHandIds.length) ? added[0] : null;
      ui.lastHandIds = ids;
      noteAction(v);
    }
    ui.payload = p;
    // keep the room in the address bar so a refresh rejoins the same seat
    if (p.room && location.search !== '?room=' + p.room.code) history.replaceState(null, '', location.pathname + '?room=' + p.room.code);
    render();
  }

  function noteAction(v) {
    var a = v.lastAction;
    if (!a) return;
    var key = JSON.stringify(a) + v.round + v.turnsTaken;
    if (key === ui.lastActionKey) return;
    ui.lastActionKey = key;
    ui.animatePile = true;
    var name = function (i) { return esc(v.players[i].name); };
    var line = null;
    if (a.type === 'deal') line = 'Round ' + a.round + '. ' + (v.turn === ui.payloadSeat() ? 'You start.' : name(v.turn) + ' starts.');
    else if (a.type === 'draw') line = name(a.player) + ' threw ' + shortList(a.threw || []) + (a.from === 'pile' ? ' and took ' + short(a.card) : ' and drew from the deck') + '.';
    else if (a.type === 'slap') line = name(a.player) + ' slapped down ' + short(a.card) + '!';
    if (line) { ui.log.unshift(line); ui.log = ui.log.slice(0, 3); }
  }

  ui.payloadSeat = function () { return ui.session && ui.session.seat; };

  // ---------------------------------------------------------------- top-level render
  function render() {
    var p = ui.payload;
    var html;
    if (!ui.session) html = ({ home: homeScreen, setup: setupScreen, online: onlineScreen, cardart: cardArtScreen, rules: rulesScreen })[ui.screen]();
    else if (!p) html = '<div class="center grow"><p class="muted">Connecting…</p><button class="btn" data-act="leave">Cancel</button></div>';
    else if (p.mode === 'online' && p.room && p.room.phase === 'lobby') html = lobbyScreen(p);
    else if (p.view) html = tableScreen(p);
    else html = '<div class="center grow"><p class="muted">Loading…</p></div>';
    if (ui.sheet && ui.session) html += sheetHtml();
    app.innerHTML = html;
    // play the slide-up animation only the first time a given overlay appears
    var sheet = app.querySelector('.sheet');
    var key = sheet ? (ui.sheet || '') + '|' + (p && p.view ? p.view.round + p.view.phase : '') : '';
    if (sheet && key === ui.overlayKey) sheet.style.animation = 'none';
    ui.overlayKey = key;
  }

  // ---------------------------------------------------------------- home
  function homeScreen() {
    var resume = S.LocalSession.hasSave();
    var lastRoom = S.load('yaniv.lastRoom');
    return '<h1 class="brand">Yaniv</h1><p class="tag">Get your hand down to ' + ui.rules.yanivMax + ' or less, then call it.</p>' +
      '<div class="stack">' +
      (resume ? '<button class="btn primary" data-act="resume">Resume game</button>' : '') +
      '<button class="btn ' + (resume ? '' : 'primary') + '" data-act="go" data-to="setup">Play on this device</button>' +
      '<button class="btn" data-act="go" data-to="online">Play online with friends</button>' +
      (lastRoom && S.OnlineSession.tokenFor(lastRoom) && isServed()
        ? '<button class="btn" data-act="rejoin" data-code="' + esc(lastRoom) + '">Rejoin game ' + esc(lastRoom) + '</button>' : '') +
      '<div class="row"><button class="btn grow" data-act="go" data-to="rules">How to play</button>' +
      '<button class="btn grow" data-act="go" data-to="cardart">Card art</button></div>' +
      '</div>' +
      '<p class="muted" style="text-align:center;margin-top:28px">On iPhone: Share → Add to Home Screen to install.</p>';
  }
  function isServed() { return location.protocol === 'http:' || location.protocol === 'https:'; }

  // ---------------------------------------------------------------- local setup
  function setupScreen() {
    var rows = ui.setupPlayers.map(function (p, i) {
      return '<div class="row">' +
        '<input type="text" class="grow" data-field="pname" data-i="' + i + '" value="' + esc(p.name) + '" maxlength="16" aria-label="Player ' + (i + 1) + ' name">' +
        '<select data-field="ptype" data-i="' + i + '" aria-label="Player type" style="width:auto">' +
          '<option value="human"' + (p.type === 'human' ? ' selected' : '') + '>Person</option>' +
          '<option value="easy"' + (p.type === 'cpu' && p.level === 'easy' ? ' selected' : '') + '>CPU easy</option>' +
          '<option value="normal"' + (p.type === 'cpu' && p.level === 'normal' ? ' selected' : '') + '>CPU normal</option>' +
          '<option value="hard"' + (p.type === 'cpu' && p.level === 'hard' ? ' selected' : '') + '>CPU hard</option>' +
        '</select>' +
        (ui.setupPlayers.length > 2 ? '<button class="icon-btn" data-act="rmPlayer" data-i="' + i + '" aria-label="Remove player">×</button>' : '') +
        '</div>';
    }).join('');
    var humans = ui.setupPlayers.filter(function (p) { return p.type === 'human'; }).length;
    return '<div class="top-bar"><button class="icon-btn" data-act="go" data-to="home" aria-label="Back">‹</button><h2>Play on this device</h2></div>' +
      '<div class="stack">' +
      '<div class="panel stack">' + rows +
      (ui.setupPlayers.length < 8 ? '<button class="btn small" data-act="addPlayer">+ Add player</button>' : '') +
      '<p class="muted" style="margin:0">' + (humans > 1 ? 'Pass and play: the screen hides your hand between people.' : humans === 1 ? 'You against the computer.' : 'Computers only: sit back and watch.') + '</p>' +
      '</div>' +
      rulesPanel() +
      '<button class="btn primary" data-act="startLocal">Deal</button>' +
      '</div>';
  }

  function rulesPanel(readOnly) {
    var r = ui.rules;
    var dis = readOnly ? ' disabled' : '';
    function num(key, label, min, max) {
      return '<label class="field">' + label + '<input type="number" inputmode="numeric" data-rule="' + key + '" min="' + min + '" max="' + max + '" value="' + r[key] + '"' + dis + '></label>';
    }
    return '<details class="panel"><summary>House rules</summary><div class="rules-grid">' +
      num('yanivMax', 'Call Yaniv at or under', 0, 15) +
      num('handSize', 'Cards dealt', 3, 7) +
      num('assafPenalty', 'Assaf penalty', 0, 100) +
      num('eliminateAbove', 'Out when over', 50, 1000) +
      num('minRun', 'Shortest run', 3, 5) +
      '<label class="field">Hitting 50, 100, 150…<select data-rule="fiftyRule"' + dis + '>' +
        ['subtract', 'halve', 'none'].map(function (o) { return '<option value="' + o + '"' + (r.fiftyRule === o ? ' selected' : '') + '>' + ({ subtract: 'Take off 50', halve: 'Halve score', none: 'Nothing' })[o] + '</option>'; }).join('') +
      '</select></label>' +
      '<label class="check"><input type="checkbox" data-rule="slapDown"' + (r.slapDown ? ' checked' : '') + dis + '> Slap-down: drew the rank you just threw? Throw it too</label>' +
      '<label class="check"><input type="checkbox" data-rule="noYanivFirstTurn"' + (r.noYanivFirstTurn ? ' checked' : '') + dis + '> No Yaniv before everyone has had a turn</label>' +
      (readOnly ? '' : '<button class="btn small" data-act="resetRules" style="grid-column:1/-1">Reset to standard</button>') +
      '</div></details>';
  }

  // ---------------------------------------------------------------- online menu + lobby
  function onlineScreen() {
    if (!isServed()) {
      return '<div class="top-bar"><button class="icon-btn" data-act="go" data-to="home" aria-label="Back">‹</button><h2>Play online</h2></div>' +
        '<div class="panel"><p>Online play needs the Yaniv server. This copy was opened as a file, so it can only play on this device.</p></div>';
    }
    return '<div class="top-bar"><button class="icon-btn" data-act="go" data-to="home" aria-label="Back">‹</button><h2>Play online</h2></div>' +
      '<div class="stack">' +
      '<label class="field">Your name<input type="text" data-field="myname" maxlength="16" value="' + esc(myName()) + '" placeholder="Name shown to others" autocomplete="nickname"></label>' +
      '<div class="panel stack"><h3>Join a game</h3>' +
        '<input type="text" class="code" data-field="joincode" maxlength="4" value="' + esc(ui.joinCode) + '" placeholder="CODE" autocapitalize="characters" autocomplete="off" aria-label="Room code">' +
        '<button class="btn primary" data-act="join">Join</button></div>' +
      '<div class="panel stack"><h3>Host a game</h3><p class="muted" style="margin:0">You get a 4-letter code to share. Add computer players to fill seats.</p>' +
        '<button class="btn" data-act="create">Create game</button></div>' +
      rulesPanel() +
      '</div>';
  }

  function lobbyScreen(p) {
    var room = p.room, host = p.seat === room.host;
    var seats = room.seats.map(function (s, i) {
      return '<div class="seat"><span class="dot' + (s.connected ? '' : ' off') + '"></span><span class="grow">' + esc(s.name) + (i === p.seat ? ' (you)' : '') + '</span>' +
        (i === room.host ? '<span class="pill host">host</span>' : '') +
        (s.type === 'cpu' ? '<span class="pill">CPU ' + esc(s.level) + '</span>' : '') +
        (host && i !== p.seat ? '<button class="icon-btn" data-act="removeSeat" data-i="' + i + '" aria-label="Remove ' + esc(s.name) + '">×</button>' : '') + '</div>';
    }).join('');
    ui.rules = Object.assign({}, ui.rules, room.rules);
    return '<div class="top-bar"><button class="icon-btn" data-act="leave" aria-label="Leave">‹</button><h2>Game room</h2></div>' +
      (p.offline ? '<div class="offline">Reconnecting…</div>' : '') +
      '<div class="stack">' +
      '<div class="panel stack" style="align-items:center"><span class="muted">Room code</span><div class="code-big">' + esc(room.code) + '</div>' +
        '<button class="btn small" data-act="share">Share invite link</button></div>' +
      '<div class="panel"><h3 style="margin-bottom:4px">Players (' + room.seats.length + '/8)</h3>' + seats +
        (host && room.seats.length < 8 ? '<div class="row" style="margin-top:10px"><select data-field="botlevel" style="width:auto"><option value="easy">Easy</option><option value="normal" selected>Normal</option><option value="hard">Hard</option></select><button class="btn small grow" data-act="addBot">+ Computer player</button></div>' : '') +
      '</div>' +
      rulesPanel(!host) +
      (host ? '<button class="btn primary" data-act="startOnline"' + (room.seats.length < 2 ? ' disabled' : '') + '>Deal</button>'
            : '<p class="muted" style="text-align:center">Waiting for ' + esc(room.seats[room.host] ? room.seats[room.host].name : 'the host') + ' to deal…</p>') +
      '</div>';
  }

  // ---------------------------------------------------------------- the table
  function tableScreen(p) {
    var v = p.view, seat = p.seat, me = v.players[seat];
    var n = v.players.length;
    var actor = v.phase === 'slap' && v.slap ? v.slap.playerId : v.turn;
    // While an online move is in flight, act as if it is not our turn so a double tap can't send twice.
    var myTurn = v.phase === 'discard' && v.turn === seat && !ui.busy;
    var top = v.discard[v.discard.length - 1];
    var pickIds = E.pickableFrom(top).map(function (c) { return c.id; });
    var selCards = ui.selected.map(function (id) { return me.hand.find(function (c) { return c.id === id; }); }).filter(Boolean);
    var valid = myTurn && selCards.length && E.classifyGroup(selCards, v.rules);
    var canYaniv = !ui.busy && !!(me.hand && E.canCallYaniv(v, seat));

    // Pass-and-play: cover the screen until the right person is holding it.
    if (p.passAndPlay && v.phase !== 'roundOver' && v.phase !== 'gameOver' && ui.shownSeat !== seat && v.players[actor].type === 'human') {
      return '<div class="cover"><p class="muted">Round ' + v.round + '</p><h2>Pass to ' + esc(me.name) + '</h2>' +
        '<p class="muted">Everyone else, look away.</p><button class="btn primary" data-act="reveal">I\'m ' + esc(me.name) + ', show my cards</button>' +
        '<button class="btn small" data-act="menu">Menu</button></div>';
    }

    // opponents in seat order after me
    var opps = '';
    for (var k = 1; k < n; k++) {
      var o = v.players[(seat + k) % n];
      var count = o.hand ? o.hand.length : o.handCount;
      var fan = ''; for (var c = 0; c < count; c++) fan += backHtml('mini');
      var known = (o.known || []).map(function (kc) { return '<span class="card mini" title="Took ' + esc(T.label(kc)) + '">' + T.face(kc) + '</span>'; }).join('');
      var seatInfo = p.room && p.room.seats[o.id];
      opps += '<div class="opp' + (o.id === actor && !o.out ? ' turn' : '') + (o.out ? ' out' : '') + '">' +
        '<div class="opp-name">' + (seatInfo && seatInfo.type === 'human' ? '<span class="dot' + (seatInfo.connected ? '' : ' off') + '"></span> ' : '') +
        '<span class="' + (o.id === actor && o.type === 'cpu' && !o.out ? 'thinking' : '') + '">' + esc(o.name) + '</span></div>' +
        '<div class="opp-meta"><span>' + (o.out ? 'out' : count + ' card' + (count === 1 ? '' : 's')) + '</span><span>' + o.score + ' pts</span></div>' +
        '<div class="fan">' + fan + '</div>' + (known ? '<div class="known">' + known + '</div>' : '') + '</div>';
    }

    // centre: deck + discard
    var fresh = ui.animatePile && v.lastAction && (v.lastAction.type === 'draw' || v.lastAction.type === 'slap' || v.lastAction.type === 'deal');
    ui.animatePile = false; // re-renders (like selecting a card) must not replay the animation
    var pileCards = top ? top.cards.map(function (c) {
      var can = valid && pickIds.indexOf(c.id) >= 0;
      return cardHtml(c, 'pile' + (can ? ' pickable' : '') + (fresh ? ' fresh' : ''), can ? 'data-act="drawPile" data-id="' + c.id + '"' : 'tabindex="-1" disabled');
    }).join('') : '';
    var deckBtn = '<button type="button" class="card pile' + (valid ? ' pickable' : '') + '" ' + (valid ? 'data-act="drawDeck"' : 'disabled') + ' aria-label="Draw from deck">' + T.back() + '</button>';

    var log = ui.log.map(function (l, i) { return '<div class="' + (i === 0 ? 'now' : '') + '">' + l + '</div>'; }).join('');

    // my hand
    var handCards = sortHand(me.hand || []).map(function (c) {
      var sel = ui.selected.indexOf(c.id) >= 0;
      return cardHtml(c, (sel ? 'selected' : '') + (c.id === ui.newCardId ? ' new-in-hand' : ''), myTurn ? 'data-act="select" data-id="' + c.id + '" aria-pressed="' + sel + '"' : '');
    }).join('');
    var total = E.handValue(me.hand || []);

    var hint = '';
    if (me.out) hint = 'You are out. Watch the rest play.';
    else if (myTurn) {
      if (!selCards.length) hint = canYaniv ? 'You can call Yaniv! Or throw cards to keep going.' : 'Tap cards to throw: one card, a set, or a run of ' + v.rules.minRun + '+.';
      else if (!valid) hint = 'That isn\'t a set or a same-suit run.';
      else hint = 'Now tap the deck, or a glowing card on the pile to take it.';
    } else if (v.phase === 'discard') hint = esc(v.players[v.turn].name) + '\'s turn';

    var slapBanner = '';
    if (v.phase === 'slap' && v.slap && v.slap.playerId === seat) {
      var sc = me.hand.find(function (c) { return c.id === v.slap.cardId; });
      slapBanner = '<div class="banner"><span class="grow">You drew ' + (sc ? short(sc).replace('suit-r', '') : 'a match') + '. Slap it down?</span>' +
        '<button class="btn primary" data-act="slap">Slap</button><button class="btn" data-act="passSlap">Keep</button></div>';
    }

    return '<div class="table">' +
      '<div class="table-head"><span class="round">Round ' + v.round + ' · out over ' + v.rules.eliminateAbove + (p.mode === 'online' && p.room ? ' · room ' + esc(p.room.code) : '') + '</span>' +
        '<button class="icon-btn" data-act="sheet" data-sheet="scores" aria-label="Scores">☰</button></div>' +
      (p.offline ? '<div class="offline">Connection lost. Reconnecting…</div>' : '') +
      '<div class="opponents">' + opps + '</div>' +
      '<div class="center">' +
        '<div class="piles">' +
          '<div class="pile-col"><div class="deck-stack">' + deckBtn + '</div><span class="pile-label">Deck · ' + v.deckCount + '</span></div>' +
          '<div class="pile-col"><div class="discard-group">' + pileCards + '</div><span class="pile-label">Discard</span></div>' +
        '</div>' +
        '<div class="log">' + log + '</div>' +
      '</div>' +
      '<div class="me' + (myTurn ? ' turn' : '') + '">' + slapBanner +
        '<div class="me-head"><b>' + esc(me.name) + '</b><span class="muted">' + me.score + ' pts</span><span class="grow"></span>' +
          '<span class="muted">Hand</span><span class="total">' + total + '</span>' +
          '<button class="btn small" data-act="sort" aria-label="Sort hand">' + (ui.sort === 'rank' ? 'By rank' : 'By suit') + '</button></div>' +
        '<div class="hint">' + hint + '</div>' +
        '<div class="hand' + ((me.hand || []).length > 6 ? ' many' : '') + '">' + handCards + '</div>' +
        '<div class="actions"><button class="btn primary yaniv" data-act="yaniv"' + (canYaniv ? '' : ' disabled') + '>Yaniv!</button></div>' +
      '</div>' +
      '</div>' +
      (v.phase === 'roundOver' || v.phase === 'gameOver' ? resultsOverlay(p) : '');
  }

  function resultsOverlay(p) {
    var v = p.view, r = v.roundResult, seat = p.seat;
    if (!r) return '';
    var caller = v.players[r.caller];
    var head = r.assaf
      ? '<div class="result-big assaf">Assaf!</div><p style="text-align:center;margin:0 0 8px">' + esc(caller.name) + ' called Yaniv with ' + r.callerValue + ', but ' +
        r.assafers.map(function (i) { return esc(v.players[i].name) + ' had ' + r.totals[i]; }).join(' and ') + '. +' + v.rules.assafPenalty + ' penalty.</p>'
      : '<div class="result-big">Yaniv!</div><p style="text-align:center;margin:0 0 8px">' + esc(caller.name) + ' went out with ' + r.callerValue + '.</p>';
    var order = v.players.map(function (pl) { return pl.id; }).sort(function (a, b) { return v.players[a].score - v.players[b].score; });
    var rows = order.map(function (i) {
      var pl = v.players[i];
      if (r.deltas[i] === undefined) return '';
      var note = [];
      if (r.resets[i]) note.push('hit ' + r.resets[i].from + ' → ' + r.resets[i].to);
      if (r.eliminated.indexOf(i) >= 0) note.push('knocked out');
      return '<div class="res-row' + (i === r.winner ? ' win' : '') + '"><div><b>' + esc(pl.name) + (i === seat ? ' (you)' : '') + '</b>' +
        (note.length ? ' <span class="tagline">' + note.join(', ') + '</span>' : '') +
        '<div class="cards">' + r.hands[i].map(function (c) { return '<span class="card mini">' + T.face(c) + '</span>'; }).join('') + '</div></div>' +
        '<div class="delta">+' + r.deltas[i] + '</div><div class="score">' + pl.score + '</div></div>';
    }).join('');
    var foot;
    if (v.phase === 'gameOver') {
      var w = v.players[v.winner];
      var isHost = p.mode !== 'online' || (p.room && p.room.host === seat);
      head = '<div class="result-big">' + esc(w.name) + ' wins!</div>' + head;
      foot = (isHost ? '<button class="btn primary" data-act="again">Play again</button>' : '<p class="muted" style="text-align:center">The host can start another game.</p>') +
        '<button class="btn" data-act="leave">Back to menu</button>';
    } else {
      foot = '<button class="btn primary" data-act="nextRound">Next round</button>';
    }
    return '<div class="overlay"><div class="sheet stack"><p class="muted" style="margin:0;text-align:center">Round ' + r.round + '</p>' + head + '<div>' + rows + '</div>' + foot + '</div></div>';
  }

  // ---------------------------------------------------------------- in-game sheets
  function sheetHtml() {
    var body = '';
    if (ui.sheet === 'scores') {
      var v = ui.payload && ui.payload.view;
      if (v) {
        body = '<h2>Scores</h2><table class="scores"><tr><th>Round</th>' + v.players.map(function (pl) { return '<th>' + esc(pl.name) + '</th>'; }).join('') + '</tr>' +
          v.history.map(function (h) { return '<tr><td>' + h.round + '</td>' + v.players.map(function (pl) { return '<td>' + (h.deltas[pl.id] === undefined ? '—' : '+' + h.deltas[pl.id]) + '</td>'; }).join('') + '</tr>'; }).join('') +
          '<tr><th>Total</th>' + v.players.map(function (pl) { return '<th>' + pl.score + (pl.out ? ' (out)' : '') + '</th>'; }).join('') + '</tr></table>';
      }
      body += '<div class="row"><button class="btn grow" data-act="sheet" data-sheet="rules">How to play</button><button class="btn grow" data-act="sheet" data-sheet="cardart">Card art</button></div>' +
        '<button class="btn danger" data-act="leave">Leave game</button>';
    } else if (ui.sheet === 'rules') body = rulesBody();
    else if (ui.sheet === 'cardart') body = cardArtBody();
    return '<div class="overlay" data-act="closeSheet"><div class="sheet stack" data-stop="1">' + body + '<button class="btn" data-act="closeSheet">Close</button></div></div>';
  }

  function rulesBody() {
    var r = (ui.payload && ui.payload.view && ui.payload.view.rules) || ui.rules;
    return '<h2>How to play</h2><div class="rules-text">' +
      '<p><b>Goal:</b> keep your score low. Each round you try to get the points in your hand down to <b>' + r.yanivMax + ' or less</b> and call Yaniv.</p>' +
      '<p><b>Card points:</b> Ace 1, 2–10 face value, J Q K 10.</p>' +
      '<p><b>Your turn:</b> throw one card, a set of the same rank (7♠ 7♥), or a run of ' + r.minRun + '+ in one suit (4♦ 5♦ 6♦). Then take one card: from the deck, or one of the cards the last player threw. From a run you can only take an end card.</p>' +
      (r.slapDown ? '<p><b>Slap-down:</b> if the card you draw from the deck matches the rank you just threw, you may throw it straight away.</p>' : '') +
      '<p><b>Yaniv:</b> at the start of your turn, if your hand is ' + r.yanivMax + ' or less, call Yaniv. Everyone shows their hand. You score 0 and everyone else adds their hand.</p>' +
      '<p><b>Assaf:</b> if anyone has the same or less than you, they score 0 and you add your hand plus ' + r.assafPenalty + '.</p>' +
      (r.fiftyRule !== 'none' ? '<p><b>Lucky fifties:</b> land exactly on 50, 100, 150… and your score ' + (r.fiftyRule === 'halve' ? 'is halved' : 'drops by 50') + '.</p>' : '') +
      '<p><b>Out:</b> go over ' + r.eliminateAbove + ' and you are out. Last player standing wins.</p>' +
      '<p class="muted">Took-from-pile cards show under each player\'s name, because everyone saw them.</p></div>';
  }
  function rulesScreen() {
    return '<div class="top-bar"><button class="icon-btn" data-act="go" data-to="home" aria-label="Back">‹</button><h2>How to play</h2></div><div class="panel">' + rulesBody().replace('<h2>How to play</h2>', '') + '</div>';
  }

  function cardArtBody() {
    var list = T.list().map(function (t) {
      return '<label class="check" style="grid-column:auto"><input type="radio" name="theme" data-field="theme" value="' + esc(t.id) + '"' + (T.activeId() === t.id ? ' checked' : '') + '> ' + esc(t.name) +
        (t.id.indexOf('custom-') === 0 ? ' <button class="btn small danger" data-act="delDeck" data-id="' + esc(t.id) + '">Delete</button>' : '') + '</label>';
    }).join('');
    var sample = [{ id: 'AS', suit: 'S', rank: 1 }, { id: '7H', suit: 'H', rank: 7 }, { id: '10D', suit: 'D', rank: 10 }, { id: 'QC', suit: 'C', rank: 12 }, { id: 'KH', suit: 'H', rank: 13 }];
    return '<h2>Card art</h2>' +
      '<div class="stack">' + list + '</div>' +
      '<div class="theme-preview">' + sample.map(function (c) { return '<span class="card">' + T.face(c) + '</span>'; }).join('') + '<span class="card">' + T.back() + '</span></div>' +
      '<div class="panel stack"><h3>Use your own deck</h3>' +
      '<p class="muted" style="margin:0">Pick up to 53 images, one per card, named like <b>AS.png</b>, <b>10H.png</b>, <b>QD.jpg</b>, <b>KC.png</b> (or <b>queen_of_hearts.png</b>) plus <b>back.png</b>. Portrait 5:7 works best. Cards you leave out use the classic look. Images stay on this device.</p>' +
      '<input type="text" data-field="deckname" placeholder="Deck name" maxlength="24" value="My deck">' +
      '<label class="btn" style="text-align:center">Choose images…<input type="file" accept="image/*" multiple data-field="deckfiles" hidden></label>' +
      (ui.artMsg ? '<p class="muted" style="margin:0">' + ui.artMsg + '</p>' : '') + '</div>';
  }
  function cardArtScreen() {
    return '<div class="top-bar"><button class="icon-btn" data-act="go" data-to="home" aria-label="Back">‹</button><h2>Card art</h2></div><div class="stack">' + cardArtBody().replace('<h2>Card art</h2>', '') + '</div>';
  }

  // ---------------------------------------------------------------- actions
  var actions = {
    go: function (el) { ui.screen = el.dataset.to; render(); },
    addPlayer: function () {
      var used = ui.setupPlayers.map(function (p) { return p.name; });
      var name = ['Avi', 'Noa', 'Tal', 'Maya', 'Eli', 'Yael', 'Omer', 'Shira'].find(function (x) { return used.indexOf(x) < 0; }) || 'Player';
      ui.setupPlayers.push({ name: name, type: 'cpu', level: 'normal' }); saveSetup(); render();
    },
    rmPlayer: function (el) { ui.setupPlayers.splice(+el.dataset.i, 1); saveSetup(); render(); },
    resetRules: function () { ui.rules = Object.assign({}, E.DEFAULT_RULES); S.store('yaniv.rules', null); pushRules(); render(); },
    startLocal: function () {
      var players = ui.setupPlayers.map(function (p) { return { name: p.name.trim() || 'Player', type: p.type, level: p.level }; });
      S.LocalSession.clearSave();
      startSession(new S.LocalSession({ players: players, rules: ui.rules }));
    },
    resume: function () { startSession(S.LocalSession.resume()); },
    create: function () {
      if (!requireName()) return;
      startSession(new S.OnlineSession({ name: myName(), rules: ui.rules }));
    },
    join: function () {
      if (!requireName()) return;
      var code = (ui.joinCode || '').toUpperCase().trim();
      if (!/^[A-Z]{4}$/.test(code)) return toast('Enter the 4-letter room code.');
      startSession(new S.OnlineSession({ name: myName(), code: code }));
    },
    rejoin: function (el) { startSession(new S.OnlineSession({ name: myName() || 'Player', code: el.dataset.code })); },
    share: function () {
      var code = ui.payload.room.code;
      var url = location.origin + location.pathname + '?room=' + code;
      var text = 'Join my Yaniv game! Code ' + code;
      if (navigator.share) navigator.share({ title: 'Yaniv', text: text, url: url }).catch(function () {});
      else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast('Invite link copied'); });
      else toast(url);
    },
    addBot: function () { var lvl = (app.querySelector('[data-field=botlevel]') || {}).value || 'normal'; ui.session.lobby({ t: 'addBot', level: lvl }); },
    removeSeat: function (el) { ui.session.lobby({ t: 'removeSeat', seat: +el.dataset.i }); },
    startOnline: function () { ui.session.lobby({ t: 'start' }); },
    leave: function () {
      if (ui.session && ui.session.mode === 'online') S.store('yaniv.lastRoom', null);
      endSession();
    },
    select: function (el) {
      var id = el.dataset.id, i = ui.selected.indexOf(id);
      if (i >= 0) ui.selected.splice(i, 1); else ui.selected.push(id);
      haptic(); render();
    },
    drawDeck: function () { play('deck'); },
    drawPile: function (el) { play(el.dataset.id); },
    yaniv: function () { haptic(); send({ type: 'yaniv' }); },
    slap: function () { haptic(); send({ type: 'slap' }); },
    passSlap: function () { send({ type: 'passSlap' }); },
    nextRound: function () { send({ type: 'nextRound' }); },
    again: function () {
      var v = ui.payload.view;
      if (ui.session.mode === 'online') { ui.session.lobby({ t: 'start' }); return; }
      var players = v.players.map(function (p) { return { name: p.name, type: p.type, level: p.level }; });
      S.LocalSession.clearSave();
      startSession(new S.LocalSession({ players: players, rules: v.rules }));
    },
    sort: function () { ui.sort = ui.sort === 'rank' ? 'suit' : 'rank'; S.store('yaniv.sort', ui.sort); render(); },
    reveal: function () { ui.shownSeat = ui.payload.seat; ui.selected = []; render(); },
    sheet: function (el) { ui.sheet = el.dataset.sheet; render(); },
    menu: function () { ui.sheet = 'scores'; render(); },
    closeSheet: function () { ui.sheet = null; render(); },
    delDeck: function (el) { T.deleteDeck(el.dataset.id).then(function () { S.store('yaniv.theme', T.activeId()); render(); }); }
  };

  function send(action) {
    if (ui.busy) return;
    ui.busy = true;
    ui.session.act(action);
    if (ui.busy) render(); // still waiting on the server: show the locked state
  }
  function play(source) {
    haptic();
    var cards = ui.selected.slice();
    ui.selected = [];
    send({ type: 'play', cards: cards, source: source });
  }
  function requireName() {
    var n = myName().trim();
    if (!n) { toast('Enter your name first.'); var f = app.querySelector('[data-field=myname]'); if (f) f.focus(); return false; }
    return true;
  }
  function saveSetup() { S.store('yaniv.setup', ui.setupPlayers); }
  function pushRules() {
    S.store('yaniv.rules', ui.rules);
    if (ui.session && ui.session.mode === 'online' && ui.payload && ui.payload.room && ui.payload.room.phase === 'lobby') ui.session.lobby({ t: 'rules', rules: ui.rules });
  }

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-act]');
    if (!el) return;
    // clicks inside a sheet shouldn't hit the overlay's close handler
    if (el.dataset.act === 'closeSheet' && el.classList.contains('overlay') && ev.target.closest('[data-stop]')) return;
    if (el.disabled) return;
    var fn = actions[el.dataset.act];
    if (fn) { ev.preventDefault(); fn(el); }
  });

  document.addEventListener('input', function (ev) {
    var el = ev.target;
    if (el.dataset.field === 'pname') { ui.setupPlayers[+el.dataset.i].name = el.value; saveSetup(); }
    if (el.dataset.field === 'myname') S.store('yaniv.name', el.value.trim());
    if (el.dataset.field === 'joincode') { el.value = el.value.toUpperCase().replace(/[^A-Z]/g, ''); ui.joinCode = el.value; }
  });

  document.addEventListener('change', function (ev) {
    var el = ev.target;
    if (el.dataset.field === 'ptype') {
      var p = ui.setupPlayers[+el.dataset.i];
      if (el.value === 'human') { p.type = 'human'; delete p.level; } else { p.type = 'cpu'; p.level = el.value; }
      saveSetup(); render();
    }
    if (el.dataset.rule) {
      var k = el.dataset.rule;
      if (el.type === 'checkbox') ui.rules[k] = el.checked;
      else if (el.type === 'number') {
        var lo = +el.min, hi = +el.max, val = Math.round(+el.value);
        ui.rules[k] = isFinite(val) ? Math.max(lo, Math.min(hi, val)) : E.DEFAULT_RULES[k];
        el.value = ui.rules[k];
      } else ui.rules[k] = el.value;
      pushRules();
      if (!ui.session) render();
    }
    if (el.dataset.field === 'theme') { T.use(el.value); S.store('yaniv.theme', el.value); render(); }
    if (el.dataset.field === 'deckfiles' && el.files.length) {
      var nameEl = app.querySelector('[data-field=deckname]');
      var deckName = (nameEl && nameEl.value.trim()) || 'My deck';
      ui.artMsg = 'Loading…'; render();
      T.importDeck(deckName, el.files).then(function (res) {
        T.use(res.id); S.store('yaniv.theme', res.id);
        ui.artMsg = 'Loaded ' + res.matched.length + ' of 53 images.' + (res.skipped.length ? ' Skipped (name not recognised): ' + esc(res.skipped.slice(0, 6).join(', ')) + (res.skipped.length > 6 ? '…' : '') : '');
        render();
      });
    }
  });

  // iOS: stop double-tap zoom on fast card taps
  var lastTouch = 0;
  document.addEventListener('touchend', function (e) {
    var now = Date.now();
    if (now - lastTouch < 300 && e.target.closest('.card, .btn')) e.preventDefault();
    lastTouch = now;
  }, { passive: false });

  // ---------------------------------------------------------------- boot
  T.loadSavedDecks().then(function () {
    var saved = S.load('yaniv.theme');
    if (saved) T.use(saved);
    var params = new URLSearchParams(location.search);
    var room = params.get('room');
    if (room) {
      ui.joinCode = room.toUpperCase().slice(0, 4);
      ui.screen = 'online';
      // a refresh (or reopening the app) puts you straight back in your seat
      if (S.OnlineSession.tokenFor(ui.joinCode)) { startSession(new S.OnlineSession({ name: myName() || 'Player', code: ui.joinCode })); return; }
    }
    render();
  });
  render();
})();
