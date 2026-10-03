'use strict';

const { generate, T, makeRng } = require('./mapgen');
const { LEVELS, MONSTERS, PLAYER, RUNES } = require('./levels');

const TICK = 1 / 30;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const HEAR_RANGE = 11; // tiles: monsters within this range are audible

let monsterSeq = 1;

// One running level for one room full of players. Fully server authoritative:
// clients only send movement intent and puzzle answers.
class Game {
  constructor(level, roomPlayers, emit) {
    this.level = level;
    this.cfg = LEVELS[level - 1];
    this.emit = emit; // (type, payload) => broadcast to room
    this.seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    this.R = makeRng(this.seed);
    this.map = generate(this.cfg, this.seed);
    this.W = this.map.W; this.H = this.map.H; this.tiles = this.map.tiles;
    this.doors = this.map.doors;
    this.keys = this.map.keys;
    this.exit = this.map.exit;
    this.altar = this.map.altar;
    this.item = this.map.item;
    this.timeLeft = this.cfg.time;
    this.elapsed = 0;
    this.status = 'running';
    this.escapeTimer = null;
    this.wrongAttempts = 0;
    this.doorsOpened = 0;
    this.scareTimer = this.rand(this.cfg.scare[0], this.cfg.scare[1]) * 0.6;
    this.phantomTimer = this.rand(12, 30);
    this.tick = 0;
    this.events = [];

    // Mystery: each fragment reveals a rune; the altar wants them in order.
    const runes = this.R.shuffle(RUNES.slice());
    this.map.fragments.forEach((f, i) => { f.rune = runes[i]; f.order = i + 1; });
    this.fragments = this.map.fragments;
    this.solution = this.fragments.map((f) => f.rune);
    this.solved = false;

    // Players
    this.players = new Map();
    let s = 0;
    for (const rp of roomPlayers) {
      const sp = this.map.spawns[s++ % this.map.spawns.length];
      const items = new Set(rp.profile.items || []);
      this.players.set(rp.id, {
        id: rp.id, name: rp.name, items,
        x: sp.x, y: sp.y, dx: 0, dy: 0, fx: 1, fy: 0,
        down: false, escaped: false, reviveProgress: 0, invuln: 4,
        vision: this.cfg.vision + (items.has('lantern') ? 1.5 : 0),
        speed: PLAYER.speed * (items.has('boots') ? 1.12 : 1),
        skeletonUsed: false, amuletUsed: false,
        pickups: 0,
      });
    }

    // Monsters
    this.monsters = [];
    const spots = this.map.monsterSpots.slice();
    const roster = Object.entries(this.cfg.monsters);
    // deeper monsters first so demons sit far from the spawn
    const far = spots.filter((p) => p.d >= 22), near = spots.filter((p) => p.d < 22);
    for (const [type, count] of roster) {
      for (let i = 0; i < count; i++) {
        const pool = (type === 'demon' || type === 'crawler') && far.length ? far : (near.length ? near : spots);
        const p = pool.splice(Math.floor(this.R.rand() * pool.length), 1)[0] || spots.pop();
        if (!p) break;
        this.monsters.push(this.makeMonster(type, p.x + 0.5, p.y + 0.5));
      }
    }
  }

  rand(lo, hi) { return lo + this.R.rand() * (hi - lo); }

  makeMonster(type, x, y) {
    const def = MONSTERS[type];
    const d = DIRS[Math.floor(this.R.rand() * 4)];
    return {
      id: monsterSeq++, type, x, y, dx: d[0], dy: d[1],
      speed: def.speed * this.cfg.speed, base: def.speed * this.cfg.speed,
      radius: def.radius, state: 'patrol', timer: this.rand(1, 4),
      silent: false, silenceTimer: this.rand(8, 25), chaseMemory: 0, target: null,
      teleportTimer: def.teleport ? this.rand(def.teleport[0], def.teleport[1]) : 0,
      dashLeft: 0, cry: this.rand(2, 7),
    };
  }

