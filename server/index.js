'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game, TICK } = require('./game');
const { LEVELS, ITEMS } = require('./levels');
const store = require('./store');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const MAX_PLAYERS = 6;
const SNAPSHOT_EVERY = 2; // ticks -> 15 snapshots/s
const INTRO_MAX_SECONDS = 120;

// Survivor skins unlock by surviving nights (cosmetic only).
const SURVIVORS = [
  { id: 0, name: 'Blue', wins: 0 },
  { id: 1, name: 'Amber', wins: 1 },
  { id: 2, name: 'Purple', wins: 3 },
];
function survivorUnlocked(profile, id) { const s = SURVIVORS[id]; return !!s && (profile.wins || 0) >= s.wins; }

// Tonight's Night: one seeded map for everyone, changing at midnight UTC.
function tonight() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  let h = 2166136261; for (const ch of date) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const seed = h >>> 0;
  const day = Math.floor(now.getTime() / 86400000);
  const level = 2 + (day % 5); // nights 2..6: tough enough to matter, open to everyone
  const L = LEVELS[level - 1];
  const resetAt = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return { date, seed, level, name: L.name, difficulty: L.difficulty, resetsIn: Math.max(0, Math.floor((resetAt - now.getTime()) / 1000)), scores: store.topDaily(date, 10) };
} // safety limit for the cinematic hold if a client never reports ready

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

// ------------------------------------------------------------------ http
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/scores') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(store.topScores(50)));
  }
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  let file = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (file === '/' || file === '\\') file = '/index.html';
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ------------------------------------------------------------------ rooms
const rooms = new Map(); // code -> Room
const clients = new Map(); // ws -> Client

function roomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  do { c = ''; for (let i = 0; i < 4; i++) c += alphabet[crypto.randomInt(alphabet.length)]; } while (rooms.has(c));
  return c;
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // id -> Client
    this.hostId = null;
    this.level = 1;
    this.game = null;
    this.timer = null;
    this.tick = 0;
    this.introShown = false;
    this.mode = 'night'; // or 'tonight'
    this.public = true;
  }
  broadcast(msg, except) {
    const data = JSON.stringify(msg);
    for (const c of this.players.values()) if (c !== except && c.ws.readyState === 1) c.ws.send(data);
  }
  maxUnlocked() {
    let m = 1;
    for (const c of this.players.values()) m = Math.max(m, c.profile.unlocked);
    return Math.min(m, LEVELS.length);
  }
  lobbyPacket() {
    return {
      t: 'room', code: this.code, host: this.hostId, level: this.level, unlocked: this.maxUnlocked(), inGame: !!this.game,
      mode: this.mode, public: this.public, tonight: tonight(),
      players: [...this.players.values()].map((c) => ({ id: c.id, name: c.name, items: c.profile.items, unlocked: c.profile.unlocked, wins: c.profile.wins, survivor: c.profile.survivor || 0 })),
    };
  }
  sendLobby() { this.broadcast(this.lobbyPacket()); }

  start() {
    if (this.game) return;
    const tn = this.mode === 'tonight' ? tonight() : null;
    const level = tn ? tn.level : Math.max(1, Math.min(this.level, this.maxUnlocked()));
    this.level = level;
    this.tonightDate = tn ? tn.date : null;
    const roster = [...this.players.values()].map((c) => ({ id: c.id, name: c.name, profile: c.profile }));
    // the cinematic plays once per room; the night stays frozen while it runs
    const intro = !this.introShown;
    this.introShown = true;
    try {
      this.game = new Game(level, roster, (type, payload) => this.onGameEmit(type, payload), { intro, warmup: intro ? INTRO_MAX_SECONDS : 4, seed: tn ? tn.seed : undefined, mode: this.mode });
    } catch (e) {
      console.error('[room] failed to start game', e);
      return this.broadcast({ t: 'error', msg: 'The map refused to be born. Try again.' });
    }
    this.broadcast({ t: 'start', ...this.game.initPacket() });
    this.tick = 0;
    this.timer = setInterval(() => this.loop(), TICK * 1000);
    broadcastRooms();
  }

  loop() {
    const g = this.game;
    if (!g) return;
    g.step();
    this.tick++;
    if (g.status !== 'running') { this.stopLoop(); return; }
    if (this.tick % SNAPSHOT_EVERY === 0) {
      const snap = g.snapshot();
      this.handleEvents(snap.events);
      this.broadcast({ t: 'state', ...snap });
    }
  }

  // Persist item pickups immediately so a disconnect does not lose the relic.
  handleEvents(events) {
    for (const e of events) {
      if (e.kind === 'item') {
        const c = this.players.get(e.byId);
        if (c) {
          c.profile = store.updateProfile(c.name, (p) => { if (!p.items.includes(e.item)) p.items.push(e.item); });
          e.itemName = ITEMS[e.item] ? ITEMS[e.item].name : e.item;
          e.itemDesc = ITEMS[e.item] ? ITEMS[e.item].desc : '';
        }
      }
    }
  }

  onGameEmit(type, result) {
    if (type !== 'finished') return;
    const g = this.game;
    // flush remaining events with the final snapshot
    const snap = g.snapshot();
    this.handleEvents(snap.events);
    this.broadcast({ t: 'state', ...snap });
    const names = [...this.players.values()].map((c) => c.name);
    if (!names.length) { // everyone left mid-night: nothing to record
      this.stopLoop(); this.game = null; return;
    }
    if (result.won) {
      for (const c of this.players.values()) {
        c.profile = store.updateProfile(c.name, (p) => {
          p.unlocked = Math.max(p.unlocked, Math.min(LEVELS.length, g.level + 1));
          p.wins++;
          p.best = Math.max(p.best, result.score);
        });
      }
    }
    const entry = { team: names, score: result.score, level: g.level, levelName: g.levelName || result.levelName, won: result.won, escaped: result.escaped, timeLeft: result.timeLeft, at: Date.now() };
    if (this.tonightDate && (result.won || result.elapsed >= 30)) store.addDailyScore(this.tonightDate, entry);
    if (result.won || result.elapsed >= 30) store.addScore({ team: names, score: result.score, level: g.level, levelName: g.levelName || result.levelName, won: result.won, escaped: result.escaped, timeLeft: result.timeLeft, at: Date.now() });
    this.broadcast({ t: 'end', ...result, scores: store.topScores(20), unlocked: this.maxUnlocked(), tonight: this.tonightDate ? tonight() : null, survivorUnlocks: SURVIVORS });
    this.stopLoop();
    this.game = null;
    this.sendLobby();
    broadcastRooms();
  }

  stopLoop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  remove(client) {
    this.players.delete(client.id);
    if (this.game) this.game.removePlayer(client.id);
    if (this.players.size === 0) {
      this.stopLoop();
      this.game = null;
      rooms.delete(this.code);
      broadcastRooms();
      return;
    }
    if (this.hostId === client.id) this.hostId = this.players.keys().next().value;
    this.sendLobby();
    broadcastRooms();
  }
}

// Open rooms anyone can join from the lobby.
function publicRooms() {
  const out = [];
  for (const r of rooms.values()) {
    if (!r.public || r.game || r.players.size >= MAX_PLAYERS) continue;
    const host = r.players.get(r.hostId);
    out.push({ code: r.code, host: host ? host.name : '?', players: r.players.size, max: MAX_PLAYERS, level: r.level, mode: r.mode });
  }
  return out.slice(0, 30);
}
function broadcastRooms() {
  const data = JSON.stringify({ t: 'rooms', rooms: publicRooms() });
  for (const c of clients.values()) if (!c.room && c.ws.readyState === 1) c.ws.send(data);
}

// ------------------------------------------------------------------ ws
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  const client = { ws, id: crypto.randomBytes(6).toString('hex'), name: null, room: null, profile: null, lastInput: 0 };
  clients.set(ws, client);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  send(ws, { t: 'hello', id: client.id, levels: LEVELS.map(publicLevel), items: ITEMS, scores: store.topScores(20), tonight: tonight(), rooms: publicRooms(), survivors: SURVIVORS });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try { handle(client, msg); } catch (e) { console.error('[ws] handler error', e); }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (client.room) client.room.remove(client);
  });
});

