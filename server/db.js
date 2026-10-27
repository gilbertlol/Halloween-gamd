'use strict';

// Optional Postgres persistence (e.g. a free Neon database). Enabled when
// DATABASE_URL is set; otherwise the game keeps using JSON files in DATA_DIR.
//
// Tables:
//   nf_kv        one JSON document per key (the score boards)
//   nf_profiles  one row per player name
//   nf_events    anonymous analytics events

let pool = null;
let ready = false;

const SCHEMA = `
create table if not exists nf_kv (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
create table if not exists nf_profiles (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
create table if not exists nf_events (id bigserial primary key, at timestamptz not null, type text not null, data jsonb not null);
create index if not exists nf_events_at on nf_events (at);
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Connect and create tables. Serverless databases can take a few seconds to
// wake, so retry for up to ~45 s before giving up.
async function init(url, { attempts = 8 } = {}) {
  if (!url) return false;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: url, max: 4, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 });
  pool.on('error', (e) => console.error('[db] idle client error:', e.message));
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query(SCHEMA);
      ready = true;
      console.log('[db] connected, tables ready');
      return true;
    } catch (e) {
      console.error(`[db] connect attempt ${i}/${attempts} failed: ${e.message}`);
      if (i < attempts) await sleep(Math.min(8000, 1000 * i));
    }
  }
  return false;
}

const q = (text, params) => pool.query(text, params);

async function getKV(key) {
  const r = await q('select value from nf_kv where key = $1', [key]);
  return r.rows.length ? r.rows[0].value : null;
}
async function setKV(key, value) {
  await q('insert into nf_kv (key, value, updated_at) values ($1, $2, now()) on conflict (key) do update set value = excluded.value, updated_at = now()', [key, JSON.stringify(value)]);
}

async function allProfiles() {
  const r = await q('select key, value from nf_profiles');
  const out = {};
  for (const row of r.rows) out[row.key] = row.value;
  return out;
}
// rows: [[key, profileObject], ...]
async function upsertProfiles(rows) {
  if (!rows.length) return;
  await q(
    `insert into nf_profiles (key, value, updated_at)
     select k, v::jsonb, now() from unnest($1::text[], $2::text[]) as t(k, v)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [rows.map((r) => r[0]), rows.map((r) => JSON.stringify(r[1]))],
  );
}

async function insertEvents(events) {
  if (!events.length) return;
  await q(
    `insert into nf_events (at, type, data)
     select to_timestamp(a / 1000.0), t, d::jsonb from unnest($1::float8[], $2::text[], $3::text[]) as x(a, t, d)`,
    [events.map((e) => e.at), events.map((e) => e.t), events.map((e) => JSON.stringify(e))],
  );
}
async function recentEvents(sinceMs, limit) {
  const r = await q('select data from (select data, id from nf_events where at >= to_timestamp($1 / 1000.0) order by id desc limit $2) s order by id asc', [sinceMs, limit]);
  return r.rows.map((row) => row.data);
}
async function pruneEvents(beforeMs) {
  const r = await q('delete from nf_events where at < to_timestamp($1 / 1000.0)', [beforeMs]);
  return r.rowCount;
}

async function close() { if (pool) { const p = pool; pool = null; ready = false; await p.end().catch(() => {}); } }

module.exports = {
  init, close, getKV, setKV, allProfiles, upsertProfiles, insertEvents, recentEvents, pruneEvents,
  get ready() { return ready; },
};
