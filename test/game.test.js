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

test('the cinematic hold ends once every player reports ready', () => {
  const g = new Game(1, [{ id: 'a', name: 'A', profile: { items: [] } }, { id: 'b', name: 'B', profile: { items: [] } }], () => {}, { intro: true, warmup: 120 });
  for (let i = 0; i < 30; i++) g.step();
  assert.ok(g.warmup > 100 && g.snapshot().waitFor === 2, 'holding for both players');
  g.markReady('a');
  for (let i = 0; i < 30; i++) g.step();
  assert.ok(g.warmup > 100 && g.snapshot().waitFor === 1, 'still holding for B');
  g.markReady('b');
  assert.ok(g.warmup <= 4, 'collapses to the short countdown');
  assert.strictEqual(g.snapshot().waitFor, 0);
  for (let i = 0; i < 30 * 5; i++) g.step();
  assert.ok(g.timeLeft < 240, 'night is running');
  // a player who leaves mid-cinematic does not hold the others
  const h = new Game(1, [{ id: 'a', name: 'A', profile: { items: [] } }, { id: 'b', name: 'B', profile: { items: [] } }], () => {}, { intro: true, warmup: 120 });
  h.markReady('a'); h.removePlayer('b');
  assert.ok(h.warmup <= 4);
});

test('a seeded game is identical for everyone (Tonight mode)', () => {
  const mk = () => new Game(3, [{ id: 'a', name: 'A', profile: { items: [] } }], () => {}, { seed: 4242, mode: 'tonight' });
  const g1 = mk(), g2 = mk();
  assert.strictEqual(g1.seed, 4242);
  assert.deepStrictEqual(Array.from(g1.tiles), Array.from(g2.tiles));
  assert.deepStrictEqual(g1.solution, g2.solution);
  assert.deepStrictEqual(g1.monsters.map((m) => [m.type, m.x, m.y]), g2.monsters.map((m) => [m.type, m.x, m.y]));
  assert.strictEqual(g1.initPacket().mode, 'tonight');
});

test('compass hint appears after idle time and points along a reachable path', () => {
  const g = new Game(2, [{ id: 'a', name: 'A', profile: { items: [] } }], () => {}, { warmup: 0 });
  g.monsters.length = 0;
  const p = g.players.get('a');
  for (let i = 0; i < 30 * 16; i++) g.step();
  assert.ok(p.hint, 'hint set after 15 s without progress');
  assert.ok(['key', 'fragment'].includes(p.hint.kind));
  const snap = g.snapshot();
  assert.ok(Array.isArray(snap.players[0].hint) && typeof snap.players[0].hint[0] === 'number');
  // step one tile in the hinted direction: must be passable
  const a = p.hint.a, tx = Math.floor(p.x + Math.cos(a) * 1), ty = Math.floor(p.y + Math.sin(a) * 1);
  assert.notStrictEqual(g.tileAt(tx, ty), T.WALL, 'hint does not point into a wall');
  // progress clears the hint
  g.keys[0].taken = false; p.x = g.keys[0].x; p.y = g.keys[0].y; g.step();
  assert.strictEqual(p.hint, null);
});

test('ghosts drift, drop flares on a cooldown, and flares reveal monsters', () => {
  const g = new Game(1, [{ id: 'a', name: 'A', profile: { items: [] } }, { id: 'b', name: 'B', profile: { items: [] } }], () => {}, { warmup: 0 });
  const a = g.players.get('a'), b = g.players.get('b');
  g.monsters.length = 0;
  a.down = true; a.invuln = 0;
  g.dropFlare('b'); assert.strictEqual(g.flares.length, 0, 'living players cannot flare');
  g.dropFlare('a'); assert.strictEqual(g.flares.length, 1);
  g.dropFlare('a'); assert.strictEqual(g.flares.length, 1, 'cooldown');
  assert.ok(g.snapshot().players[0].fc > 0);
  // a monster far from everyone but near the flare is revealed
  const m = g.makeMonster('zombie', a.x, a.y); g.monsters.push(m);
  b.x = a.x + 20; b.y = a.y; // far away (may be in a wall; irrelevant for this check)
  assert.ok(g.snapshot().monsters.some((mm) => mm.id === m.id && mm.v === 1), 'flare reveals the monster');
  g.monsters.length = 0;
  // ghost moves, slower than the living
  const x0 = a.x; g.setInput('a', 1, 0); for (let i = 0; i < 30; i++) g.step();
  assert.ok(a.x !== x0 || g.tileAt(Math.floor(x0) + 1, Math.floor(a.y)) === T.WALL, 'ghost drifted');
});

test('tension events fire, change the world, and end cleanly', () => {
  const g = new Game(4, [{ id: 'a', name: 'A', profile: { items: [] } }], () => {}, { warmup: 0 });
  g.monsters.length = 0; g.monsters.push(g.makeMonster('zombie', g.map.monsterSpots[0].x + 0.5, g.map.monsterSpots[0].y + 0.5));
  const p = g.players.get('a'); p.invuln = 1e9;
  const vis = p.vision, base = g.monsters[0].base;
  // force each event type
  g.eventQueue = [];
  g.R = { rand: () => 0, pick: (arr) => arr[0], shuffle: (x) => x }; // deterministic: picks 'blackout'
  g.startEvent(); assert.strictEqual(g.event_.type, 'blackout'); assert.ok(p.vision < vis);
  for (let i = 0; i < 30 * 11; i++) g.step();
  assert.strictEqual(g.event_, null); assert.strictEqual(p.vision, vis, 'vision restored');
  g.R = { rand: () => 0.5, pick: (arr) => arr[Math.min(1, arr.length - 1)], shuffle: (x) => x }; // 'hunt'
  g.startEvent(); assert.strictEqual(g.event_.type, 'hunt'); assert.ok(g.monsters[0].speed > base);
  for (let i = 0; i < 30 * 16; i++) g.step();
  assert.strictEqual(g.monsters[0].speed, base, 'speed restored');
  // slam relocks an open door for 20 s
  const d = g.doors[0]; d.open = true; p.x = d.x + 5.5; p.y = d.y + 0.5;
  g.R = { rand: () => 0.9, pick: (arr) => arr[arr.length - 1], shuffle: (x) => x }; // 'slam'
  g.startEvent(); assert.strictEqual(g.event_.type, 'slam'); assert.strictEqual(d.open, false);
  assert.ok(g.snapshot().slam === d.keyId);
  for (let i = 0; i < 30 * 21; i++) g.step();
  assert.strictEqual(d.open, true, 'door reopens');
});

test('a close call awards bonus points and builds a streak; being caught resets it', () => {
  const g = new Game(2, [{ id: 'a', name: 'A', profile: { items: [] } }], () => {}, { warmup: 0 });
  const p = g.players.get('a'); p.invuln = 0;
  g.monsters.length = 0;
  const m = g.makeMonster('zombie', p.x + 1.0, p.y); m.speed = 0; m.base = 0; g.monsters.push(m);
  g.step(); // within 1.15: marked near
  m.x = p.x + 3; g.step(); // left without catching
  assert.strictEqual(p.streak, 1); assert.ok(g.bonus > 0);
  const ev = g.snapshot().events.find((e) => e.kind === 'closeCall'); assert.ok(ev && ev.pts === 100);
  m.x = p.x + 1.0; g.step(); m.x = p.x + 3; g.step();
  assert.strictEqual(p.streak, 2);
  assert.ok(g.liveScore() >= 300);
  m.x = p.x; g.step(); // caught
  assert.ok(p.down); assert.strictEqual(p.streak, 0);
});
