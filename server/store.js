'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Persistence for high scores and player profiles. Data lives in memory;
// writes are debounced to either JSON files (default, atomic rename) or a
// Postgres database when DATABASE_URL is set (see db.js), so the data
// survives the host restarting or redeploying.
const db = require('./db');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

class JsonStore {
  constructor(file, initial) {
    this.file = path.join(DATA_DIR, file);
    this.data = initial;
    this.timer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      if (fs.existsSync(this.file)) this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      console.error(`[store] could not load ${file}:`, e.message);
    }
  }
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.db) return this.dbWrite();
      const tmp = this.file + '.tmp';
      try {
        fs.writeFileSync(tmp, JSON.stringify(this.data));
        fs.renameSync(tmp, this.file);
      } catch (e) {
        console.error('[store] save failed:', e.message);
      }
    }, 250);
  }
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.db) return this.dbWrite();
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch (e) { console.error('[store] flush failed:', e.message); }
    return Promise.resolve();
  }
  // database writes: the whole document for the score boards, or only the
  // changed rows for profiles. A failed write is retried on the next save.
  dbWrite() {
    if (this.writing) { this.again = true; return this.writing; }
    const job = this.db === 'kv' ? db.setKV(this.dbKey, this.data) : (() => {
      const keys = [...this.dirty]; this.dirty.clear();
      return db.upsertProfiles(keys.filter((k) => this.data.byName[k]).map((k) => [k, this.data.byName[k]])).catch((e) => { for (const k of keys) this.dirty.add(k); throw e; });
    })();
    this.writing = job.catch((e) => { console.error(`[store] database write failed (${this.dbKey || 'profiles'}), will retry:`, e.message); this.failed = true; })
      .finally(() => {
        this.writing = null;
        if (this.again || this.failed) { const retry = this.failed; this.again = false; this.failed = false; setTimeout(() => this.save(), retry ? 5000 : 0); }
      });
    return this.writing;
  }
  touch(key) { if (this.db === 'rows') this.dirty.add(key); this.save(); }
}

const scores = new JsonStore('scores.json', { entries: [], daily: {} });
const profiles = new JsonStore('profiles.json', { byName: {} });

const MAX_SCORES = 100;

function addScore(entry) {
  scores.data.entries.push(entry);
  scores.data.entries.sort((a, b) => b.score - a.score || a.at - b.at);
  scores.data.entries.length = Math.min(scores.data.entries.length, MAX_SCORES);
  scores.save();
}

function addDailyScore(date, entry) {
  const d = scores.data.daily || (scores.data.daily = {});
  const list = d[date] || (d[date] = []);
  list.push(entry);
  list.sort((a, b) => b.score - a.score || a.at - b.at);
  list.length = Math.min(list.length, 50);
  // keep a week of boards
  for (const k of Object.keys(d)) if (k < date && Object.keys(d).length > 7) delete d[k];
  scores.save();
}

function topDaily(date, limit = 10) {
  const d = scores.data.daily || {};
  return (d[date] || []).slice(0, limit);
}

function topScores(limit = 20) {
  return scores.data.entries.slice(0, limit);
}

function normName(name) { return String(name || '').trim().toLowerCase(); }

function getProfile(name) {
  const key = normName(name);
  if (!profiles.data.byName[key]) {
    profiles.data.byName[key] = { name: String(name).trim(), unlocked: 1, items: [], wins: 0, best: 0, survivor: 0 };
    profiles.touch(key);
  }
  return profiles.data.byName[key];
}

// ---- name protection -------------------------------------------------------
// A name belongs to whoever first claims it. The claimant's device keeps a
// recovery code; the server stores only a salted hash. Joining with a claimed
// name requires that code. Profiles created before this existed have no hash
// and are claimed by the next player who uses the name.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRecoveryCode() {
  let s = '';
  for (let i = 0; i < 16; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `NF-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}-${s.slice(12)}`;
}
function normCode(code) { return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^NF/, ''); }
function hashCode(code, salt) { return crypto.createHash('sha256').update(`${salt}:${normCode(code)}`).digest('hex'); }

function profileExists(name) { return !!profiles.data.byName[normName(name)]; }

// Returns { ok, profile, code? } where `code` is set only when a new claim was made.
function claimProfile(name, code) {
  const p = getProfile(name);
  if (!p.secretHash) {
    const fresh = newRecoveryCode();
    p.salt = crypto.randomBytes(8).toString('hex');
    p.secretHash = hashCode(fresh, p.salt);
    profiles.touch(normName(name));
    return { ok: true, profile: p, code: fresh };
  }
  if (!code) return { ok: false, reason: 'taken' };
  const a = Buffer.from(hashCode(code, p.salt), 'hex'), b = Buffer.from(p.secretHash, 'hex');
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { ok: true, profile: p };
  return { ok: false, reason: 'taken' };
}

// What clients may see of a profile (never the hash or salt).
function publicProfile(p) {
  return { name: p.name, unlocked: p.unlocked, items: p.items, wins: p.wins, best: p.best, survivor: p.survivor || 0 };
}

function updateProfile(name, fn) {
  const p = getProfile(name);
  fn(p);
  profiles.touch(normName(name));
  return p;
}

function flushAll() { return Promise.all([scores.flush(), profiles.flush()]); }

// Switch to the database when it is connected: load everything into memory.
// If the database is configured but unreachable we keep the files, and say so,
// rather than starting empty and overwriting the real data later.
async function init() {
  if (!db.ready) return 'files';
  const [board, rows] = await Promise.all([db.getKV('scores'), db.allProfiles()]);
  let migrated = false;
  if (board) scores.data = board;
  else if (scores.data.entries.length || Object.keys(scores.data.daily || {}).length) migrated = true; // first run: move the file data up
  if (Object.keys(rows).length) profiles.data.byName = rows;
  else if (Object.keys(profiles.data.byName).length) migrated = true;
  scores.db = 'kv'; scores.dbKey = 'scores';
  profiles.db = 'rows'; profiles.dirty = new Set(rows && Object.keys(rows).length ? [] : Object.keys(profiles.data.byName));
  if (migrated) { await Promise.all([scores.dbWrite(), profiles.dbWrite()]); console.log('[store] copied existing file data into the database'); }
  console.log(`[store] using the database: ${Object.keys(profiles.data.byName).length} profiles, ${scores.data.entries.length} scores`);
  return 'database';
}

module.exports = { init, addScore, topScores, addDailyScore, topDaily, getProfile, updateProfile, flushAll, claimProfile, publicProfile, profileExists, normCode };
