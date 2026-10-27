'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Game, TICK } = require('./game');
const { LEVELS, ITEMS } = require('./levels');
const store = require('./store');
const analytics = require('./analytics');
const { generate } = require('./mapgen');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const validDid = (d) => (typeof d === 'string' && /^[a-z0-9]{8,32}$/.test(d) ? d : null);

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
  if (url.pathname === '/admin/stats' || url.pathname === '/admin/stats.json') return adminStats(url, res);
  let file = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (file === '/' || file === '\\') file = '/index.html';
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    // assets (atlases, video, audio) are big and rarely change: let the browser keep them.
    const isAsset = file.startsWith('/assets/') || file.startsWith('\\assets\\');
    const isVideo = /\.(mp4|webm)$/i.test(file);
    const cache = isVideo ? 'public, max-age=604800' : isAsset ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': cache, 'Content-Length': data.length });
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
    this.gid = `${this.code}-${Date.now().toString(36)}`;
    analytics.track('start', { gid: this.gid, level, mode: this.mode, players: this.players.size, intro, dids: [...this.players.values()].map((c) => c.did).filter(Boolean) });
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
      if (e.kind === 'caught') {
        const c = this.players.get(e.whoId), g = this.game;
        analytics.track('death', { gid: this.gid, level: g.level, mode: g.mode, date: this.tonightDate || undefined, did: c && c.did, monster: e.type, elapsed: Math.round(g.elapsed), x: Math.round(e.x * 10) / 10, y: Math.round(e.y * 10) / 10, players: this.players.size });
      }
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
    analytics.track('end', { gid: this.gid, level: g.level, mode: g.mode, won: result.won, elapsed: result.elapsed, reason: result.reason, frags: result.frags, keys: result.keys, players: names.length, dids: [...this.players.values()].map((c) => c.did).filter(Boolean) });
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
    if (this.game && this.game.status === 'running') {
      const p = this.game.players.get(client.id);
      analytics.track('quit', { gid: this.gid, level: this.game.level, mode: this.game.mode, did: client.did, elapsed: Math.round(this.game.elapsed), down: !!(p && p.down), escaped: !!(p && p.escaped) });
    }
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
  return s || `Stranger-${crypto.randomInt(1000, 9999)}`;
}

