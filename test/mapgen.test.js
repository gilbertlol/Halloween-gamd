'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { generate, verify, T } = require('../server/mapgen');
const { LEVELS } = require('../server/levels');

test('every level generates a solvable map for many seeds', () => {
  for (const L of LEVELS) {
    for (let seed = 1; seed <= 25; seed++) {
      const m = generate(L, seed * 1000 + L.n);
      assert.ok(verify(m), `level ${L.n} seed ${seed} not solvable`);
      assert.strictEqual(m.keys.length, m.doors.length, 'one key per door');
      assert.ok(m.keys.length >= Math.min(L.keys, 1));
      assert.strictEqual(m.fragments.length, L.fragments);
      assert.strictEqual(!!m.item, !!L.item);
      assert.strictEqual(m.tiles[m.exit.y * m.W + m.exit.x], T.EXIT);
      assert.strictEqual(m.tiles[m.altar.y * m.W + m.altar.x], T.ALTAR);
      assert.ok(m.spawns.length >= 6, 'room for six players');
      assert.ok(m.monsterSpots.length > 20);
      // keys are never on top of each other, nor on doors
      for (const k of m.keys) assert.strictEqual(m.tiles[Math.floor(k.y) * m.W + Math.floor(k.x)], T.FLOOR);
      // monster spawn spots are floor tiles far from the spawn room
      for (const s of m.monsterSpots) assert.strictEqual(m.tiles[s.y * m.W + s.x], T.FLOOR);
    }
  }
});

test('doors are required: the exit is unreachable with no keys when the level has doors', () => {
  const L = LEVELS[3];
  const m = generate(L, 42);
  // flood fill without opening any door
  const seen = new Uint8Array(m.W * m.H);
  const q = [Math.floor(m.spawns[0].y) * m.W + Math.floor(m.spawns[0].x)];
  seen[q[0]] = 1;
  for (let i = 0; i < q.length; i++) {
    const c = q[i], x = c % m.W, y = (c - x) / m.W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = (y + dy) * m.W + x + dx, t = m.tiles[n];
      if (seen[n] || t === T.WALL || t === T.DOOR) continue;
      seen[n] = 1; q.push(n);
    }
  }
  assert.strictEqual(seen[m.altar.y * m.W + m.altar.x], 0, 'altar must be behind a locked door');
});