  // ---------------------------------------------------------------- tiles
  tileAt(x, y) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return T.WALL;
    return this.tiles[y * this.W + x];
  }
  doorAt(x, y) { return this.doors.find((d) => d.x === x && d.y === y); }

  passableForPlayer(tx, ty, p) {
    const t = this.tileAt(tx, ty);
    if (t === T.FLOOR || t === T.ALTAR) return true;
    if (t === T.EXIT) return this.exit.open;
    if (t === T.DOOR) {
      const d = this.doorAt(tx, ty);
      if (d.open) return true;
      // Opening the door is a side effect of walking into it with the key.
      if (this.ownedKeys.has(d.keyId)) { this.openDoor(d, p, false); return true; }
      if (p && p.items.has('skeleton') && !p.skeletonUsed) { p.skeletonUsed = true; this.openDoor(d, p, true); return true; }
      return false;
    }
    return false;
  }
  passableForMonster(tx, ty, m) {
    const t = this.tileAt(tx, ty);
    if (m.type === 'ghost') return tx >= 1 && ty >= 1 && tx < this.W - 1 && ty < this.H - 1 && t !== T.EXIT;
    if (t === T.FLOOR || t === T.ALTAR) return true;
    if (t === T.DOOR) return this.doorAt(tx, ty).open;
    return false;
  }

  openDoor(d, p, skeleton) {
    d.open = true; this.doorsOpened++;
    this.tiles[d.y * this.W + d.x] = T.DOOR; // stays a door tile, now open
    this.event({ kind: 'door', x: d.x, y: d.y, keyId: d.keyId, by: p ? p.name : null, skeleton: !!skeleton });
  }

  get ownedKeys() {
    if (!this._owned) this._owned = new Set();
    return this._owned;
  }

  event(e) { this.events.push(e); }

  // ---------------------------------------------------------------- input
  setInput(id, dx, dy) {
    const p = this.players.get(id);
    if (!p) return;
    p.dx = Math.max(-1, Math.min(1, Number(dx) || 0));
    p.dy = Math.max(-1, Math.min(1, Number(dy) || 0));
  }

  removePlayer(id) {
    this.players.delete(id);
    if (this.players.size === 0) this.finish(false, 'everyone left');
  }

  trySolve(id, seq) {
    const p = this.players.get(id);
    if (!p || p.down || p.escaped || this.solved) return;
    if (!this.fragments.every((f) => f.taken)) return;
    if (dist(p, { x: this.altar.x + 0.5, y: this.altar.y + 0.5 }) > 1.6) return;
    const ok = Array.isArray(seq) && seq.length === this.solution.length && seq.every((r, i) => r === this.solution[i]);
    if (ok) {
      this.solved = true; this.exit.open = true;
      this.event({ kind: 'exitOpen', by: p.name, x: this.exit.x, y: this.exit.y });
    } else {
      this.wrongAttempts++;
      this.timeLeft = Math.max(5, this.timeLeft - 15);
      this.event({ kind: 'wrong', by: p.name, penalty: 15 });
      this.event({ kind: 'scare', target: p.id, reason: 'altar' });
      // the dark answers back
      const spot = this.farSpot(p, 6);
      if (spot) this.monsters.push(this.makeMonster('imp', spot.x + 0.5, spot.y + 0.5));
    }
  }

  farSpot(from, minD) {
    for (let i = 0; i < 30; i++) {
      const s = this.map.monsterSpots[Math.floor(this.R.rand() * this.map.monsterSpots.length)];
      if (Math.abs(s.x + 0.5 - from.x) + Math.abs(s.y + 0.5 - from.y) >= minD) return s;
    }
    return null;
  }

  // ---------------------------------------------------------------- loop
  step() {
    if (this.status !== 'running') return;
    const dt = TICK;
    this.tick++;
    this.elapsed += dt;
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) { this.timeLeft = 0; return this.finish(false, 'The bell tolled. Time is up.'); }

    for (const p of this.players.values()) this.updatePlayer(p, dt);
    for (const m of this.monsters) this.updateMonster(m, dt);
    this.checkCatches();
    this.checkEnd(dt);
    this.updateScares(dt);
  }

  updatePlayer(p, dt) {
    if (p.invuln > 0) p.invuln -= dt;
    if (p.escaped) return;
    if (p.down) return;
    let dx = p.dx, dy = p.dy;
    if (dx || dy) {
      const len = Math.hypot(dx, dy); dx /= len; dy /= len;
      p.fx = dx; p.fy = dy;
      this.moveCircle(p, dx * p.speed * dt, dy * p.speed * dt, (tx, ty) => this.passableForPlayer(tx, ty, p));
    }
    // pickups
    for (const k of this.keys) {
      if (!k.taken && dist(p, k) < 0.7) { k.taken = true; this.ownedKeys.add(k.id); p.pickups++; this.event({ kind: 'key', keyId: k.id, by: p.name, x: k.x, y: k.y }); }
    }
    for (const f of this.fragments) {
      if (!f.taken && dist(p, f) < 0.7) { f.taken = true; p.pickups++; this.event({ kind: 'fragment', id: f.id, rune: f.rune, order: f.order, by: p.name, x: f.x, y: f.y }); }
    }
    if (this.item && !this.item.taken && dist(p, this.item) < 0.7) {
      this.item.taken = true; this.item.by = p.id;
      this.event({ kind: 'item', item: this.item.type, by: p.name, byId: p.id });
    }
    // reaching the open exit
    if (this.exit.open && Math.floor(p.x) === this.exit.x && Math.floor(p.y) === this.exit.y) {
      p.escaped = true;
      this.event({ kind: 'escaped', by: p.name });
      if (this.escapeTimer === null) this.escapeTimer = 15;
    }
    // reviving a fallen friend: stand next to them
    for (const o of this.players.values()) {
      if (o === p || !o.down) continue;
      if (dist(p, o) < 0.9) {
        o.reviveProgress += dt;
        if (o.reviveProgress >= PLAYER.reviveSeconds) {
          o.down = false; o.reviveProgress = 0; o.invuln = 3;
          this.event({ kind: 'revive', by: p.name, who: o.name });
        }
      }
    }
  }

  // Axis-separated circle vs tile collision with sliding.
  moveCircle(e, mx, my, passable) {
    const r = PLAYER.radius;
    const fits = (x, y) => {
      const x0 = Math.floor(x - r), x1 = Math.floor(x + r), y0 = Math.floor(y - r), y1 = Math.floor(y + r);
      for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) if (!passable(tx, ty)) return false;
      return true;
    };
    if (mx && fits(e.x + mx, e.y)) e.x += mx;
    else if (mx) { // slide up to the wall
      const dir = Math.sign(mx);
      const edge = dir > 0 ? Math.floor(e.x + r + mx) - r - 0.001 : Math.ceil(e.x - r + mx) + r + 0.001;
      if (fits(edge, e.y)) e.x = edge;
    }
    if (my && fits(e.x, e.y + my)) e.y += my;
    else if (my) {
      const dir = Math.sign(my);
      const edge = dir > 0 ? Math.floor(e.y + r + my) - r - 0.001 : Math.ceil(e.y - r + my) + r + 0.001;
      if (fits(e.x, edge)) e.y = edge;
    }
  }

  // ---------------------------------------------------------------- monsters
  // Monsters move "inline": straight along a row or column, lane centred,
  // and only change direction at tile centres.
  updateMonster(m, dt) {
    const def = MONSTERS[m.type];
    // Stealth: monsters sometimes go silent so they can come out of nowhere.
    m.silenceTimer -= dt;
    if (m.silenceTimer <= 0) {
      m.silent = !m.silent;
      m.silenceTimer = m.silent ? this.rand(5, 12) : this.rand(10, 30);
    }
    m.cry -= dt;
    if (m.cry <= 0) {
      m.cry = this.rand(3, 9);
      if (!m.silent) this.event({ kind: 'cry', type: m.type, x: m.x, y: m.y, id: m.id });
    }

    switch (m.type) {
      case 'zombie':
        this.moveInline(m, m.speed * dt, (open) => this.pickDir(m, open, def.turnChance));
        break;
      case 'imp':
        m.teleportTimer -= dt;
        if (m.teleportTimer <= 0) {
          m.teleportTimer = this.rand(def.teleport[0], def.teleport[1]);
          const nearest = this.nearestAlive(m);
          const spot = nearest ? this.farSpot(nearest, 5) : null;
          if (spot) { this.event({ kind: 'teleport', type: 'imp', from: { x: m.x, y: m.y }, x: spot.x + 0.5, y: spot.y + 0.5 }); m.x = spot.x + 0.5; m.y = spot.y + 0.5; }
        }
        this.moveInline(m, m.speed * dt, (open) => this.pickDir(m, open, def.turnChance));
        break;
      case 'ghost': {
        m.timer -= dt;
        if (m.timer <= 0) {
          m.timer = this.rand(def.retarget[0], def.retarget[1]);
          const near = this.nearestAlive(m);
          if (near && dist(near, m) < 8 && this.R.rand() < 0.35) {
            // drift toward the nearest soul along a single axis
            if (Math.abs(near.x - m.x) > Math.abs(near.y - m.y)) { m.dx = Math.sign(near.x - m.x); m.dy = 0; } else { m.dx = 0; m.dy = Math.sign(near.y - m.y) || 1; }
          } else { const d = DIRS[Math.floor(this.R.rand() * 4)]; m.dx = d[0]; m.dy = d[1]; }
        }
        this.moveInline(m, m.speed * dt, (open) => this.pickDir(m, open, 0));
        break;
      }
      case 'crawler':
        if (m.state === 'patrol') {
          m.timer -= dt;
          this.moveInline(m, m.speed * dt, (open) => this.pickDir(m, open, 0.3));
          if (m.timer <= 0) { m.state = 'wait'; m.timer = this.rand(def.wait[0], def.wait[1]); }
        } else if (m.state === 'wait') {
          m.timer -= dt;
          if (m.timer <= 0) {
            // dash toward a player if one shares the lane, otherwise a random open lane
            const seen = this.lineOfSight(m, 10);
            if (seen) { m.dx = seen.dx; m.dy = seen.dy; } else {
              const open = this.openDirs(m); if (open.length) { const d = this.R.pick(open); m.dx = d[0]; m.dy = d[1]; }
            }
            m.state = 'dash'; m.dashLeft = this.rand(def.dashTiles[0], def.dashTiles[1]);
            if (!m.silent) this.event({ kind: 'cry', type: 'crawler', x: m.x, y: m.y, id: m.id, dash: true });
          }
        } else { // dash
          const before = { x: m.x, y: m.y };
          const blocked = this.moveInline(m, def.dash * this.cfg.speed * dt, () => { return false; });
          m.dashLeft -= Math.abs(m.x - before.x) + Math.abs(m.y - before.y);
          if (blocked || m.dashLeft <= 0) { m.state = 'patrol'; m.timer = this.rand(2, 5); }
        }
        break;
      case 'demon': {
        const seen = this.lineOfSight(m, def.sight);
        if (seen) {
          if (m.state !== 'chase' && !m.silent) this.event({ kind: 'cry', type: 'demon', x: m.x, y: m.y, id: m.id, roar: true });
          m.state = 'chase'; m.dx = seen.dx; m.dy = seen.dy;
          m.chaseMemory = def.memory * (seen.player.items.has('ward') ? 0.5 : 1);
        } else if (m.state === 'chase') {
          m.chaseMemory -= dt;
          if (m.chaseMemory <= 0) m.state = 'patrol';
        }
        const spd = m.state === 'chase' ? def.charge * this.cfg.speed : m.speed;
        const blocked = this.moveInline(m, spd * dt, (open) => this.pickDir(m, open, m.state === 'chase' ? 0 : 0.2));
        if (blocked && m.state === 'chase') m.state = 'patrol';
        break;
      }
    }
  }

  openDirs(m) {
    const tx = Math.floor(m.x), ty = Math.floor(m.y);
    return DIRS.filter(([dx, dy]) => this.passableForMonster(tx + dx, ty + dy, m));
  }

  pickDir(m, open, turnChance) {
    // called at a tile centre. `open` = list of passable dirs. Returns new dir or null to keep going.
    const ahead = open.find(([dx, dy]) => dx === m.dx && dy === m.dy);
    const sides = open.filter(([dx, dy]) => !(dx === -m.dx && dy === -m.dy) && !(dx === m.dx && dy === m.dy));
    if (ahead && !(sides.length && this.R.rand() < turnChance)) return null;
    if (sides.length) return this.R.pick(sides);
    if (ahead) return null;
    const back = open.find(([dx, dy]) => dx === -m.dx && dy === -m.dy);
    return back || null;
  }

  // Advance along the current lane; at each tile centre consult `decide`.
  // Returns true if the monster was blocked (no move possible).
  moveInline(m, step, decide) {
    let blocked = false;
    let guard = 0;
    while (step > 0 && guard++ < 4) {
      const cx = Math.floor(m.x) + 0.5, cy = Math.floor(m.y) + 0.5;
      // keep lane centred on the perpendicular axis
      if (m.dx) m.y = cy; else m.x = cx;
      const along = m.dx ? m.x : m.y;
      const center = m.dx ? cx : cy;
      const d = m.dx || m.dy;
      const toCenter = (center - along) * d; // >0 if centre is ahead
      if (toCenter > 1e-6) {
        const mv = Math.min(step, toCenter);
        if (m.dx) m.x += m.dx * mv; else m.y += m.dy * mv;
        step -= mv;
        continue;
      }
      // at the centre: decide
      const open = this.openDirs(m);
      if (!open.length) return true;
      const nd = decide(open);
      if (nd) { m.dx = nd[0]; m.dy = nd[1]; }
      const tx = Math.floor(m.x) + m.dx, ty = Math.floor(m.y) + m.dy;
      if (!this.passableForMonster(tx, ty, m)) {
        // decide() kept a blocked direction (dash/chase): reverse or stop
        blocked = true;
        const alt = open.find(([dx, dy]) => dx === -m.dx && dy === -m.dy) || open[0];
        if (m.type === 'crawler' && m.state === 'dash') return true;
        if (m.type === 'demon' && m.state === 'chase') return true;
        m.dx = alt[0]; m.dy = alt[1];
      }
      // move toward the next centre
      const mv = Math.min(step, 1);
      if (m.dx) m.x += m.dx * mv; else m.y += m.dy * mv;
      step -= mv;
    }
    return blocked;
  }

  nearestAlive(m) {
    let best = null, bd = Infinity;
    for (const p of this.players.values()) {
      if (p.down || p.escaped) continue;
      const d = dist(p, m);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  // A living player in the same row or column with no wall between.
  lineOfSight(m, range) {
    const mx = Math.floor(m.x), my = Math.floor(m.y);
    for (const p of this.players.values()) {
      if (p.down || p.escaped || p.invuln > 0) continue;
      const px = Math.floor(p.x), py = Math.floor(p.y);
      if (px !== mx && py !== my) continue;
      const d = Math.abs(px - mx) + Math.abs(py - my);
      if (d > range || d === 0) continue;
      const dx = Math.sign(px - mx), dy = Math.sign(py - my);
      let clear = true;
      for (let i = 1; i < d; i++) if (!this.passableForMonster(mx + dx * i, my + dy * i, m)) { clear = false; break; }
      if (clear) return { dx, dy, player: p, d };
    }
    return null;
  }

  checkCatches() {
    for (const p of this.players.values()) {
      if (p.down || p.escaped || p.invuln > 0) continue;
      for (const m of this.monsters) {
        if (dist(p, m) < PLAYER.radius + m.radius) {
          if (p.items.has('amulet') && !p.amuletUsed) {
            p.amuletUsed = true; p.invuln = 3;
            this.event({ kind: 'amulet', by: p.name });
            break;
          }
          p.down = true; p.reviveProgress = 0;
          this.event({ kind: 'caught', who: p.name, whoId: p.id, type: m.type, x: p.x, y: p.y });
          this.event({ kind: 'scare', target: p.id, reason: 'caught', type: m.type });
          break;
        }
      }
    }
  }

  checkEnd(dt) {
    const all = [...this.players.values()];
    const active = all.filter((p) => !p.escaped);
    const alive = active.filter((p) => !p.down);
    if (all.length && alive.length === 0 && active.length > 0) {
      return this.finish(false, 'They got all of you.');
    }
    if (this.escapeTimer !== null) {
      this.escapeTimer -= dt;
      if (this.escapeTimer <= 0 || active.length === 0) return this.finish(true, 'You escaped the night.');
    }
  }

  updateScares(dt) {
    // Random jump scares, more frequent on harder levels.
    this.scareTimer -= dt;
    if (this.scareTimer <= 0) {
      this.scareTimer = this.rand(this.cfg.scare[0], this.cfg.scare[1]);
      const alive = [...this.players.values()].filter((p) => !p.down && !p.escaped);
      if (alive.length) {
        const victim = this.R.pick(alive);
        this.event({ kind: 'scare', target: victim.id, reason: 'random' });
      }
    }
    // Phantom sounds: a monster that is not there.
    this.phantomTimer -= dt;
    if (this.phantomTimer <= 0) {
      this.phantomTimer = this.rand(10, 28) / Math.max(1, this.cfg.speed);
      const alive = [...this.players.values()].filter((p) => !p.down && !p.escaped);
      if (alive.length) {
        const p = this.R.pick(alive);
        const types = Object.keys(this.cfg.monsters);
        const a = this.R.rand() * Math.PI * 2, r = this.rand(3, 7);
        this.event({ kind: 'phantom', target: p.id, type: this.R.pick(types), x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r });
      }
    }
  }

  finish(won, reason) {
    if (this.status !== 'running') return;
    this.status = won ? 'won' : 'lost';
    this.reason = reason;
    const escaped = [...this.players.values()].filter((p) => p.escaped).length;
    const frags = this.fragments.filter((f) => f.taken).length;
    const keys = this.keys.filter((k) => k.taken).length;
    let score = 0;
    if (won) {
      score = this.level * 1000 + Math.round(this.timeLeft) * 8 * this.level + frags * 150 + keys * 100 + escaped * 500;
      if (this.wrongAttempts === 0) score += 300;
      if ([...this.players.values()].every((p) => p.escaped)) score += 400 * this.level;
    } else {
      score = this.level * 60 + frags * 50 + keys * 50 + Math.round(this.elapsed) * 2;
    }
    this.result = { won, reason, score, level: this.level, levelName: this.cfg.name, escaped, frags, keys, timeLeft: Math.round(this.timeLeft), elapsed: Math.round(this.elapsed), players: [...this.players.values()].map((p) => p.name) };
    this.emit('finished', this.result);
  }

  // ---------------------------------------------------------------- snapshots
  initPacket() {
    return {
      level: this.level, name: this.cfg.name, difficulty: this.cfg.difficulty, intro: this.cfg.intro,
      W: this.W, H: this.H, tiles: Array.from(this.tiles).join(''),
      doors: this.doors.map((d) => ({ x: d.x, y: d.y, keyId: d.keyId })),
      exit: { x: this.exit.x, y: this.exit.y }, altar: this.altar,
      time: this.cfg.time, fragments: this.fragments.length, keys: this.keys.length,
      monsters: Object.keys(this.cfg.monsters), seed: this.seed,
    };
  }

  snapshot() {
    const players = [...this.players.values()].map((p) => ({
      id: p.id, x: r2(p.x), y: r2(p.y), fx: Math.round(p.fx), fy: Math.round(p.fy), down: p.down, esc: p.escaped,
      rv: p.down ? r2(p.reviveProgress / PLAYER.reviveSeconds) : 0, vis: r2(p.vision), inv: p.invuln > 0,
    }));
    const alive = players.filter((p) => !p.down && !p.esc);
    const monsters = [];
    for (const m of this.monsters) {
      let seen = false, heard = false;
      for (const p of alive) {
        const d = Math.hypot(p.x - m.x, p.y - m.y);
        if (d <= p.vis + 0.6) seen = true;
        if (d <= HEAR_RANGE) heard = true;
      }
      if (!seen && (!heard || m.silent)) continue;
      monsters.push({ id: m.id, t: m.type, x: r2(m.x), y: r2(m.y), dx: m.dx, dy: m.dy, s: m.state, v: seen ? 1 : 0, q: m.silent ? 1 : 0 });
    }
    const snap = {
      tick: this.tick, time: Math.ceil(this.timeLeft), players, monsters,
      keys: this.keys.filter((k) => !k.taken).map((k) => ({ id: k.id, x: k.x, y: k.y })),
      frags: this.fragments.filter((f) => !f.taken).map((f) => ({ id: f.id, x: f.x, y: f.y })),
      got: this.fragments.filter((f) => f.taken).map((f) => ({ rune: f.rune, order: f.order })),
      owned: [...this.ownedKeys], doors: this.doors.filter((d) => d.open).map((d) => d.keyId),
      item: this.item && !this.item.taken ? { x: this.item.x, y: this.item.y, type: this.item.type } : null,
      exitOpen: this.exit.open, solved: this.solved, esc: this.escapeTimer === null ? null : Math.ceil(this.escapeTimer),
      events: this.events,
    };
    this.events = [];
    return snap;
  }
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function r2(v) { return Math.round(v * 100) / 100; }

module.exports = { Game, TICK };