function handle(c, msg) {
  switch (msg.t) {
    case 'join': {
      // slow down guessing: at most 8 failed name claims per connection per minute
      const now = Date.now();
      c.fails = (c.fails || []).filter((t) => now - t < 60000);
      if (c.fails.length >= 8) return send(c.ws, { t: 'error', msg: 'Too many tries. Wait a minute.' });
      const name = cleanName(msg.name);
      // check the room before claiming, so a typo in the code never claims a name
      if (msg.room) {
        const r = rooms.get(String(msg.room).toUpperCase().trim());
        if (!r) return send(c.ws, { t: 'error', msg: 'No such room. The house is empty.' });
      }
      const claim = store.claimProfile(name, typeof msg.secret === 'string' ? msg.secret.slice(0, 40) : '');
      if (!claim.ok) {
        c.fails.push(now);
        return send(c.ws, { t: 'error', code: 'name_taken', name, msg: `"${name}" belongs to another player. Pick another name, or enter your recovery code.` });
      }
      if (c.room) c.room.remove(c);
      c.name = claim.profile.name;
      c.profile = claim.profile;
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
      if (validDid(msg.did)) c.did = validDid(msg.did);
      analytics.track('join', { did: c.did, created: !!claim.code, public: !msg.room });
      send(c.ws, { t: 'joined', code: room.code, id: c.id, name: c.name, profile: store.publicProfile(c.profile), secret: claim.code || undefined });
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
      if (msg.how === 'ended' || msg.how === 'skipped') analytics.track('intro', { did: c.did, how: msg.how, secs: Math.round(Number(msg.secs) || 0) });
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
    case 'visit': {
      c.did = validDid(msg.did) || c.did;
      if (!c.visited) { c.visited = true; analytics.track('visit', { did: c.did, touch: !!msg.touch, first: !!msg.first }); }
      break;
    }
    case 'tut': {
      const step = String(msg.step || '').replace(/[^a-z_]/g, '').slice(0, 20);
      if (step) analytics.track('tut', { did: c.did, step, skipped: !!msg.skipped });
      break;
    }
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
  analytics.flush();
  for (const r of rooms.values()) r.stopLoop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);


// ------------------------------------------------------------------ admin stats
// A private page for the owner: set ADMIN_TOKEN in the environment and open
// /admin/stats?token=<that value>. Disabled when ADMIN_TOKEN is not set.
function tokenOk(given) {
  if (!ADMIN_TOKEN || !given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}
function escHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

function adminStats(url, res) {
  if (!ADMIN_TOKEN) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Stats are disabled. Set the ADMIN_TOKEN environment variable to enable them.'); }
  if (!tokenOk(url.searchParams.get('token'))) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('Forbidden'); }
  const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 7));
  const sum = analytics.summary({ days });
  const tn = tonight();
  const map = generate(LEVELS[tn.level - 1], tn.seed);
  const heat = { W: map.W, H: map.H, tiles: Array.from(map.tiles).join(''), deaths: analytics.tonightDeaths(tn.date), name: tn.name, date: tn.date };
  if (url.pathname.endsWith('.json')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ...sum, tonight: { date: heat.date, name: heat.name, deaths: heat.deaths } }));
  }
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');
  const top = sum.funnel[0][1];
  const bars = (obj, label) => {
    const entries = Object.entries(obj).sort((a, b) => Number(a[0]) - Number(b[0]) || b[1] - a[1]);
    const max = Math.max(1, ...entries.map((e) => e[1]));
    return entries.length ? entries.map(([k, v]) => `<div class="bar"><span>${escHtml(label(k))}</span><i style="width:${(v / max) * 100}%"></i><b>${v}</b></div>`).join('') : '<p class="dim">No data yet.</p>';
  };
  const tutOrder = ['move', 'rune', 'key', 'monster', 'altar', 'exit', 'done'];
  const tutRows = tutOrder.filter((s) => sum.tutorial.steps[s] !== undefined).map((s) => `<tr><td>${s}</td><td>${sum.tutorial.steps[s]}</td></tr>`).join('') || '<tr><td colspan="2" class="dim">No data yet.</td></tr>';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nightfall stats</title>