function publicLevel(L) {
  return { n: L.n, name: L.name, difficulty: L.difficulty, time: L.time, monsters: L.monsters, vision: L.vision, keys: L.keys, fragments: L.fragments, item: L.item, intro: L.intro };
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function cleanName(n) {
  const s = String(n || '').replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, 16);
  return s || 'Stranger';
}

function handle(c, msg) {
  switch (msg.t) {
    case 'join': {
      if (c.room) c.room.remove(c);
      c.name = cleanName(msg.name);
      c.profile = store.getProfile(c.name);
      let room;
      if (msg.room) {
        room = rooms.get(String(msg.room).toUpperCase().trim());
        if (!room) return send(c.ws, { t: 'error', msg: 'No such room. The house is empty.' });
        if (room.players.size >= MAX_PLAYERS) return send(c.ws, { t: 'error', msg: 'That room is full.' });
        if (room.game) return send(c.ws, { t: 'error', msg: 'A night is already underway in that room. Wait for it to end.' });
      } else {
        room = new Room(roomCode());
        rooms.set(room.code, room);
      }
      c.room = room;
      room.players.set(c.id, c);
      if (!room.hostId) room.hostId = c.id;
      send(c.ws, { t: 'joined', code: room.code, id: c.id, profile: c.profile });
      room.sendLobby();
      broadcastRooms();
      break;
    }
    case 'leave': {
      if (c.room) { c.room.remove(c); c.room = null; }
      send(c.ws, { t: 'left', rooms: publicRooms(), tonight: tonight() });
      break;
    }
    case 'setMode': {
      const r = c.room; if (!r || r.hostId !== c.id || r.game) return;
      r.mode = msg.mode === 'tonight' ? 'tonight' : 'night';
      r.sendLobby(); broadcastRooms();
      break;
    }
    case 'setPublic': {
      const r = c.room; if (!r || r.hostId !== c.id) return;
      r.public = !!msg.public;
      r.sendLobby(); broadcastRooms();
      break;
    }
    case 'setSurvivor': {
      const id = Number(msg.survivor) | 0;
      if (!c.profile || !survivorUnlocked(c.profile, id)) return;
      c.profile = store.updateProfile(c.name, (p) => { p.survivor = id; });
      if (c.room) c.room.sendLobby();
      break;
    }
    case 'flare': {
      const r = c.room; if (!r || !r.game) return;
      r.game.dropFlare(c.id);
      break;
    }
    case 'rooms':
      send(c.ws, { t: 'rooms', rooms: publicRooms() });
      break;
    case 'setLevel': {
      const r = c.room; if (!r || r.hostId !== c.id || r.game) return;
      const lv = Number(msg.level) | 0;
      if (lv >= 1 && lv <= r.maxUnlocked()) { r.level = lv; r.mode = 'night'; r.sendLobby(); broadcastRooms(); }
      break;
    }
    case 'start': {
      const r = c.room; if (!r || r.hostId !== c.id || r.game) return;
      r.start();
      break;
    }
    case 'ready': { // the client's cinematic ended or was skipped
      const r = c.room; if (!r || !r.game) return;
      r.game.markReady(c.id);
      break;
    }
    case 'input': {
      const r = c.room; if (!r || !r.game) return;
      r.game.setInput(c.id, msg.dx, msg.dy);
      break;
    }
    case 'solve': {
      const r = c.room; if (!r || !r.game) return;
      r.game.trySolve(c.id, Array.isArray(msg.seq) ? msg.seq.slice(0, 12).map(String) : []);
      break;
    }
    case 'scores':
      send(c.ws, { t: 'scores', scores: store.topScores(50) });
      break;
    case 'ping':
      send(c.ws, { t: 'pong', ts: msg.ts });
      break;
    default:
      break;
  }
}

// heartbeat: drop dead sockets
const hb = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => console.log(`Nightfall is listening on http://localhost:${PORT}`));

function shutdown() {
  clearInterval(hb);
  store.flushAll();
  for (const r of rooms.values()) r.stopLoop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
