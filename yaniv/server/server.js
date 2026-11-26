/*
 * Yaniv online server.
 *
 * - Serves the web app from ../public.
 * - Hosts game rooms over WebSocket at /ws. The server is authoritative: it keeps the
 *   full game state and sends each player only what they may see (YanivEngine.viewFor).
 *   Clients send intents ({type:'play', ...}); the shared engine validates them.
 * - Rooms live in memory. That is fine for game nights; a restart ends running games.
 *
 * Run:  npm install && npm start      (PORT env var, default 8080)
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const E = require('../public/js/engine.js');
const AI = require('../public/js/ai.js');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC = path.join(__dirname, '..', 'public');
const BOT_DELAY = 1100;
const SLAP_WINDOW = 5000;       // a human gets this long to decide on a slap-down
const AWAY_TAKEOVER = 25000;    // a disconnected player's turn is played by a bot after this long
const ROOM_IDLE_MS = 6 * 3600 * 1000;
const MAX_ROOMS = 500;

// ---------------------------------------------------------------- static files
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      // the service worker handles offline caching; keep HTTP caching short so updates land
      'Cache-Control': ext === '.html' || p === '/sw.js' ? 'no-cache' : 'public, max-age=300'
    });
    res.end(data);
  });
});

// ---------------------------------------------------------------- rooms
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O

function newCode() {
  for (let i = 0; i < 1000; i++) {
    let c = '';
    for (let k = 0; k < 4; k++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('no codes left');
}
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'Player';
const BOT_NAMES = ['Avi', 'Noa', 'Tal', 'Maya', 'Eli', 'Yael', 'Omer', 'Shira'];

function publicRoom(room) {
  return {
    code: room.code, host: room.host, phase: room.state ? 'game' : 'lobby', rules: room.rules,
    seats: room.seats.map((s) => ({ name: s.name, type: s.type, level: s.level, connected: s.type === 'cpu' || !!s.socket }))
  };
}

function broadcast(room) {
  room.touched = Date.now();
  const pub = publicRoom(room);
  room.seats.forEach((s, i) => {
    if (!s.socket) return;
    send(s.socket, { t: 'room', seat: i, room: pub, view: room.state ? E.viewFor(room.state, i) : null });
  });
}
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function actorOf(state) {
  if (state.phase === 'slap' && state.slap) return state.slap.playerId;
  if (state.phase === 'discard') return state.turn;
  return null;
}

// Decide whether the server needs to act for someone (bot, slap timeout, absent player).
function schedule(room) {
  clearTimeout(room.timer);
  const st = room.state;
  if (!st) return;
  const actor = actorOf(st);
  if (actor === null) return;
  const seat = room.seats[actor];
  let delay, run;
  if (seat.type === 'cpu') {
    delay = st.phase === 'slap' ? 500 : BOT_DELAY;
    run = () => botMove(room, actor);
  } else if (st.phase === 'slap') {
    delay = SLAP_WINDOW;
    run = () => { E.passSlap(st); };
  } else if (!seat.socket) {
    delay = AWAY_TAKEOVER;
    run = () => botMove(room, actor);
  } else return;
  room.timer = setTimeout(() => {
    try { run(); } catch (e) { console.error('server move failed', e); }
    broadcast(room);
    schedule(room);
  }, delay);
}

function botMove(room, seat) {
  const st = room.state;
  if (!st.players[seat].level) st.players[seat].level = 'normal';
  const actions = AI.decide(st, seat);
  if (actions.length) E.applyAction(st, seat, actions[0]);
  if (process.env.DEBUG) console.log(room.code, 'bot for seat', seat, JSON.stringify(actions[0]));
}

function startGame(room) {
  room.state = E.newGame(room.seats.map((s) => ({ name: s.name, type: s.type, level: s.level })), room.rules);
  broadcast(room);
  schedule(room);
}

function cleanRules(r) {
  const d = E.DEFAULT_RULES, out = {};
  r = r || {};
  const num = (v, lo, hi, def) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : def);
  out.handSize = num(r.handSize, 3, 7, d.handSize);
  out.yanivMax = num(r.yanivMax, 0, 15, d.yanivMax);
  out.assafPenalty = num(r.assafPenalty, 0, 100, d.assafPenalty);
  out.eliminateAbove = num(r.eliminateAbove, 50, 1000, d.eliminateAbove);
  out.fiftyRule = ['subtract', 'halve', 'none'].includes(r.fiftyRule) ? r.fiftyRule : d.fiftyRule;
  out.minRun = num(r.minRun, 3, 5, d.minRun);
  out.slapDown = r.slapDown === undefined ? d.slapDown : !!r.slapDown;
  out.noYanivFirstTurn = !!r.noYanivFirstTurn;
  return out;
}

// ---------------------------------------------------------------- websocket
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    try { handle(ws, m); } catch (e) {
      if (e instanceof E.YanivError) send(ws, { t: 'error', msg: e.message });
      else { console.error(e); send(ws, { t: 'error', msg: 'Something went wrong.' }); }
    }
  });
  ws.on('close', () => {
    const room = ws.room && rooms.get(ws.room);
    if (!room) return;
    const seat = room.seats.find((s) => s.socket === ws);
    if (!seat) return;
    seat.socket = null;
    if (!room.state && !seat.keep) {
      // left the lobby for good only on an explicit leave; a dropped connection keeps the seat
    }
    broadcast(room);
    schedule(room);
  });
});

function seatOf(ws) {
  const room = ws.room && rooms.get(ws.room);
  if (!room) throw new E.YanivError('You are not in a room.');
  const i = room.seats.findIndex((s) => s.socket === ws);
  if (i < 0) throw new E.YanivError('You are not in a room.');
  return { room, i };
}

function handle(ws, m) {
  switch (m.t) {
    case 'create': {
      if (rooms.size >= MAX_ROOMS) throw new E.YanivError('The server is full, try again later.');
      const code = newCode();
      const token = crypto.randomBytes(16).toString('hex');
      const room = { code, host: 0, rules: cleanRules(m.rules), state: null, timer: null, touched: Date.now(),
        seats: [{ name: cleanName(m.name), type: 'human', token, socket: ws }] };
      rooms.set(code, room);
      ws.room = code;
      send(ws, { t: 'joined', code, seat: 0, token });
      return broadcast(room);
    }
    case 'join': {
      const code = String(m.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'error', msg: 'No game with code ' + code + '. Check the code with the host.', fatal: true });
      // Rejoin with a saved token (refresh, phone went to sleep, lost signal).
      let i = m.token ? room.seats.findIndex((s) => s.type === 'human' && s.token === m.token) : -1;
      if (i >= 0) {
        if (room.seats[i].socket && room.seats[i].socket !== ws) try { room.seats[i].socket.close(); } catch (e) {}
        room.seats[i].socket = ws;
      } else {
        if (room.state) return send(ws, { t: 'error', msg: 'That game has already started.', fatal: true });
        if (room.seats.length >= 8) return send(ws, { t: 'error', msg: 'That game is full (8 players).', fatal: true });
        const token = crypto.randomBytes(16).toString('hex');
        room.seats.push({ name: cleanName(m.name), type: 'human', token, socket: ws });
        i = room.seats.length - 1;
      }
      ws.room = code;
      send(ws, { t: 'joined', code, seat: i, token: room.seats[i].token });
      broadcast(room);
      return schedule(room);
    }
    case 'addBot': {
      const { room, i } = seatOf(ws);
      if (i !== room.host) throw new E.YanivError('Only the host can add computer players.');
      if (room.state) throw new E.YanivError('The game has started.');
      if (room.seats.length >= 8) throw new E.YanivError('8 players is the most.');
      const used = new Set(room.seats.map((s) => s.name));
      const name = BOT_NAMES.find((n) => !used.has(n)) || 'Bot ' + room.seats.length;
      room.seats.push({ name, type: 'cpu', level: ['easy', 'normal', 'hard'].includes(m.level) ? m.level : 'normal' });
      return broadcast(room);
    }
    case 'removeSeat': {
      const { room, i } = seatOf(ws);
      if (i !== room.host) throw new E.YanivError('Only the host can remove players.');
      if (room.state) throw new E.YanivError('The game has started.');
      const k = Number(m.seat);
      if (!(k > 0 && k < room.seats.length)) throw new E.YanivError('No such seat.');
      const gone = room.seats.splice(k, 1)[0];
      if (gone.socket) { send(gone.socket, { t: 'error', msg: 'The host removed you from the game.', fatal: true }); gone.socket.room = null; }
      return broadcast(room);
    }
    case 'rules': {
      const { room, i } = seatOf(ws);
      if (i !== room.host || room.state) throw new E.YanivError('Only the host can change rules before the game.');
      room.rules = cleanRules(m.rules);
      return broadcast(room);
    }
    case 'start': {
      const { room, i } = seatOf(ws);
      if (i !== room.host) throw new E.YanivError('Only the host can start.');
      if (room.state && room.state.phase !== 'gameOver') throw new E.YanivError('The game is already running.');
      if (room.seats.length < 2) throw new E.YanivError('Add at least one more player or a computer player.');
      return startGame(room);
    }
    case 'act': {
      const { room, i } = seatOf(ws);
      if (!room.state) throw new E.YanivError('The game has not started.');
      // two people tapping "Next round" at once: the second tap is harmless, not an error
      if (m.action && m.action.type === 'nextRound' && room.state.phase !== 'roundOver') return;
      E.applyAction(room.state, i, m.action || {});
      if (process.env.DEBUG) console.log(room.code, 'seat', i, JSON.stringify(m.action));
      broadcast(room);
      return schedule(room);
    }
    case 'leave': {
      const room = ws.room && rooms.get(ws.room);
      if (!room) return;
      const i = room.seats.findIndex((s) => s.socket === ws);
      ws.room = null;
      if (i < 0) return;
      if (!room.state) {
        room.seats.splice(i, 1);
        if (!room.seats.some((s) => s.type === 'human')) { rooms.delete(room.code); return; }
        if (room.host === i || room.host >= room.seats.length) room.host = room.seats.findIndex((s) => s.type === 'human');
        else if (i < room.host) room.host -= 1;
      } else {
        room.seats[i].socket = null; // seat stays; a bot covers their turns
      }
      broadcast(room);
      return schedule(room);
    }
  }
}

// Heartbeat (drops dead mobile connections) and idle room cleanup.
setInterval(() => {
  wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = room.seats.some((s) => s.socket);
    if (!anyone && now - room.touched > ROOM_IDLE_MS) { clearTimeout(room.timer); rooms.delete(code); }
  }
}, 30000);

server.listen(PORT, () => console.log('Yaniv server on http://localhost:' + PORT));
module.exports = { server, rooms };
