/*
 * Sessions connect the UI to a game. The UI only ever sees:
 *   session.onUpdate(fn)   fn({view, seat, ...})  where view = YanivEngine.viewFor(state, seat)
 *   session.act(action)    action objects as in YanivEngine.applyAction
 * so the same table code drives a local game and an online game.
 *
 * LocalSession   - the whole game runs in this browser (vs computer, pass-and-play).
 * OnlineSession  - the game runs on the server; this browser holds one seat.
 */
(function (root) {
  'use strict';
  var E = root.YanivEngine, AI = root.YanivAI;
  var SAVE_KEY = 'yaniv.local.v1';
  var CPU_DELAY = 1100, CPU_SLAP_DELAY = 500;

  function store(key, val) { try { if (val == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function load(key) { try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; } }

  // ------------------------------------------------------------------ local

  function LocalSession(opts) {
    this.listeners = [];
    this.timer = null;
    if (opts.saved) this.state = opts.saved;
    else this.state = E.newGame(opts.players, opts.rules);
    this.humans = this.state.players.filter(function (p) { return p.type === 'human'; }).map(function (p) { return p.id; });
    this.seat = this.humans.length ? this.humans[0] : 0;
    this.mode = 'local';
    this.passAndPlay = this.humans.length > 1;
  }
  LocalSession.hasSave = function () { var s = load(SAVE_KEY); return !!(s && s.phase !== 'gameOver'); };
  LocalSession.resume = function () { var s = load(SAVE_KEY); return s ? new LocalSession({ saved: s }) : null; };
  LocalSession.clearSave = function () { store(SAVE_KEY, null); };

  LocalSession.prototype.onUpdate = function (fn) { this.listeners.push(fn); this.emit(); };
  LocalSession.prototype.emit = function (error) {
    var s = this.state;
    // In pass-and-play the screen follows whichever human is acting.
    if (this.passAndPlay) {
      var actor = s.phase === 'slap' && s.slap ? s.slap.playerId : s.turn;
      if (s.players[actor].type === 'human' && (s.phase === 'discard' || s.phase === 'slap')) this.seat = actor;
    }
    var payload = { view: E.viewFor(s, this.seat), seat: this.seat, mode: 'local', passAndPlay: this.passAndPlay, error: error || null };
    store(SAVE_KEY, s);
    this.listeners.forEach(function (fn) { fn(payload); });
  };
  LocalSession.prototype.act = function (action) {
    try {
      var seat = this.seat;
      // In pass-and-play, the "Next round" button can be pressed by anyone.
      E.applyAction(this.state, seat, action);
      this.emit();
      this.scheduleCpu();
    } catch (e) {
      if (e instanceof E.YanivError) this.emit(e.message); else throw e;
    }
  };
  LocalSession.prototype.scheduleCpu = function () {
    var self = this, s = this.state;
    clearTimeout(this.timer);
    if (s.phase !== 'discard' && s.phase !== 'slap') return;
    var actor = s.phase === 'slap' ? s.slap.playerId : s.turn;
    var p = s.players[actor];
    if (p.type !== 'cpu') {
      // A human has a pending slap choice but the next player is a computer: wait for the human.
      return;
    }
    this.timer = setTimeout(function () {
      var actions = AI.decide(self.state, actor);
      if (!actions.length) return;
      E.applyAction(self.state, actor, actions[0]);
      self.emit();
      self.scheduleCpu();
    }, s.phase === 'slap' ? CPU_SLAP_DELAY : CPU_DELAY);
  };
  LocalSession.prototype.start = function () { this.scheduleCpu(); };
  LocalSession.prototype.leave = function () { clearTimeout(this.timer); this.listeners = []; };

  // ------------------------------------------------------------------ online

  function wsUrl() {
    var loc = root.location;
    return (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + '/ws';
  }

  function OnlineSession(opts) {
    this.listeners = [];
    this.mode = 'online';
    this.name = opts.name;
    this.code = opts.code || null;
    this.rules = opts.rules || null;
    this.seat = null;
    this.retry = 0;
    this.closed = false;
    this.last = null;
    this.connect();
  }
  OnlineSession.tokenFor = function (code) { var t = load('yaniv.tokens') || {}; return t[code]; };
  function saveToken(code, token) { var t = load('yaniv.tokens') || {}; t[code] = token; store('yaniv.tokens', t); store('yaniv.lastRoom', code); }

  OnlineSession.prototype.connect = function () {
    var self = this;
    var ws = this.ws = new WebSocket(wsUrl());
    ws.onopen = function () {
      self.retry = 0;
      if (self.code) self.send({ t: 'join', code: self.code, name: self.name, token: OnlineSession.tokenFor(self.code) });
      else self.send({ t: 'create', name: self.name, rules: self.rules });
    };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'joined') { self.code = m.code; self.seat = m.seat; saveToken(m.code, m.token); return; }
      if (m.t === 'error') { self.push({ error: m.msg, fatal: !!m.fatal }); if (m.fatal) self.leave(); return; }
      if (m.t === 'room') {
        self.seat = m.seat;
        self.push({ room: m.room, view: m.view, seat: m.seat, error: null });
      }
    };
    ws.onclose = function () {
      if (self.closed) return;
      self.push({ offline: true });
      var wait = Math.min(8000, 500 * Math.pow(2, self.retry++));
      setTimeout(function () { if (!self.closed) self.connect(); }, wait);
    };
  };
  OnlineSession.prototype.push = function (patch) {
    var base = this.last || { mode: 'online', passAndPlay: false };
    var next = {};
    Object.keys(base).forEach(function (k) { next[k] = base[k]; });
    next.offline = false;
    Object.keys(patch).forEach(function (k) { next[k] = patch[k]; });
    next.mode = 'online';
    this.last = next;
    this.listeners.forEach(function (fn) { fn(next); });
  };
  OnlineSession.prototype.send = function (m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); };
  OnlineSession.prototype.onUpdate = function (fn) { this.listeners.push(fn); if (this.last) fn(this.last); };
  OnlineSession.prototype.act = function (action) { this.send({ t: 'act', action: action }); };
  OnlineSession.prototype.lobby = function (m) { this.send(m); }; // addBot, removeSeat, start, rules
  OnlineSession.prototype.start = function () {};
  OnlineSession.prototype.leave = function () {
    this.closed = true; this.listeners = [];
    try { this.send({ t: 'leave' }); this.ws.close(); } catch (e) {}
  };

  root.YanivSession = { LocalSession: LocalSession, OnlineSession: OnlineSession, store: store, load: load };
})(typeof globalThis !== 'undefined' ? globalThis : this);
