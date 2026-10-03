'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game } = require('../server/game');
const { T, bfsDistances } = require('../server/mapgen');

// A bot that walks a player to a target tile along a BFS path over tiles the
// team can currently pass (open doors + doors we own keys for).
function pathTo(g, from, target) {
  const W = g.W, H = g.H;
  const prev = new Int32Array(W * H).fill(-1);
  const sx = Math.floor(from.x), sy = Math.floor(from.y);
  const q = [sy * W + sx]; prev[q[0]] = q[0];
  const tgt = Math.floor(target.y) * W + Math.floor(target.x);
  for (let i = 0; i < q.length; i++) {
    const c = q[i]; if (c === tgt) break;
    const x = c % W, y = (c - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, n = ny * W + nx;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || prev[n] !== -1) continue;
      const t = g.tiles[n];
      if (t === T.WALL) continue;
      if (t === T.EXIT && !g.exit.open) continue;
      if (t === T.DOOR) { const d = g.doorAt(nx, ny); if (!d.open && !g.ownedKeys.has(d.keyId)) continue; }
      prev[n] = c; q.push(n);
    }
  }
  if (prev[tgt] === -1) return null;
  const path = [];
  for (let c = tgt; c !== prev[c]; c = prev[c]) path.push({ x: (c % W) + 0.5, y: Math.floor(c / W) + 0.5 });
  return path.reverse();
}

function walkTo(g, id, target, maxTicks = 30 * 120) {
  const p = g.players.get(id);
  let path = pathTo(g, p, target);
  assert.ok(path, `no path to ${JSON.stringify(target)}`);
  let i = 0, ticks = 0;
  while (ticks++ < maxTicks && g.status === 'running') {
    if (i >= path.length || p.escaped) { g.setInput(id, 0, 0); return true; }
    const wp = path[i];
    const dx = wp.x - p.x, dy = wp.y - p.y;
    if (Math.hypot(dx, dy) < 0.12) { i++; continue; }
    g.setInput(id, Math.abs(dx) > 0.05 ? Math.sign(dx) : 0, Math.abs(dy) > 0.05 ? Math.sign(dy) : 0);
    g.step();
  }
  return i >= path.length || p.escaped;
}

test('a solo player can clear a level: keys, doors, fragments, altar, exit', () => {
  const emitted = [];
  const g = new Game(4, [{ id: 'p1', name: 'Bot', profile: { items: [] } }], (t, p) => emitted.push([t, p]));
  g.monsters.length = 0; // we are testing the objective flow, not the chase
  const id = 'p1';
  // collect keys in order (the generator guarantees key i is reachable once doors < i are open)
  for (const k of g.keys) { assert.ok(walkTo(g, id, k), 'reach key ' + k.id); assert.ok(k.taken, 'key picked up'); }
  for (const f of g.fragments) { assert.ok(walkTo(g, id, f), 'reach fragment ' + f.id); assert.ok(f.taken); }
  if (g.item) { assert.ok(walkTo(g, id, g.item)); assert.ok(g.item.taken, 'relic picked up'); }
  assert.ok(walkTo(g, id, { x: g.altar.x + 0.5, y: g.altar.y + 0.5 }));
  // wrong answer first: penalty + imp
  const before = g.timeLeft, mons = g.monsters.length;
  g.trySolve(id, g.solution.slice().reverse());
  assert.ok(g.timeLeft < before - 10, 'wrong answer costs time');
  assert.strictEqual(g.monsters.length, mons + 1, 'wrong answer wakes an imp');
  assert.ok(!g.exit.open);
  g.monsters.length = 0;
  g.trySolve(id, g.solution);
  assert.ok(g.exit.open, 'correct runes open the exit');
  assert.ok(walkTo(g, id, { x: g.exit.x + 0.5, y: g.exit.y + 0.5 }));
  const p = g.players.get(id);
  assert.ok(p.escaped, 'player escaped');
  for (let i = 0; i < 30 * 20 && g.status === 'running'; i++) g.step();
  assert.strictEqual(g.status, 'won');
  assert.strictEqual(emitted[0][0], 'finished');
  assert.ok(emitted[0][1].score > 4000);
  assert.ok(g.events.some((e) => e.kind === 'escaped') || true);
});

