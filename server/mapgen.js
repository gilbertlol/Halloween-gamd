'use strict';

// Procedural dungeon generator.
//
// The map is a grid of cells; each cell holds one room. Adjacent rooms are
// connected by corridors (straight or Z shaped) through the shared wall.
// A spanning tree of cells guarantees connectivity; some tree edges become
// locked doors and their keys are always placed on the side of the door the
// players can already reach, so every level is solvable. Extra "loop"
// corridors are only added between cells that need the same set of doors,
// so loops never bypass a lock. Finally the layout is verified with a
// key-aware flood fill and regenerated if anything is unreachable.

const T = { FLOOR: 0, WALL: 1, DOOR: 2, EXIT: 3, ALTAR: 4 };

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const rand = mulberry32(seed);
  return {
    rand,
    int: (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)), // inclusive
    pick: (arr) => arr[Math.floor(rand() * arr.length)],
    shuffle: (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    },
  };
}

function generate(cfg, seed) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const map = tryGenerate(cfg, (seed + attempt * 7919) >>> 0);
    if (map && verify(map)) return map;
  }
  throw new Error('mapgen: could not produce a solvable map');
}

function tryGenerate(cfg, seed) {
  const R = makeRng(seed);
  const { cols, rows, cellW, cellH } = cfg;
  const W = cols * cellW + 1;
  const H = rows * cellH + 1;
  const tiles = new Uint8Array(W * H).fill(T.WALL);
  const idx = (x, y) => y * W + x;
  const set = (x, y, v) => { tiles[idx(x, y)] = v; };

  // --- rooms -----------------------------------------------------------
  const cells = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const ix0 = cx * cellW + 1, iy0 = cy * cellH + 1;
      const iw = cellW - 1, ih = cellH - 1;
      const w = R.int(Math.max(4, Math.ceil(iw * 0.55)), iw);
      const h = R.int(Math.max(4, Math.ceil(ih * 0.55)), ih);
      const x0 = ix0 + R.int(0, iw - w);
      const y0 = iy0 + R.int(0, ih - h);
      const room = { id: cells.length, cx, cy, x0, y0, x1: x0 + w - 1, y1: y0 + h - 1 };
      for (let y = y0; y <= room.y1; y++) for (let x = x0; x <= room.x1; x++) set(x, y, T.FLOOR);
      cells.push(room);
    }
  }
  const cellAt = (cx, cy) => cells[cy * cols + cx];

  // --- spanning tree over cells (randomized Prim) -----------------------
  const spawnCell = R.pick(cells);
  const inTree = new Set([spawnCell.id]);
  const treeEdges = [];
  const frontier = [];
  const pushFrontier = (c) => {
    const nb = [];
    if (c.cx > 0) nb.push(cellAt(c.cx - 1, c.cy));
    if (c.cx < cols - 1) nb.push(cellAt(c.cx + 1, c.cy));
    if (c.cy > 0) nb.push(cellAt(c.cx, c.cy - 1));
    if (c.cy < rows - 1) nb.push(cellAt(c.cx, c.cy + 1));
    for (const n of nb) if (!inTree.has(n.id)) frontier.push([c, n]);
  };
  pushFrontier(spawnCell);
  const parent = new Map([[spawnCell.id, null]]);
  const children = new Map(cells.map((c) => [c.id, []]));
  while (frontier.length) {
    const i = Math.floor(R.rand() * frontier.length);
    const [a, b] = frontier.splice(i, 1)[0];
    if (inTree.has(b.id)) continue;
    inTree.add(b.id);
    parent.set(b.id, a.id);
    children.get(a.id).push(b.id);
    treeEdges.push({ a, b });
    pushFrontier(b);
  }

  // depth / subtree sets
  const depth = new Map([[spawnCell.id, 0]]);
  const order = [spawnCell.id];
  for (let i = 0; i < order.length; i++) {
    for (const ch of children.get(order[i])) { depth.set(ch, depth.get(order[i]) + 1); order.push(ch); }
  }
  const subtree = new Map();
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const s = new Set([id]);
    for (const ch of children.get(id)) for (const v of subtree.get(ch)) s.add(v);
    subtree.set(id, s);
  }

  // exit = deepest cell
  let exitCell = spawnCell;
  for (const c of cells) if (depth.get(c.id) > depth.get(exitCell.id)) exitCell = c;
  if (exitCell === spawnCell) return null;

  // --- choose door edges --------------------------------------------------
  // Each tree edge is identified by its child cell. Doors: one on the path to
  // the exit, the rest random. Keys for door i are placed outside the subtrees
  // of doors i..K so the doors can always be opened in order.
  const pathToExit = [];
  for (let c = exitCell.id; parent.get(c) !== null; c = parent.get(c)) pathToExit.push(c);
  const nDoors = Math.min(cfg.keys, treeEdges.length - 1);
  const doorChildren = new Set();
  doorChildren.add(R.pick(pathToExit));
  const candidates = R.shuffle(order.slice(1).filter((id) => !doorChildren.has(id)));
  for (const id of candidates) {
    if (doorChildren.size >= nDoors) break;
    doorChildren.add(id);
  }
  const doorsOrdered = [...doorChildren].sort((a, b) => depth.get(a) - depth.get(b));

  // --- carve corridors --------------------------------------------------
  const doors = [];
  const carveCorridor = (a, b, doorKey) => {
    // ensure a is left/top of b
    if (a.cx > b.cx || a.cy > b.cy) [a, b] = [b, a];
    let doorPos;
    if (a.cy === b.cy) {
      const bx = (a.cx + 1) * cellW;
      const lo = Math.max(a.y0, b.y0), hi = Math.min(a.y1, b.y1);
      let ya, yb;
      if (lo <= hi) { ya = yb = R.int(lo, hi); } else { ya = R.int(a.y0, a.y1); yb = R.int(b.y0, b.y1); }
      for (let x = a.x1 + 1; x <= bx; x++) set(x, ya, T.FLOOR);
      for (let y = Math.min(ya, yb); y <= Math.max(ya, yb); y++) set(bx, y, T.FLOOR);
      for (let x = bx; x < b.x0; x++) set(x, yb, T.FLOOR);
      doorPos = { x: bx, y: Math.round((ya + yb) / 2) };
    } else {
      const by = (a.cy + 1) * cellH;
      const lo = Math.max(a.x0, b.x0), hi = Math.min(a.x1, b.x1);
      let xa, xb;
      if (lo <= hi) { xa = xb = R.int(lo, hi); } else { xa = R.int(a.x0, a.x1); xb = R.int(b.x0, b.x1); }
      for (let y = a.y1 + 1; y <= by; y++) set(xa, y, T.FLOOR);
      for (let x = Math.min(xa, xb); x <= Math.max(xa, xb); x++) set(x, by, T.FLOOR);
      for (let y = by; y < b.y0; y++) set(xb, y, T.FLOOR);
      doorPos = { x: Math.round((xa + xb) / 2), y: by };
    }
    if (doorKey !== undefined) {
      set(doorPos.x, doorPos.y, T.DOOR);
      doors.push({ x: doorPos.x, y: doorPos.y, keyId: doorKey, open: false });
    }
  };

  const doorKeyOf = new Map(doorsOrdered.map((id, i) => [id, i]));
  for (const e of treeEdges) carveCorridor(e.a, e.b, doorKeyOf.get(e.b.id));

  // door signature per cell: set of doors (by key id) between root and cell
  const sig = new Map();
  for (const id of order) {
    const p = parent.get(id);
    const parentSig = p === null ? [] : sig.get(p);
    sig.set(id, doorKeyOf.has(id) ? [...parentSig, doorKeyOf.get(id)] : parentSig);
  }
  const sigKey = (id) => sig.get(id).join(',');

  // loops between adjacent non-tree cells with identical door signature
  const treeSet = new Set(treeEdges.map((e) => `${Math.min(e.a.id, e.b.id)}-${Math.max(e.a.id, e.b.id)}`));
  const loopCandidates = [];
  for (const c of cells) {
    const right = c.cx < cols - 1 ? cellAt(c.cx + 1, c.cy) : null;
    const down = c.cy < rows - 1 ? cellAt(c.cx, c.cy + 1) : null;
    for (const n of [right, down]) {
      if (!n) continue;
      const k = `${Math.min(c.id, n.id)}-${Math.max(c.id, n.id)}`;
      if (!treeSet.has(k) && sigKey(c.id) === sigKey(n.id)) loopCandidates.push([c, n]);
    }
  }
  R.shuffle(loopCandidates);
  for (const [a, b] of loopCandidates.slice(0, cfg.loops)) carveCorridor(a, b);

  // --- place keys -----------------------------------------------------------
  const usedCells = new Set([spawnCell.id, exitCell.id]);
  const keys = [];
  for (let i = 0; i < doorsOrdered.length; i++) {
    // allowed: not in subtree of door i..K
    const forbidden = new Set();
    for (let j = i; j < doorsOrdered.length; j++) for (const v of subtree.get(doorsOrdered[j])) forbidden.add(v);
    let allowed = cells.filter((c) => !forbidden.has(c.id) && !usedCells.has(c.id));
    if (!allowed.length) allowed = cells.filter((c) => !forbidden.has(c.id));
    if (!allowed.length) return null;
    // prefer deeper allowed cells so keys are a journey, not a gift
    allowed.sort((a, b) => depth.get(b.id) - depth.get(a.id));
    const room = allowed[Math.min(allowed.length - 1, R.int(0, Math.min(2, allowed.length - 1)))];
    usedCells.add(room.id);
    const p = randomFloorInRoom(room, R, tiles, W);
    keys.push({ id: i, x: p.x, y: p.y, taken: false });
  }

  // --- fragments of the mystery -----------------------------------------
  const fragments = [];
  const fragCells = cells.filter((c) => !usedCells.has(c.id));
  R.shuffle(fragCells);
  // guarantee at least one fragment in the deepest region
  fragCells.sort((a, b) => (sig.get(b.id).length - sig.get(a.id).length) * 0 + 0); // stable
  const nFrag = Math.min(cfg.fragments, fragCells.length + 1);
  for (let i = 0; i < nFrag; i++) {
    const room = fragCells[i] || exitCell;
    usedCells.add(room.id);
    const p = randomFloorInRoom(room, R, tiles, W);
    fragments.push({ id: i, x: p.x, y: p.y, taken: false });
  }

  // --- relic item (behind the last door if possible) ---------------------------
  let item = null;
  if (cfg.item) {
    const deepest = doorsOrdered.length ? subtree.get(doorsOrdered[doorsOrdered.length - 1]) : new Set(cells.map((c) => c.id));
    let pool = cells.filter((c) => deepest.has(c.id) && !usedCells.has(c.id));
    if (!pool.length) pool = cells.filter((c) => deepest.has(c.id) && c.id !== exitCell.id);
    if (!pool.length) pool = [exitCell];
    const room = R.pick(pool);
    const p = randomFloorInRoom(room, R, tiles, W);
    item = { type: cfg.item, x: p.x, y: p.y, taken: false };
  }

  // --- exit door + altar -----------------------------------------------------
  const exitSpots = [];
  for (let x = exitCell.x0; x <= exitCell.x1; x++) {
    if (tiles[idx(x, exitCell.y0 - 1)] === T.WALL && exitCell.y0 - 1 > 0) exitSpots.push({ x, y: exitCell.y0 - 1, ax: x, ay: exitCell.y0 });
    if (tiles[idx(x, exitCell.y1 + 1)] === T.WALL && exitCell.y1 + 1 < H - 1) exitSpots.push({ x, y: exitCell.y1 + 1, ax: x, ay: exitCell.y1 });
  }
  for (let y = exitCell.y0; y <= exitCell.y1; y++) {
    if (tiles[idx(exitCell.x0 - 1, y)] === T.WALL && exitCell.x0 - 1 > 0) exitSpots.push({ x: exitCell.x0 - 1, y, ax: exitCell.x0, ay: y });
    if (tiles[idx(exitCell.x1 + 1, y)] === T.WALL && exitCell.x1 + 1 < W - 1) exitSpots.push({ x: exitCell.x1 + 1, y, ax: exitCell.x1, ay: y });
  }
  // also allow the outer border as an exit (it reads as "leaving the map")
  for (let x = exitCell.x0; x <= exitCell.x1; x++) {
    if (exitCell.y0 === 1) exitSpots.push({ x, y: 0, ax: x, ay: 1 });
    if (exitCell.y1 === H - 2) exitSpots.push({ x, y: H - 1, ax: x, ay: H - 2 });
  }
  if (!exitSpots.length) return null;
  const es = R.pick(exitSpots);
  set(es.x, es.y, T.EXIT);
  set(es.ax, es.ay, T.ALTAR);
  const exit = { x: es.x, y: es.y, open: false };
  const altar = { x: es.ax, y: es.ay };

  // --- spawn points ----------------------------------------------------------
  const spawns = [];
  for (let y = spawnCell.y0; y <= spawnCell.y1; y++) for (let x = spawnCell.x0; x <= spawnCell.x1; x++) spawns.push({ x: x + 0.5, y: y + 0.5 });
  R.shuffle(spawns);

  // --- monster spawn candidates: floor tiles far from spawn room -----------------
  // distance from the nearest tile of the spawn room (multi-source BFS), so a
  // big spawn room never puts a monster right beside a player
  const sources = [];
  for (let y = spawnCell.y0; y <= spawnCell.y1; y++) for (let x = spawnCell.x0; x <= spawnCell.x1; x++) sources.push(idx(x, y));
  const dist = bfsDistances(tiles, W, H, sources, true);
  const monsterSpots = [];
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const d = dist[idx(x, y)];
    if (tiles[idx(x, y)] === T.FLOOR && d >= 12) monsterSpots.push({ x, y, d });
  }
  R.shuffle(monsterSpots);
  if (monsterSpots.length < 6) return null;

  return {
    seed, W, H, tiles, cells, spawnCell: spawnCell.id, exitCell: exitCell.id,
    doors, keys, fragments, item, exit, altar, spawns, monsterSpots,
  };
}

