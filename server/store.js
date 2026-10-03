'use strict';
const fs = require('fs');
const path = require('path');

// Tiny JSON-file persistence for high scores and player profiles.
// Writes are debounced and atomic (write temp file, then rename).

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
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch (e) { console.error('[store] flush failed:', e.message); }
  }
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
    profiles.save();
  }
  return profiles.data.byName[key];
}

function updateProfile(name, fn) {
  const p = getProfile(name);
  fn(p);
  profiles.save();
  return p;
}

function flushAll() { scores.flush(); profiles.flush(); }

module.exports = { addScore, topScores, addDailyScore, topDaily, getProfile, updateProfile, flushAll };
