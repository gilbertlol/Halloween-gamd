'use strict';

// Anonymous gameplay analytics: where players die, when they quit, how far
// they get. Events carry a random per-device id (never a name), are kept in
// memory and appended to DATA_DIR/events.ndjson so they survive restarts
// when the data folder is on a persistent disk.

const fs = require('fs');
const path = require('path');
const db = require('./db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'events.ndjson');
const MAX_EVENTS = 50000; // kept in memory
const MAX_FILE = 20 * 1024 * 1024; // rotate at 20 MB

let events = [];
let buffer = [];
let flushTimer = null;
let enabled = true;

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(FILE)) return;
    const lines = fs.readFileSync(FILE, 'utf8').split('\n');
    for (const line of lines.slice(-MAX_EVENTS)) {
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { /* skip a torn line */ }
    }
  } catch (e) { console.error('[analytics] load failed:', e.message); }
}

let useDb = false;
let dbWriting = null;
const RETAIN_DAYS = 60; // keeps the free database tier small

function flush() {
  flushTimer = null;
  if (!buffer.length) return dbWriting || Promise.resolve();
  if (useDb) {
    if (dbWriting) { if (!flushTimer) flushTimer = setTimeout(flush, 2000); return dbWriting; }
    const batch = buffer; buffer = [];
    dbWriting = db.insertEvents(batch).catch((e) => {
      console.error('[analytics] database write failed, will retry:', e.message);
      buffer = batch.concat(buffer).slice(-20000); // keep at most 20k unsent events
      if (!flushTimer) flushTimer = setTimeout(flush, 10000);
    }).finally(() => { dbWriting = null; });
    return dbWriting;
  }
  const chunk = buffer.map((e) => JSON.stringify(e)).join('\n') + '\n';
  buffer = [];
  try {
    if (fs.existsSync(FILE) && fs.statSync(FILE).size > MAX_FILE) fs.renameSync(FILE, FILE.replace(/\.ndjson$/, '.1.ndjson'));
    fs.appendFileSync(FILE, chunk);
  } catch (e) { console.error('[analytics] write failed:', e.message); }
  return Promise.resolve();
}

// Use the database when connected: load recent events and prune old ones daily.
async function init() {
  if (!db.ready) return 'files';
  useDb = true;
  const since = Date.now() - 30 * 86400000;
  events = await db.recentEvents(since, MAX_EVENTS);
  const prune = () => db.pruneEvents(Date.now() - RETAIN_DAYS * 86400000).then((n) => { if (n) console.log(`[analytics] pruned ${n} old events`); }).catch((e) => console.error('[analytics] prune failed:', e.message));
  prune(); setInterval(prune, 86400000).unref();
  console.log(`[analytics] using the database: ${events.length} recent events loaded`);
  return 'database';
}

function track(type, data) {
  if (!enabled) return;
  const e = { t: type, at: Date.now(), ...data };
  events.push(e);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  buffer.push(e);
  if (!flushTimer) flushTimer = setTimeout(flush, 2000);
}

function reset() { events = []; buffer = []; } // tests only
function setEnabled(v) { enabled = !!v; }

// ---------------------------------------------------------------- summary
function summary({ days = 7, now = Date.now() } = {}) {
  const since = now - days * 86400000;
  const ev = events.filter((e) => e.at >= since);
  const uniq = (type, pred = () => true) => new Set(ev.filter((e) => e.t === type && pred(e)).map((e) => e.did).filter(Boolean)).size;
  const startDids = new Set();
  for (const e of ev) if (e.t === 'start') for (const d of e.dids || []) startDids.add(d);
  const winDids = new Set();
  for (const e of ev) if (e.t === 'end' && e.won) for (const d of e.dids || []) winDids.add(d);

  const funnel = [
    ['Visited', uniq('visit')],
    ['Joined a room', uniq('join')],
    ['Started a night', startDids.size],
    ['Escaped a night', winDids.size],
  ];

  const levels = {};
  const L = (n) => (levels[n] = levels[n] || { starts: 0, wins: 0, ends: 0, elapsed: 0, deaths: 0, quits: 0, killers: {} });
  for (const e of ev) {
    if (e.t === 'start') L(e.level).starts++;
    if (e.t === 'end') { const l = L(e.level); l.ends++; l.elapsed += e.elapsed || 0; if (e.won) l.wins++; }
    if (e.t === 'death') { const l = L(e.level); l.deaths++; l.killers[e.monster] = (l.killers[e.monster] || 0) + 1; }
    if (e.t === 'quit') L(e.level).quits++;
  }
  const perLevel = Object.entries(levels).sort((a, b) => a[0] - b[0]).map(([n, l]) => {
    const top = Object.entries(l.killers).sort((a, b) => b[1] - a[1])[0];
    return { level: Number(n), starts: l.starts, wins: l.wins, winRate: l.ends ? Math.round((l.wins / l.ends) * 100) : null, avgSecs: l.ends ? Math.round(l.elapsed / l.ends) : null, deaths: l.deaths, quits: l.quits, topKiller: top ? top[0] : null };
  });

  const byMonster = {};
  const deathMinute = {};
  const quitMinute = {};
  for (const e of ev) {
    if (e.t === 'death') { byMonster[e.monster] = (byMonster[e.monster] || 0) + 1; const m = Math.floor((e.elapsed || 0) / 60); deathMinute[m] = (deathMinute[m] || 0) + 1; }
    if (e.t === 'quit') { const m = Math.floor((e.elapsed || 0) / 60); quitMinute[m] = (quitMinute[m] || 0) + 1; }
  }

  const tutSteps = {};
  let tutSkips = 0;
  for (const e of ev) if (e.t === 'tut') { if (e.skipped) tutSkips++; else (tutSteps[e.step] = tutSteps[e.step] || new Set()).add(e.did); }
  const tutorial = { steps: Object.fromEntries(Object.entries(tutSteps).map(([k, v]) => [k, v.size])), skips: tutSkips };

  const intro = { watched: 0, skipped: 0, skipSecs: 0 };
  for (const e of ev) if (e.t === 'intro') { if (e.how === 'ended') intro.watched++; else { intro.skipped++; intro.skipSecs += e.secs || 0; } }
  intro.avgSkipAt = intro.skipped ? Math.round(intro.skipSecs / intro.skipped) : null;

  const devices = { touch: uniq('visit', (e) => e.touch), desktop: uniq('visit', (e) => !e.touch) };

  return { days, since, total: ev.length, funnel, perLevel, byMonster, deathMinute, quitMinute, tutorial, intro, devices };
}

// Deaths on today's shared map (Tonight's Night): same layout for everyone, so positions can be compared.
function tonightDeaths(date) {
  return events.filter((e) => e.t === 'death' && e.mode === 'tonight' && e.date === date).map((e) => ({ x: e.x, y: e.y, monster: e.monster }));
}

if (!process.env.DATABASE_URL) load(); // file mode; the database is loaded in init()
process.on('exit', () => { if (!useDb) flush(); });

module.exports = { init, track, summary, tonightDeaths, flush, reset, setEnabled, _events: () => events };
