'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-analytics-'));
const analytics = require('../server/analytics');

test('summary builds the funnel, per-night table, death and quit breakdowns', () => {
  analytics.reset();
  const T = analytics.track;
  T('visit', { did: 'aaaaaaaa1', touch: true });
  T('visit', { did: 'bbbbbbbb2', touch: false });
  T('visit', { did: 'cccccccc3', touch: false });
  T('join', { did: 'aaaaaaaa1' });
  T('join', { did: 'bbbbbbbb2' });
  T('start', { gid: 'g1', level: 1, mode: 'night', dids: ['aaaaaaaa1', 'bbbbbbbb2'] });
  T('death', { gid: 'g1', level: 1, mode: 'night', did: 'aaaaaaaa1', monster: 'zombie', elapsed: 70, x: 3, y: 4 });
  T('quit', { gid: 'g1', level: 1, did: 'bbbbbbbb2', elapsed: 95 });
  T('end', { gid: 'g1', level: 1, won: false, elapsed: 96, dids: ['aaaaaaaa1'] });
  T('start', { gid: 'g2', level: 1, mode: 'night', dids: ['aaaaaaaa1'] });
  T('end', { gid: 'g2', level: 1, won: true, elapsed: 200, dids: ['aaaaaaaa1'] });
  T('tut', { did: 'aaaaaaaa1', step: 'move' });
  T('tut', { did: 'aaaaaaaa1', step: 'move' });
  T('tut', { did: 'bbbbbbbb2', skipped: true, step: 'rune' });
  T('intro', { did: 'aaaaaaaa1', how: 'ended', secs: 15 });
  T('intro', { did: 'bbbbbbbb2', how: 'skipped', secs: 4 });
  const s = analytics.summary();
  assert.deepStrictEqual(s.funnel.map((f) => f[1]), [3, 2, 2, 1]);
  const n1 = s.perLevel.find((l) => l.level === 1);
  assert.strictEqual(n1.starts, 2); assert.strictEqual(n1.winRate, 50); assert.strictEqual(n1.avgSecs, 148);
  assert.strictEqual(n1.deaths, 1); assert.strictEqual(n1.quits, 1); assert.strictEqual(n1.topKiller, 'zombie');
  assert.deepStrictEqual(s.byMonster, { zombie: 1 });
  assert.deepStrictEqual(s.deathMinute, { 1: 1 });
  assert.deepStrictEqual(s.quitMinute, { 1: 1 });
  assert.deepStrictEqual(s.tutorial, { steps: { move: 1 }, skips: 1 });
  assert.strictEqual(s.intro.watched, 1); assert.strictEqual(s.intro.avgSkipAt, 4);
  assert.deepStrictEqual(s.devices, { touch: 1, desktop: 2 });
});

test('events are written to disk and the window filters old events', () => {
  analytics.reset();
  analytics.track('visit', { did: 'dddddddd4' });
  analytics._events()[0].at = Date.now() - 10 * 86400000; // ten days old
  analytics.track('visit', { did: 'eeeeeeee5' });
  assert.strictEqual(analytics.summary({ days: 7 }).funnel[0][1], 1);
  assert.strictEqual(analytics.summary({ days: 30 }).funnel[0][1], 2);
  analytics.flush();
  const lines = fs.readFileSync(path.join(process.env.DATA_DIR, 'events.ndjson'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 2 && lines.every((l) => JSON.parse(l).t));
});

test('tonight heatmap only uses deaths on the shared daily map', () => {
  analytics.reset();
  analytics.track('death', { mode: 'tonight', date: '2026-10-27', x: 5, y: 6, monster: 'imp' });
  analytics.track('death', { mode: 'night', x: 1, y: 1, monster: 'imp' });
  analytics.track('death', { mode: 'tonight', date: '2026-10-26', x: 1, y: 1, monster: 'imp' });
  assert.deepStrictEqual(analytics.tonightDeaths('2026-10-27'), [{ x: 5, y: 6, monster: 'imp' }]);
});