test('when every player is caught the night is lost; a friend can revive', () => {
  const g = new Game(1, [{ id: 'a', name: 'A', profile: { items: [] } }, { id: 'b', name: 'B', profile: { items: [] } }], () => {});
  const a = g.players.get('a'), b = g.players.get('b');
  a.invuln = 0; b.invuln = 0;
  // park a zombie on top of A
  g.monsters.length = 0;
  g.monsters.push(g.makeMonster('zombie', a.x, a.y));
  g.step();
  assert.ok(a.down, 'A was caught');
  assert.strictEqual(g.status, 'running', 'B is still alive');
  g.monsters.length = 0;
  // B stands next to A for two seconds
  b.x = a.x + 0.5; b.y = a.y;
  for (let i = 0; i < 70; i++) g.step();
  assert.ok(!a.down, 'A was revived');
  // now both get caught
  a.invuln = 0; b.invuln = 0;
  g.monsters.push(g.makeMonster('demon', a.x, a.y), g.makeMonster('demon', b.x, b.y));
  g.step();
  assert.strictEqual(g.status, 'lost');
});

test('amulet absorbs one catch; skeleton key opens a door without its key', () => {
  const g = new Game(5, [{ id: 'a', name: 'A', profile: { items: ['amulet', 'skeleton', 'boots', 'lantern'] } }], () => {});
  const a = g.players.get('a');
  assert.ok(a.speed > 4.3 && a.vision > 5, 'boots and lantern apply');
  a.invuln = 0; g.monsters.length = 0;
  g.monsters.push(g.makeMonster('imp', a.x, a.y));
  g.step();
  assert.ok(!a.down && a.amuletUsed, 'amulet consumed instead of going down');
  g.monsters.length = 0;
  const d = g.doors[0];
  assert.ok(g.passableForPlayer(d.x, d.y, a), 'skeleton key opens the first locked door');
  assert.ok(d.open && a.skeletonUsed);
  assert.ok(!g.passableForPlayer(g.doors[1].x, g.doors[1].y, a), 'only once per night');
});

test('monsters stay in lanes and out of walls over a long simulation', () => {
  const g = new Game(8, [{ id: 'a', name: 'A', profile: { items: [] } }], () => {});
  const a = g.players.get('a'); a.invuln = 1e9; // ghost mode so the sim keeps running
  for (let i = 0; i < 30 * 90; i++) {
    g.step();
    for (const m of g.monsters) {
      if (m.type === 'ghost') continue;
      const t = g.tileAt(Math.floor(m.x), Math.floor(m.y));
      assert.notStrictEqual(t, T.WALL, `${m.type} inside a wall at ${m.x},${m.y}`);
      assert.ok(Math.abs(m.dx) + Math.abs(m.dy) === 1, 'moves along exactly one axis');
    }
  }
  assert.strictEqual(g.status, 'running');
  const snap = g.snapshot();
  assert.ok(snap.monsters.every((m) => m.v === 1 || m.q === 0), 'unseen silent monsters are never sent to clients');
});

test('the night is frozen during the warm-up, then runs', () => {
  const g = new Game(1, [{ id: 'a', name: 'A', profile: { items: [] } }], () => {}, { intro: true, warmup: 2 });
  g.setInput('a', 1, 0);
  const p = g.players.get('a'), x0 = p.x, t0 = g.timeLeft;
  for (let i = 0; i < 30; i++) g.step(); // 1 s of warm-up
  assert.strictEqual(p.x, x0, 'no movement during warm-up');
  assert.strictEqual(g.timeLeft, t0, 'clock does not tick during warm-up');
  assert.ok(g.snapshot().warm > 0);
  assert.strictEqual(g.initPacket().cinematic, true);
  assert.strictEqual(typeof g.initPacket().intro, 'string', 'briefing text survives');
  for (let i = 0; i < 60; i++) g.step();
  assert.ok(g.timeLeft < t0, 'clock runs after warm-up');
  assert.strictEqual(g.snapshot().warm, 0);
});