<style>
:root{--bg:#0b0710;--panel:#160f1e;--ink:#e6dcef;--dim:#8a7f96;--accent:#f28c28;--line:#2d2038}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif;padding:16px}
h1{color:var(--accent);font-weight:600;margin:0 0 4px}h2{font-size:15px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin:0 0 10px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));max-width:1200px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;overflow-x:auto}
table{border-collapse:collapse;width:100%}td,th{padding:5px 8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}th{color:var(--dim);font-weight:500;font-size:13px}
.dim{color:var(--dim)}.big{font-size:28px;color:var(--accent);font-weight:600}
.bar{display:grid;grid-template-columns:90px 1fr 40px;align-items:center;gap:8px;margin:4px 0}.bar i{display:block;height:10px;background:var(--accent);border-radius:3px}.bar b{text-align:right;font-weight:500}
canvas{width:100%;max-width:520px;image-rendering:pixelated;border:1px solid var(--line);border-radius:6px;background:#000}
a{color:var(--accent)}
</style></head><body>
<h1>Nightfall stats</h1>
<p class="dim">Last ${days} day${days > 1 ? 's' : ''} · ${sum.total} events · <a href="?token=${encodeURIComponent(url.searchParams.get('token'))}&days=1">1d</a> <a href="?token=${encodeURIComponent(url.searchParams.get('token'))}&days=7">7d</a> <a href="?token=${encodeURIComponent(url.searchParams.get('token'))}&days=30">30d</a> · devices: ${sum.devices.touch} phone/tablet, ${sum.devices.desktop} desktop</p>
<div class="grid">
<div class="card"><h2>Funnel (unique devices)</h2><table><tr><th>Step</th><th>Devices</th><th>Of visitors</th></tr>${sum.funnel.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td><td>${pct(v, top)}</td></tr>`).join('')}</table></div>
<div class="card"><h2>Nights</h2><table><tr><th>Night</th><th>Starts</th><th>Win rate</th><th>Avg length</th><th>Deaths</th><th>Quits</th><th>Top killer</th></tr>${sum.perLevel.map((l) => `<tr><td>${l.level}</td><td>${l.starts}</td><td>${l.winRate === null ? '–' : l.winRate + '%'}</td><td>${l.avgSecs === null ? '–' : Math.floor(l.avgSecs / 60) + ':' + String(l.avgSecs % 60).padStart(2, '0')}</td><td>${l.deaths}</td><td>${l.quits}</td><td>${escHtml(l.topKiller || '–')}</td></tr>`).join('') || '<tr><td colspan="7" class="dim">No nights played yet.</td></tr>'}</table></div>
<div class="card"><h2>Deaths by monster</h2>${bars(sum.byMonster, (k) => k)}</div>
<div class="card"><h2>Deaths by minute into the night</h2>${bars(sum.deathMinute, (k) => `${k}–${Number(k) + 1} min`)}</div>
<div class="card"><h2>Quits by minute into the night</h2>${bars(sum.quitMinute, (k) => `${k}–${Number(k) + 1} min`)}<p class="dim">Includes dropped connections.</p></div>
<div class="card"><h2>Tutorial (unique devices per step)</h2><table><tr><th>Step</th><th>Devices</th></tr>${tutRows}</table><p class="dim">Skipped ${sum.tutorial.skips} time${sum.tutorial.skips === 1 ? '' : 's'}.</p></div>
<div class="card"><h2>Intro video</h2><p><span class="big">${sum.intro.watched}</span> watched to the end · <span class="big">${sum.intro.skipped}</span> skipped${sum.intro.avgSkipAt !== null ? `, on average at ${sum.intro.avgSkipAt}s` : ''}</p></div>
<div class="card"><h2>Where players die on Tonight's Night</h2><p class="dim">${escHtml(heat.name)} · ${heat.date} · ${heat.deaths.length} death${heat.deaths.length === 1 ? '' : 's'}</p><canvas id="heat"></canvas></div>
</div>
<script>
const H=${JSON.stringify(heat)};
const c=document.getElementById('heat'),k=8;c.width=H.W*k;c.height=H.H*k;const x=c.getContext('2d');
for(let y=0;y<H.H;y++)for(let i=0;i<H.W;i++){const t=+H.tiles[y*H.W+i];x.fillStyle=t===1?'#140d1b':t===2?'#7a4a22':t===3?'#5ad17a':t===4?'#b67ae6':'#3a3044';x.fillRect(i*k,y*k,k,k);}
const col={zombie:'#7fbf5a',ghost:'#bfe8ff',crawler:'#ff5a6a',imp:'#ff9a3a',demon:'#ff2a2a'};
for(const d of H.deaths){const g=x.createRadialGradient(d.x*k,d.y*k,0,d.x*k,d.y*k,k*2.5);g.addColorStop(0,'rgba(255,40,40,.55)');g.addColorStop(1,'rgba(255,40,40,0)');x.fillStyle=g;x.beginPath();x.arc(d.x*k,d.y*k,k*2.5,0,7);x.fill();x.fillStyle=col[d.monster]||'#fff';x.beginPath();x.arc(d.x*k,d.y*k,k*0.45,0,7);x.fill();}
</script></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  res.end(html);
}