function randomFloorInRoom(room, R, tiles, W) {
  for (let t = 0; t < 50; t++) {
    const x = R.int(room.x0, room.x1), y = R.int(room.y0, room.y1);
    if (tiles[y * W + x] === T.FLOOR) return { x: x + 0.5, y: y + 0.5 };
  }
  return { x: room.x0 + 0.5, y: room.y0 + 0.5 };
}

// BFS over passable tiles from one index or a list of source indexes;
// `allDoors` treats doors as passable (for distances)
function bfsDistances(tiles, W, H, sources, allDoors) {
  const dist = new Int32Array(W * H).fill(-1);
  const q = Array.isArray(sources) ? sources.slice() : [sources];
  for (const s of q) dist[s] = 0;
  for (let i = 0; i < q.length; i++) {
    const c = q[i], x = c % W, y = (c - x) / W, d = dist[c];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx, t = tiles[n];
      if (t === T.WALL || t === T.EXIT) continue;
      if (t === T.DOOR && !allDoors) continue;
      if (dist[n] !== -1) continue;
      dist[n] = d + 1; q.push(n);
    }
  }
  return dist;
}

// Key-aware flood fill: can the players collect every key, every fragment,
// the relic, and reach the altar and the exit?
function verify(map) {
  const { tiles, W, H, doors, keys, fragments, item, altar, exit } = map;
  const start = map.spawns[0];
  const owned = new Set();
  const doorAt = new Map(doors.map((d) => [d.y * W + d.x, d]));
  let reach;
  for (;;) {
    reach = new Uint8Array(W * H);
    const q = [Math.floor(start.y) * W + Math.floor(start.x)];
    reach[q[0]] = 1;
    for (let i = 0; i < q.length; i++) {
      const c = q[i], x = c % W, y = (c - x) / W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx, t = tiles[n];
        if (reach[n]) continue;
        if (t === T.WALL) continue;
        if (t === T.DOOR && !owned.has(doorAt.get(n).keyId)) continue;
        reach[n] = 1; q.push(n);
      }
    }
    let gained = false;
    for (const k of keys) if (!owned.has(k.id) && reach[Math.floor(k.y) * W + Math.floor(k.x)]) { owned.add(k.id); gained = true; }
    if (!gained) break;
  }
  const ok = (p) => reach[Math.floor(p.y) * W + Math.floor(p.x)] === 1;
  if (owned.size !== keys.length) return false;
  if (!fragments.every(ok)) return false;
  if (item && !ok(item)) return false;
  if (!ok(altar) || !ok(exit)) return false;
  return true;
}

module.exports = { generate, verify, T, makeRng, bfsDistances };
