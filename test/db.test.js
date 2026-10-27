'use strict';
// Runs against a real Postgres when TEST_DATABASE_URL is set; skipped otherwise.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const URL = process.env.TEST_DATABASE_URL;
const skip = !URL && 'set TEST_DATABASE_URL to run the database tests';

// fresh copies of the server modules, as after a restart
function boot(dataDir) {
  for (const m of ['db', 'store', 'analytics']) delete require.cache[require.resolve(`../server/${m}`)];
  process.env.DATA_DIR = dataDir;
  process.env.DATABASE_URL = URL;
  return { db: require('../server/db'), store: require('../server/store'), analytics: require('../server/analytics') };
}

test('database round-trips: documents, profiles, events, pruning', { skip }, async () => {
  const { db } = boot(fs.mkdtempSync(path.join(os.tmpdir(), 'nf-db-')));
  assert.ok(await db.init(URL, { attempts: 2 }));
  await db.pruneEvents(Date.now() + 1e9); // clean slate
  await db.setKV('t_doc', { a: [1, 2] }); await db.setKV('t_doc', { a: [3] });
  assert.deepStrictEqual(await db.getKV('t_doc'), { a: [3] });
  assert.strictEqual(await db.getKV('t_missing'), null);
  await db.upsertProfiles([['t_x', { name: 'X', wins: 1 }], ['t_y', { name: 'Y', wins: 0 }]]);
  await db.upsertProfiles([['t_x', { name: 'X', wins: 2 }]]);
  const all = await db.allProfiles();
  assert.strictEqual(all.t_x.wins, 2); assert.strictEqual(all.t_y.name, 'Y');
  const now = Date.now();
  await db.insertEvents([{ t: 'visit', at: now - 5 * 86400000, did: 'old' }, { t: 'visit', at: now - 1000, did: 'a' }, { t: 'join', at: now, did: 'a' }]);
  const recent = await db.recentEvents(now - 86400000, 100);
  assert.deepStrictEqual(recent.map((e) => e.t), ['visit', 'join'], 'oldest first, window applied');
  assert.strictEqual(await db.pruneEvents(now - 2 * 86400000), 1);
  await db.close();
});

test('the game keeps its data across a restart, and moves file data in on first run', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-db-'));
  // wipe the tables this test uses
  { const { db } = boot(dir); await db.init(URL, { attempts: 2 }); await db.setKV('scores', { entries: [], daily: {} }); await db.close(); }
  const { Pool } = require('pg'); const pool = new Pool({ connectionString: URL });
  await pool.query('delete from nf_kv'); await pool.query('delete from nf_profiles'); await pool.query('delete from nf_events');

  // a server that ran on files before the database existed
  fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify({ byName: { veteran: { name: 'Veteran', unlocked: 5, items: ['lantern'], wins: 7, best: 9000 } } }));
  fs.writeFileSync(path.join(dir, 'scores.json'), JSON.stringify({ entries: [{ team: ['Veteran'], score: 9000, level: 4, at: 1 }], daily: {} }));

  // first boot with the database: file data is copied up
  let s = boot(dir);
  assert.ok(await s.db.init(URL, { attempts: 2 }));
  assert.strictEqual(await s.store.init(), 'database');
  await s.analytics.init();
  const claim = s.store.claimProfile('Gorlak');
  assert.ok(claim.ok && claim.code);
  s.store.updateProfile('Gorlak', (p) => { p.wins = 3; p.items.push('boots'); });
  s.store.addScore({ team: ['Gorlak'], score: 1234, level: 2, at: 2 });
  s.analytics.track('visit', { did: 'abcdefgh1' });
  s.analytics.track('death', { mode: 'tonight', date: '2026-10-27', x: 4, y: 5, monster: 'imp' });
  await s.store.flushAll(); await s.analytics.flush();
  await s.db.close();

  // the host restarts: an empty disk (no files), same database
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-db-'));
  s = boot(fresh);
  assert.ok(await s.db.init(URL, { attempts: 2 }));
  assert.strictEqual(await s.store.init(), 'database');
  await s.analytics.init();
  assert.strictEqual(s.store.claimProfile('Gorlak').ok, false, 'name still protected after restart');
  const back = s.store.claimProfile('gorlak', claim.code);
  assert.ok(back.ok); assert.strictEqual(back.profile.wins, 3); assert.deepStrictEqual(back.profile.items, ['boots']);
  assert.strictEqual(s.store.getProfile('Veteran').wins, 7, 'file-era profile was migrated');
  assert.deepStrictEqual(s.store.topScores(5).map((e) => e.score), [9000, 1234]);
  assert.strictEqual(s.analytics.summary().funnel[0][1], 1, 'analytics survived');
  assert.deepStrictEqual(s.analytics.tonightDeaths('2026-10-27'), [{ x: 4, y: 5, monster: 'imp' }]);
  await s.db.close(); await pool.end();
});
