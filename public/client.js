// Nightfall client: lobby, networking, rendering, HUD, puzzle, scares.
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const Audio = window.NightAudio;
  const Assets = window.NightAssets;
  Assets.load().then(() => { if (S.game) resize(); });
  // Draw a sprite centred at (x,y) on `c` (default main ctx); `size` = its larger side in tiles.
  function sprite(key, x, y, s, size, flip, alpha, c) {
    const sp = Assets.img[key]; if (!sp) return false;
    const g = c || ctx;
    g.save(); g.translate(x, y); if (flip) g.scale(-1, 1); if (alpha !== undefined) g.globalAlpha = alpha;
    const k = (s * size) / Math.max(sp.width, sp.height), w = sp.width * k, h = sp.height * k;
    g.drawImage(sp.img, sp.sx, sp.sy, sp.sw, sp.sh, -w / 2, -h / 2, w, h); g.restore();
    return true;
  }
  // Pick a directional sprite key (type_s / type_e / type_n / type_w) with fallbacks.
  function dirKey(base, dx, dy, frame) {
    const d = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'w' : dx > 0 ? 'e' : 's') : (dy < 0 ? 'n' : 's');
    const keys = frame ? [`${base}_${d}2`, `${base}_${d}`, `${base}_s2`, `${base}_s`, base] : [`${base}_${d}`, `${base}_s`, base];
    for (const k of keys) if (Assets.has(k)) return k;
    return null;
  }
  // Walk cycle: the sheet has two poses per facing; alternate them while moving.
  const WALK_FPS = 7;
  function walkFrame(time, ph) { return Math.floor(time * WALK_FPS + (ph || 0)) % 2; }
  function theme() { return S.game && Assets.themes ? Assets.themes[String(S.game.level)] : null; }

  const KEY_COLORS = ['#e0b33c', '#3fa7d6', '#d64a6a', '#5ad17a', '#b67ae6', '#f0f0f0'];
  const KEY_NAMES = ['golden', 'blue', 'crimson', 'green', 'violet', 'bone'];
  const PLAYER_COLORS = ['#f2c14e', '#6cc5f5', '#f27d9d', '#8ff0a4', '#c99cff', '#ffb27a'];
  const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
  const T = { FLOOR: 0, WALL: 1, DOOR: 2, EXIT: 3, ALTAR: 4 };

  const S = {
    ws: null, id: null, levels: [], itemsMeta: {}, room: null, profile: null,
    game: null, snap: null, prevTime: 0, disp: new Map(), mon: new Map(),
    keys: {}, input: { dx: 0, dy: 0 }, lastSent: 0, lastInput: '',
    tile: 24, cam: { x: 0, y: 0 }, mapCanvas: null, fogCanvas: null, muted: false,
    puzzleSeq: [], log: [], nearAltar: false, scareUntil: 0, msgs: [], floaters: [], hideOrder: false,
    connected: false, pendingJoin: null, ending: false, playerColor: new Map(), lastSnapAt: 0,
  };

  // ============================================================ networking
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}`);
    S.ws = ws;
    ws.onopen = () => { S.connected = true; if (S.pendingJoin) { send(S.pendingJoin); S.pendingJoin = null; } };
    ws.onclose = () => {
      S.connected = false;
      if (S.game) { toast('Connection lost. Returning to the lobby.'); leaveGameUI(); }
      setTimeout(connect, 1500);
    };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } onMessage(m); };
  }
  function send(m) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); }

  function onMessage(m) {
    switch (m.t) {
      case 'hello': S.id = m.id; S.levels = m.levels; S.itemsMeta = m.items; renderScores($('#scores-table tbody'), m.scores); break;
      case 'joined': S.profile = m.profile; Audio.startMusic(); $('#room-code-display').textContent = m.code; $('#join-panel').classList.add('hidden'); $('#room-panel').classList.remove('hidden'); $('#scores-panel').classList.add('full'); break;
      case 'room': S.room = m; renderRoom(); break;
      case 'left': S.room = null; $('#room-panel').classList.add('hidden'); $('#join-panel').classList.remove('hidden'); $('#scores-panel').classList.remove('full'); break;
      case 'error': toast(m.msg); break;
      case 'scores': renderScores($('#scores-table tbody'), m.scores); break;
      case 'start': startGame(m); break;
      case 'state': onState(m); break;
      case 'end': onEnd(m); break;
      default: break;
    }
  }

  // ============================================================ lobby
  function toast(msg) {
    const el = $('#lobby-error'); el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), 3500);
  }
  function renderScores(tbody, scores) {
    tbody.innerHTML = '';
    if (!scores || !scores.length) { tbody.innerHTML = '<tr><td colspan="5" class="hint">No one has survived the night yet. Be the first.</td></tr>'; return; }
    scores.forEach((s, i) => {
      const tr = document.createElement('tr');
      const d = new Date(s.at);
      tr.innerHTML = `<td>${i + 1}</td><td>${esc(s.team.join(', '))}</td><td>${s.level} · ${esc(s.levelName || '')}</td><td class="score">${s.score.toLocaleString()}</td><td class="${s.won ? 'won' : 'lost'}" title="${d.toLocaleString()}">${s.won ? 'escaped' : 'taken'}</td>`;
      tbody.appendChild(tr);
    });
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

  function renderRoom() {
    const r = S.room; if (!r) return;
    const isHost = r.host === S.id;
    const ul = $('#player-list'); ul.innerHTML = '';
    S.playerColor.clear();
    r.players.forEach((p, i) => {
      S.playerColor.set(p.id, PLAYER_COLORS[i % PLAYER_COLORS.length]);
      const li = document.createElement('li');
      li.innerHTML = `<span style="color:${PLAYER_COLORS[i % PLAYER_COLORS.length]}">● ${esc(p.name)}${p.id === S.id ? ' (you)' : ''}</span><span class="tag">${p.id === r.host ? 'host · ' : ''}night ${p.unlocked} · ${p.wins} wins</span>`;
      ul.appendChild(li);
      if (p.id === S.id) S.profile = { ...(S.profile || {}), items: p.items, unlocked: p.unlocked };
    });
    const rl = $('#relic-list'); rl.innerHTML = '';
    const items = (S.profile && S.profile.items) || [];
    if (!items.length) rl.innerHTML = '<li class="hint">None yet. Relics are hidden deep in each night and stay with you forever.</li>';
    for (const it of items) { const meta = S.itemsMeta[it]; const li = document.createElement('li'); li.innerHTML = `✦ ${esc(meta ? meta.name : it)}<small>${esc(meta ? meta.desc : '')}</small>`; rl.appendChild(li); }

    const grid = $('#level-grid'); grid.innerHTML = '';
    for (const L of S.levels) {
      const b = document.createElement('button');
      const locked = L.n > r.unlocked;
      b.className = 'level' + (L.n === r.level ? ' selected' : '') + (locked ? ' locked' : '');
      b.innerHTML = `<span class="n">NIGHT ${L.n}${locked ? ' 🔒' : ''}</span><span class="nm">${esc(L.name)}</span><span class="df ${L.difficulty.split(' ')[0]}">${L.difficulty}</span>`;
      b.disabled = !isHost || locked || r.inGame;
      b.onclick = () => send({ t: 'setLevel', level: L.n });
      grid.appendChild(b);
    }
    const L = S.levels[r.level - 1];
    if (L) {
      const mons = Object.entries(L.monsters).map(([k, v]) => `<span class="mon-chip">${v} ${k}${v > 1 ? 's' : ''}</span>`).join('');
      $('#level-info').innerHTML = `<b>${esc(L.name)}</b> — ${L.difficulty}. ${esc(L.intro)}<br>${mons}<br>${Math.floor(L.time / 60)}:${String(L.time % 60).padStart(2, '0')} on the clock · ${L.keys} locked door${L.keys > 1 ? 's' : ''} · ${L.fragments} rune fragments · vision ${L.vision} tiles${L.item ? ` · a relic is hidden here: <b>${esc(S.itemsMeta[L.item].name)}</b>` : ''}`;
    }
    $('#btn-start').disabled = !isHost || r.inGame;
    $('#host-note').textContent = isHost ? 'You are the host. Pick the night and begin when everyone is here.' : 'Waiting for the host to begin the night…';
  }

  $('#name').value = localStorage.getItem('nf-name') || '';
  function doJoin(room) {
    const name = $('#name').value.trim() || 'Stranger';
    localStorage.setItem('nf-name', name);
    Audio.init(); Audio.resume();
    const msg = { t: 'join', name, room: room || undefined };
    if (S.connected) send(msg); else S.pendingJoin = msg;
  }
  $('#btn-create').onclick = () => doJoin();
  $('#btn-join').onclick = () => { const c = $('#room-code').value.trim().toUpperCase(); if (c.length !== 4) return toast('Room codes have 4 characters.'); doJoin(c); };
  $('#room-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
  $('#name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-create').click(); });
  $('#btn-leave').onclick = () => send({ t: 'leave' });
  $('#btn-start').onclick = () => { Audio.init(); Audio.resume(); send({ t: 'start' }); };
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) $('#room-code').value = urlRoom.toUpperCase();

  // ============================================================ game lifecycle
  const canvas = $('#canvas'), ctx = canvas.getContext('2d');

  function startGame(init) {
    S.game = init; S.snap = null; S.disp.clear(); S.mon.clear(); S.log = []; S.floaters = []; S.ending = false;
    S.puzzleSeq = []; S.hideOrder = init.level >= 6;
    S.game.tilesArr = Uint8Array.from(init.tiles, (c) => +c);
    S.game.doorMap = new Map(init.doors.map((d) => [d.y * init.W + d.x, d]));
    $('#lobby').classList.add('hidden'); $('#game').classList.remove('hidden');
    $('#end').classList.add('hidden'); $('#puzzle').classList.add('hidden');
    try { $('#lobby-video').pause(); } catch (e) { /* no video */ }
    $('#hud-level-name').textContent = `Night ${init.level} · ${init.name}`;
    $('#hud-difficulty').textContent = init.difficulty;
    $('#hud-log').innerHTML = '';
    $('#intro-title').textContent = init.name;
    $('#intro-text').textContent = init.intro;
    $('#intro-roster').textContent = `Tonight: ${init.monsters.join(', ')}. ${init.keys} locked door${init.keys > 1 ? 's' : ''}, ${init.fragments} rune fragments.`;
    $('#intro-warm').textContent = '';
    $('#touch').classList.toggle('hidden', !('ontouchstart' in window));
    resize();
    Audio.init(); Audio.resume();
    if (init.cinematic) { Audio.stopMusic(); playCinematic(); } else { $('#intro').classList.remove('hidden'); Audio.startMusic(); }
    if (!S.raf) loop(performance.now());
  }
  $('#btn-intro-ok').onclick = () => { $('#intro').classList.add('hidden'); Audio.resume(); };

  // The opening cinematic: plays once per room while the server holds the night frozen.
  function playCinematic() {
    const box = $('#cinematic'), v = $('#cinematic-video');
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      try { v.pause(); } catch (e) { /* ignore */ }
      box.classList.add('hidden');
      if (S.game) { $('#intro').classList.remove('hidden'); Audio.startMusic(); }
    };
    box.classList.remove('hidden');
    v.currentTime = 0; v.muted = S.muted; v.volume = 0.9;
    v.onended = finish; v.onerror = finish;
    $('#btn-skip').onclick = finish;
    const p = v.play();
    if (p && p.catch) p.catch(() => { v.muted = true; v.play().catch(finish); }); // autoplay with sound refused: play muted
    clearTimeout(playCinematic.t); playCinematic.t = setTimeout(finish, 20000); // never trap the player
  }

  function leaveGameUI() {
    S.game = null; S.snap = null;
    $('#cinematic').classList.add('hidden'); try { $('#cinematic-video').pause(); $('#lobby-video').play(); } catch (e) { /* ignore */ }
    Audio.startMusic();
    $('#game').classList.add('hidden'); $('#lobby').classList.remove('hidden');
    $('#game').classList.remove('shake');
    renderRoom();
  }
  $('#btn-end-lobby').onclick = leaveGameUI;

  function onEnd(m) {
    S.ending = true;
    $('#end-title').textContent = m.won ? 'YOU ESCAPED THE NIGHT' : 'THE NIGHT TOOK YOU';
    $('#end-title').style.color = m.won ? '#5ad17a' : '#ff3b3b';
    $('#end-reason').textContent = m.reason + (m.won && m.level < S.levels.length ? ` Night ${m.level + 1} is now unlocked.` : '');
    $('#end-stats').innerHTML = [['Score', m.score.toLocaleString()], ['Escaped', `${m.escaped}/${m.players.length}`], ['Fragments', m.frags], ['Keys', m.keys], [m.won ? 'Time left' : 'Survived', fmt(m.won ? m.timeLeft : m.elapsed)]].map(([k, v]) => `<div><b>${v}</b><small>${k}</small></div>`).join('');
    renderScores($('#end-scores tbody'), m.scores);
    renderScores($('#scores-table tbody'), m.scores);
    $('#puzzle').classList.add('hidden');
    setTimeout(() => { $('#end').classList.remove('hidden'); }, 900);
    if (m.won) Audio.victory(); else Audio.defeat();
    Audio.stopMusic();
  }
  function fmt(s) { s = Math.max(0, s | 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

  // ============================================================ state + events
  function onState(snap) {
    if (!S.game) return;
    S.snap = snap; S.lastSnapAt = performance.now();
    for (const e of snap.events) onEvent(e);
    updateHud();
  }
  function me() { return S.snap && S.snap.players.find((p) => p.id === S.id); }
  function nameOf(id) { const p = S.room && S.room.players.find((x) => x.id === id); return p ? p.name : '?'; }

  function addLog(text, cls) {
    const el = $('#hud-log'); const d = document.createElement('div'); d.textContent = text; if (cls) d.className = cls; el.appendChild(d);
    while (el.children.length > 6) el.removeChild(el.firstChild);
    setTimeout(() => { if (d.parentNode) d.parentNode.removeChild(d); }, 9000);
  }
  function floater(x, y, text, color) { S.floaters.push({ x, y, text, color, t: 0 }); }

  function onEvent(e) {
    const mine = e.target === S.id || e.byId === S.id || e.whoId === S.id;
    switch (e.kind) {
      case 'key': addLog(`${e.by} found the ${KEY_NAMES[e.keyId] || ''} key.`, 'good'); Audio.pickup('key'); floater(e.x, e.y, 'KEY', KEY_COLORS[e.keyId]); break;
      case 'fragment': addLog(`${e.by} found a rune fragment: ${e.rune} — the ${ordinal(e.order)} mark.`, 'good'); Audio.pickup('fragment'); floater(e.x, e.y, e.rune, '#ffd98a'); break;
      case 'door': addLog(e.skeleton ? `${e.by} forced a door with the Skeleton Key.` : `${e.by} unlocked the ${KEY_NAMES[e.keyId] || ''} door.`); Audio.door({ x: e.x + 0.5, y: e.y + 0.5 }); break;
      case 'item': addLog(`${e.by} found a relic: ${e.itemName || e.item}. ${e.itemDesc || ''}`, 'relic'); Audio.pickup('item'); break;
      case 'caught': addLog(`${e.who} was taken by a ${e.type}!`, 'bad'); Audio.caught(); if (mine) shake(900); break;
      case 'revive': addLog(`${e.by} pulled ${e.who} back from the dark.`, 'good'); Audio.pickup('fragment'); break;
      case 'wrong': addLog(`The altar rejects ${e.by}'s offering. ${e.penalty} seconds lost. Something stirs…`, 'bad'); Audio.wrong(); if (mine) { S.puzzleSeq = []; renderPuzzle(); } break;
      case 'exitOpen': addLog(`${e.by} read the altar. The exit is open. RUN.`, 'good'); Audio.bell(3); $('#puzzle').classList.add('hidden'); break;
      case 'escaped': addLog(`${e.by} escaped into the night.`, 'good'); break;
      case 'amulet': addLog(`${e.by}'s amulet shattered and took the blow.`, 'relic'); break;
      case 'teleport': Audio.monster('imp', e.from); break;
      case 'cry': Audio.monster(e.type, { x: e.x, y: e.y }, { dash: e.dash, roar: e.roar }); break;
      case 'phantom': if (e.target === S.id) Audio.phantom(e.type, { x: e.x, y: e.y }); break;
      case 'scare': if (e.target === S.id) jumpScare(e.reason, e.type); break;
      default: break;
    }
  }
  function ordinal(n) { return ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'][n] || `${n}th`; }

  function updateHud() {
    const s = S.snap, g = S.game; if (!s || !g) return;
    const timer = $('#hud-timer'); timer.textContent = fmt(s.time); timer.classList.toggle('low', s.time <= 30);
    const keys = $('#hud-keys'); keys.innerHTML = '';
    for (let i = 0; i < g.keys; i++) { const d = document.createElement('div'); d.className = 'key-ic' + (s.owned.includes(i) ? ' got' : ''); d.style.color = KEY_COLORS[i]; keys.appendChild(d); }
    const runes = $('#hud-runes'); runes.innerHTML = '';
    const got = s.got.slice().sort((a, b) => a.order - b.order);
    for (let i = 0; i < g.fragments; i++) {
      const d = document.createElement('div'); d.className = 'rune-ic';
      const r = S.hideOrder ? s.got[i] : got.find((x) => x.order === i + 1);
      if (r) { d.classList.add('got'); d.textContent = r.rune; if (!S.hideOrder) d.innerHTML += `<small>${ROMAN[r.order]}</small>`; } else d.textContent = '?';
      runes.appendChild(d);
    }
    const pl = $('#hud-players'); pl.innerHTML = '';
    for (const p of s.players) {
      const d = document.createElement('div'); d.className = 'hp' + (p.down ? ' down' : '') + (p.esc ? ' esc' : '');
      d.innerHTML = `<span class="dot" style="background:${S.playerColor.get(p.id) || '#fff'}"></span>${esc(nameOf(p.id))}${p.id === S.id ? ' (you)' : ''} ${p.esc ? '· escaped' : p.down ? '· DOWN' : ''}`;
      pl.appendChild(d);
    }
    const m = me();
    let obj = '';
    const remaining = g.fragments - s.got.length;
    if (m && m.down) obj = 'You are down. A friend can revive you by standing beside you for a moment.';
    else if (m && m.esc) obj = 'You made it out. Wait for the others.';
    else if (s.exitOpen) obj = 'The exit is open. Run for it.';
    else if (remaining > 0) obj = `Find the rune fragments (${s.got.length}/${g.fragments}). ${S.hideOrder ? 'Remember the order they were marked.' : ''} Keys open the locked doors.`;
    else obj = 'Every fragment is found. Read the altar.';
    $('#hud-objective').textContent = obj;
    const escEl = $('#hud-escape');
    if (s.warm > 0) { escEl.classList.remove('hidden'); escEl.textContent = `THE NIGHT BEGINS IN ${s.warm}`; }
    else { escEl.classList.toggle('hidden', s.esc === null); if (s.esc !== null) escEl.textContent = `THE DOOR CLOSES IN ${s.esc}`; }
    $('#intro-warm').textContent = s.warm > 0 ? `The night begins in ${s.warm}` : 'The night has begun';
    S.nearAltar = !!(m && !m.down && !m.esc && remaining === 0 && !s.solved && Math.hypot(m.x - g.altar.x - 0.5, m.y - g.altar.y - 0.5) < 1.6);
    const prompt = $('#hud-prompt'); prompt.classList.toggle('hidden', !S.nearAltar || !$('#puzzle').classList.contains('hidden'));
    prompt.textContent = 'Press E (or tap E) to read the altar';
  }

  // ============================================================ puzzle
  function openPuzzle() {
    if (!S.nearAltar) return;
    S.puzzleSeq = [];
    $('#puzzle-hint').textContent = S.hideOrder ? 'Offer the runes in the order the fragments were marked. The altar gives no reminder here; only your memory does. A wrong offering costs 15 seconds and wakes something.' : 'Offer the runes in the order the fragments were marked (I, II, III…). A wrong offering costs 15 seconds and wakes something.';
    renderPuzzle(); $('#puzzle').classList.remove('hidden');
  }
  function renderPuzzle() {
    const s = S.snap, g = S.game; if (!s) return;
    const seq = $('#puzzle-seq'); seq.innerHTML = '';
    for (let i = 0; i < g.fragments; i++) { const sp = document.createElement('span'); sp.textContent = S.puzzleSeq[i] || ''; seq.appendChild(sp); }
    const pad = $('#puzzle-pad'); pad.innerHTML = '';
    const runes = s.got.map((x) => x.rune).sort();
    for (const r of runes) {
      const b = document.createElement('button'); b.textContent = r; if (S.puzzleSeq.includes(r)) b.classList.add('used');
      b.onclick = () => { if (!S.puzzleSeq.includes(r) && S.puzzleSeq.length < g.fragments) { S.puzzleSeq.push(r); renderPuzzle(); } };
      pad.appendChild(b);
    }
    $('#btn-puzzle-submit').disabled = S.puzzleSeq.length !== g.fragments;
  }
  $('#btn-puzzle-clear').onclick = () => { S.puzzleSeq = []; renderPuzzle(); };
  $('#btn-puzzle-close').onclick = () => $('#puzzle').classList.add('hidden');
  $('#btn-puzzle-submit').onclick = () => send({ t: 'solve', seq: S.puzzleSeq });

  // ============================================================ input
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    S.keys[e.code] = true;
    if (S.game && (e.code === 'KeyE' || e.code === 'Space' || e.code === 'Enter')) {
      if (!$('#intro').classList.contains('hidden')) $('#intro').classList.add('hidden');
      else if ($('#puzzle').classList.contains('hidden')) openPuzzle();
      e.preventDefault();
    }
    if (e.code === 'KeyM') toggleMute();
    if (e.code === 'Escape') $('#puzzle').classList.add('hidden');
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { S.keys[e.code] = false; });
  window.addEventListener('blur', () => { S.keys = {}; });
  function toggleMute() { S.muted = !S.muted; Audio.setMuted(S.muted); try { $('#cinematic-video').muted = S.muted; } catch (e) { /* ignore */ } $('#btn-mute').textContent = S.muted ? '🔇' : '🔊'; }
  $('#btn-mute').onclick = toggleMute;

  // touch joystick
  const stick = $('#stick'), knob = stick.querySelector('.knob'); let touch = { active: false, dx: 0, dy: 0 };
  function stickMove(ev) {
    const r = stick.getBoundingClientRect(), t = ev.touches[0];
    let dx = (t.clientX - (r.left + r.width / 2)) / (r.width / 2), dy = (t.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const len = Math.hypot(dx, dy); if (len > 1) { dx /= len; dy /= len; }
    knob.style.left = `${40 + dx * 40}px`; knob.style.top = `${40 + dy * 40}px`;
    touch.dx = Math.abs(dx) > 0.25 ? dx : 0; touch.dy = Math.abs(dy) > 0.25 ? dy : 0; touch.active = true;
  }
  stick.addEventListener('touchstart', (e) => { e.preventDefault(); stickMove(e); }, { passive: false });
  stick.addEventListener('touchmove', (e) => { e.preventDefault(); stickMove(e); }, { passive: false });
  stick.addEventListener('touchend', () => { touch = { active: false, dx: 0, dy: 0 }; knob.style.left = '40px'; knob.style.top = '40px'; });
  $('#btn-act').addEventListener('touchstart', (e) => { e.preventDefault(); if (!$('#intro').classList.contains('hidden')) $('#intro').classList.add('hidden'); else openPuzzle(); }, { passive: false });

  function pollInput(now) {
    if (!S.game) return;
    let dx = 0, dy = 0;
    const modal = !$('#puzzle').classList.contains('hidden') || !$('#intro').classList.contains('hidden') || !$('#end').classList.contains('hidden');
    if (!modal) {
      if (S.keys.KeyW || S.keys.ArrowUp) dy -= 1;
      if (S.keys.KeyS || S.keys.ArrowDown) dy += 1;
      if (S.keys.KeyA || S.keys.ArrowLeft) dx -= 1;
      if (S.keys.KeyD || S.keys.ArrowRight) dx += 1;
      if (touch.active) { dx = touch.dx; dy = touch.dy; }
    }
    const sig = `${dx.toFixed(2)},${dy.toFixed(2)}`;
    if (sig !== S.lastInput || now - S.lastSent > 400) { S.lastInput = sig; S.lastSent = now; send({ t: 'input', dx, dy }); }
  }

  // ============================================================ rendering
  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(innerWidth * dpr); canvas.height = Math.floor(innerHeight * dpr);
    if (!S.game) return;
    const g = S.game;
    const fit = Math.min(canvas.width / g.W, canvas.height / g.H);
    S.tile = fit >= 13 * dpr ? Math.floor(fit) : Math.floor(20 * dpr);
    buildMapCanvas();
    S.fogCanvas = document.createElement('canvas'); S.fogCanvas.width = canvas.width; S.fogCanvas.height = canvas.height;
  }
  window.addEventListener('resize', resize);

  // Pre-render the static map once per tile size.
  function buildMapCanvas() {
    const g = S.game, s = S.tile;
    const c = document.createElement('canvas'); c.width = g.W * s; c.height = g.H * s;
    const x = c.getContext('2d');
    const rnd = seeded(g.seed), th = theme(), decor = [];
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    for (let ty = 0; ty < g.H; ty++) for (let tx = 0; tx < g.W; tx++) {
      const t = g.tilesArr[ty * g.W + tx], px = tx * s, py = ty * s;
      if (th) {
        const nb = (dx, dy) => { const nx = tx + dx, ny = ty + dy; return nx >= 0 && ny >= 0 && nx < g.W && ny < g.H ? g.tilesArr[ny * g.W + nx] : T.WALL; };
        if (t === T.WALL) {
          const ns = nb(0, -1) !== T.WALL || nb(0, 1) !== T.WALL, ew = nb(-1, 0) !== T.WALL || nb(1, 0) !== T.WALL;
          x.fillStyle = '#07050a'; x.fillRect(px, py, s, s);
          if (ns || ew) { sprite(ns ? 'wall_h' : 'wall_v', px + s / 2, py + s / 2, s, 1, false, 1, x); x.fillStyle = 'rgba(0,0,0,.35)'; x.fillRect(px, py, s, s); }
        } else {
          const key = rnd() < th.accentChance ? pick(th.accent) : pick(th.floor);
          sprite(key, px + s / 2, py + s / 2, s, 1, false, 1, x);
          x.fillStyle = 'rgba(5,3,8,.45)'; x.fillRect(px, py, s, s); // night
          const inner = t === T.FLOOR && [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => nb(dx, dy) === T.FLOOR);
          if (inner && rnd() < th.decorChance) decor.push({ key: pick(th.decor), px: px + s / 2, py: py + s / 2 });
        }
        continue;
      }
      if (t === T.WALL) {
        const edge = [[0, -1], [0, 1], [-1, 0], [1, 0]].some(([dx, dy]) => { const nx = tx + dx, ny = ty + dy; return nx >= 0 && ny >= 0 && nx < g.W && ny < g.H && g.tilesArr[ny * g.W + nx] !== T.WALL; });
        x.fillStyle = edge ? '#2a1d36' : '#120c19'; x.fillRect(px, py, s, s);
        if (edge) { x.fillStyle = 'rgba(0,0,0,.35)'; for (let i = 0; i < 3; i++) x.fillRect(px + rnd() * s, py + rnd() * s, s * 0.25, s * 0.08); x.strokeStyle = 'rgba(90,60,110,.35)'; x.lineWidth = 1; x.strokeRect(px + 0.5, py + 0.5, s - 1, s - 1); }
      } else {
        x.fillStyle = '#15101c'; x.fillRect(px, py, s, s);
        x.fillStyle = `rgba(${40 + rnd() * 20},${30 + rnd() * 12},${50 + rnd() * 18},.6)`; x.fillRect(px + 1, py + 1, s - 2, s - 2);
        if (rnd() < 0.12) { x.fillStyle = 'rgba(0,0,0,.35)'; x.fillRect(px + rnd() * s * 0.7, py + rnd() * s * 0.7, s * 0.3, s * 0.3); }
        if (rnd() < 0.04) { x.fillStyle = 'rgba(110,20,25,.5)'; x.beginPath(); x.arc(px + rnd() * s, py + rnd() * s, s * 0.15, 0, 7); x.fill(); } // old blood
      }
    }
    for (const d of decor) sprite(d.key, d.px, d.py, s, 0.7, false, 0.85, x);
    S.mapCanvas = c;
  }
  function seeded(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  function lerpEntities(dt) {
    const s = S.snap; if (!s) return;
    const k = 1 - Math.exp(-dt * 14);
    for (const p of s.players) {
      let d = S.disp.get(p.id); if (!d || Math.hypot(d.x - p.x, d.y - p.y) > 3) { d = { x: p.x, y: p.y, ph: Math.random() * 7, moving: 0 }; S.disp.set(p.id, d); }
      const ox = d.x, oy = d.y;
      d.x += (p.x - d.x) * k; d.y += (p.y - d.y) * k;
      // "moving" decays so a single stale snapshot does not freeze the walk cycle
      d.moving = Math.hypot(d.x - ox, d.y - oy) > 0.004 ? 1 : Math.max(0, d.moving - dt * 6);
    }
    const seen = new Set();
    for (const m of s.monsters) {
      seen.add(m.id);
      let d = S.mon.get(m.id); if (!d || Math.hypot(d.x - m.x, d.y - m.y) > 3) { d = { x: m.x, y: m.y, ph: Math.random() * 7, moving: 1 }; S.mon.set(m.id, d); }
      const ox = d.x, oy = d.y;
      d.x += (m.x - d.x) * k; d.y += (m.y - d.y) * k;
      d.moving = Math.hypot(d.x - ox, d.y - oy) > 0.004 ? 1 : Math.max(0, d.moving - dt * 6);
    }
    for (const id of S.mon.keys()) if (!seen.has(id)) S.mon.delete(id);
  }

  function loop(now) {
    S.raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - (S.prevTime || now)) / 1000); S.prevTime = now;
    if (!S.game) { S.raf = null; return; }
    pollInput(now);
    lerpEntities(dt);
    render(now / 1000, dt);
  }

  function render(time, dt) {
    const g = S.game, s = S.tile, snap = S.snap;
    const W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (!S.mapCanvas) return;
    // camera
    const mapW = g.W * s, mapH = g.H * s;
    const m = me(); const md = m && S.disp.get(m.id);
    let cx = mapW <= W ? (W - mapW) / 2 : -(md ? md.x * s : mapW / 2) + W / 2;
    let cy = mapH <= H ? (H - mapH) / 2 : -(md ? md.y * s : mapH / 2) + H / 2;
    if (mapW > W) cx = Math.max(W - mapW, Math.min(0, cx));
    if (mapH > H) cy = Math.max(H - mapH, Math.min(0, cy));
    S.cam.x = cx; S.cam.y = cy;
    ctx.save(); ctx.translate(cx, cy);
    ctx.drawImage(S.mapCanvas, 0, 0);

    if (snap) {
      const alive = snap.players.filter((p) => !p.down && !p.esc).map((p) => ({ ...S.disp.get(p.id), vis: p.vis }));
      const visible = (x, y, pad = 0.5) => alive.some((p) => Math.hypot(p.x - x, p.y - y) <= p.vis + pad);
      const eye = S.profile && S.profile.items && S.profile.items.includes('eye');

      // doors
      for (const d of g.doors) {
        const open = snap.doors.includes(d.keyId), px = d.x * s, py = d.y * s;
        const horiz = g.tilesArr[d.y * g.W + d.x - 1] !== T.WALL || g.tilesArr[d.y * g.W + d.x + 1] !== T.WALL; // corridor runs east-west
        const dkey = (horiz ? 'door_v' : 'door_h') + (open ? '_open' : '');
        if (Assets.has(dkey)) {
          sprite(dkey, px + s / 2, py + s / 2, s, 1);
          if (!open) { ctx.shadowColor = KEY_COLORS[d.keyId]; ctx.shadowBlur = s * 0.5; ctx.fillStyle = KEY_COLORS[d.keyId]; ctx.beginPath(); ctx.arc(px + s / 2, py + s / 2, s * 0.12, 0, 7); ctx.fill(); ctx.shadowBlur = 0; }
          continue;
        }
        ctx.fillStyle = open ? '#15101c' : '#3a2416'; ctx.fillRect(px, py, s, s);
        if (!open) {
          ctx.fillStyle = '#5a3a22'; ctx.fillRect(px + s * 0.1, py + s * 0.1, s * 0.8, s * 0.8);
          ctx.fillStyle = KEY_COLORS[d.keyId]; ctx.beginPath(); ctx.arc(px + s / 2, py + s / 2, s * 0.14, 0, 7); ctx.fill();
          ctx.shadowColor = KEY_COLORS[d.keyId]; ctx.shadowBlur = s * 0.5; ctx.fill(); ctx.shadowBlur = 0;
        } else { ctx.strokeStyle = '#5a3a22'; ctx.lineWidth = 2; ctx.strokeRect(px + 1, py + 1, s - 2, s - 2); }
      }
      // exit
      {
        const px = g.exit.x * s, py = g.exit.y * s, open = snap.exitOpen;
        if (Assets.has(open ? 'exit_open' : 'exit_closed')) { ctx.shadowColor = open ? '#5ad17a' : '#a3121a'; ctx.shadowBlur = s * (open ? 1.2 : 0.5); sprite(open ? 'exit_open' : 'exit_closed', px + s / 2, py + s / 2, s, 1.15); ctx.shadowBlur = 0; }
        else {
        ctx.fillStyle = open ? '#0d2a16' : '#2a0a0a'; ctx.fillRect(px, py, s, s);
        ctx.shadowColor = open ? '#5ad17a' : '#a3121a'; ctx.shadowBlur = s * (open ? 1.2 : 0.6) * (0.8 + 0.2 * Math.sin(time * 3));
        ctx.fillStyle = open ? '#5ad17a' : '#7a1016'; ctx.fillRect(px + s * 0.2, py + s * 0.15, s * 0.6, s * 0.7); ctx.shadowBlur = 0;
        if (!open) { ctx.strokeStyle = '#999'; ctx.lineWidth = Math.max(1, s * 0.06); ctx.beginPath(); ctx.moveTo(px + s * 0.15, py + s * 0.3); ctx.lineTo(px + s * 0.85, py + s * 0.7); ctx.moveTo(px + s * 0.85, py + s * 0.3); ctx.lineTo(px + s * 0.15, py + s * 0.7); ctx.stroke(); }
        }
      }
      // altar
      {
        const px = g.altar.x * s + s / 2, py = g.altar.y * s + s / 2, glow = snap.solved ? '#5ad17a' : (snap.got.length === g.fragments ? '#ffd98a' : '#7a3a9a');
        if (Assets.has('altar')) { const lit = snap.solved || snap.got.length === g.fragments; ctx.shadowColor = glow; ctx.shadowBlur = s * 0.6; sprite(lit && Assets.has('altar_lit') ? 'altar_lit' : 'altar', px, py, s, 1.1); ctx.shadowBlur = 0; }
        else {
        ctx.strokeStyle = glow; ctx.lineWidth = Math.max(1, s * 0.06); ctx.shadowColor = glow; ctx.shadowBlur = s * 0.6;
        ctx.beginPath(); ctx.arc(px, py, s * 0.4, 0, 7); ctx.stroke();
        ctx.beginPath(); for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * (4 * Math.PI / 5); const x = px + Math.cos(a) * s * 0.36, y = py + Math.sin(a) * s * 0.36; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.closePath(); ctx.stroke(); ctx.shadowBlur = 0;
        }
      }
      // keys / fragments / relic
      for (const k of snap.keys) if (eye || visible(k.x, k.y)) drawKey(k.x * s, k.y * s, s, KEY_COLORS[k.id], time, !visible(k.x, k.y));
      for (const f of snap.frags) if (eye || visible(f.x, f.y)) drawFragment(f.x * s, f.y * s, s, time, !visible(f.x, f.y));
      if (snap.item && visible(snap.item.x, snap.item.y)) drawRelic(snap.item.x * s, snap.item.y * s, s, time, snap.item.type);
      // monsters
      for (const mo of snap.monsters) { if (!mo.v) continue; const d = S.mon.get(mo.id); if (d) drawMonster(mo, d.x * s, d.y * s, s, time, d.ph, d.moving > 0); }
      // players
      for (const p of snap.players) { if (p.esc) continue; const d = S.disp.get(p.id); if (d) drawPlayer(p, d.x * s, d.y * s, s, time, d); }
      // floaters
      for (const f of S.floaters) { f.t += dt; ctx.globalAlpha = Math.max(0, 1 - f.t / 1.4); ctx.fillStyle = f.color; ctx.font = `bold ${Math.round(s * 0.7)}px Georgia`; ctx.textAlign = 'center'; ctx.fillText(f.text, f.x * s, f.y * s - f.t * s * 1.2); ctx.globalAlpha = 1; }
      S.floaters = S.floaters.filter((f) => f.t < 1.4);

      ctx.restore();
      // fog of war: the map is faintly visible everywhere, entities only in the light
      drawFog(alive, s, time);
      // audio listener + heartbeat
      if (md) {
        Audio.setListener({ x: md.x, y: md.y });
        let nearest = null;
        if (m && !m.down && !m.esc) for (const mo of snap.monsters) { const dd = Math.hypot(mo.x - md.x, mo.y - md.y); if (!mo.q && (nearest === null || dd < nearest)) nearest = dd; }
        Audio.tick(nearest);
      }
      // down overlay
      if (m && m.down) { ctx.fillStyle = `rgba(120,0,10,${0.25 + 0.1 * Math.sin(time * 2)})`; ctx.fillRect(0, 0, W, H); }
    } else ctx.restore();
  }

  function drawFog(alive, s, time) {
    const f = S.fogCanvas; if (!f) return;
    const fx = f.getContext('2d');
    fx.setTransform(1, 0, 0, 1, 0, 0); fx.globalCompositeOperation = 'source-over';
    fx.clearRect(0, 0, f.width, f.height);
    fx.fillStyle = 'rgba(0,0,0,0.86)'; fx.fillRect(0, 0, f.width, f.height);
    fx.globalCompositeOperation = 'destination-out';
    for (const p of alive) {
      const flicker = 1 + 0.025 * Math.sin(time * 11 + p.x) + 0.015 * Math.sin(time * 23.7);
      const r = p.vis * s * flicker, x = p.x * s + S.cam.x, y = p.y * s + S.cam.y;
      const grad = fx.createRadialGradient(x, y, r * 0.35, x, y, r);
      grad.addColorStop(0, 'rgba(0,0,0,1)'); grad.addColorStop(0.7, 'rgba(0,0,0,0.85)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
      fx.fillStyle = grad; fx.beginPath(); fx.arc(x, y, r, 0, 7); fx.fill();
    }
    ctx.drawImage(f, 0, 0);
    // warm lantern tint in the light (clipped to the map so it never bleeds into the void)
    ctx.save(); ctx.beginPath(); ctx.rect(S.cam.x, S.cam.y, S.game.W * s, S.game.H * s); ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of alive) {
      const r = p.vis * s * 0.9, x = p.x * s + S.cam.x, y = p.y * s + S.cam.y;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, 'rgba(255,150,60,0.16)'); grad.addColorStop(1, 'rgba(255,150,60,0)');
      ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.restore();
  }

  // ---- sprites (procedural) ----
  function drawKey(x, y, s, color, time, faint) {
    ctx.save(); ctx.translate(x, y + Math.sin(time * 3 + x) * s * 0.06); ctx.globalAlpha = faint ? 0.35 : 1;
    const kk = ['key0', 'key1', 'key2', 'key3'][Math.min(3, KEY_COLORS.indexOf(color))] || 'key0';
    if (Assets.has(kk)) { ctx.shadowColor = color; ctx.shadowBlur = s * 0.7; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, 0, s * 0.32, 0, 7); ctx.globalAlpha *= 0.45; ctx.fill(); ctx.globalAlpha /= 0.45; sprite(kk, 0, 0, s, 0.75); ctx.restore(); return; }
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = Math.max(1.5, s * 0.1); ctx.shadowColor = color; ctx.shadowBlur = s * 0.6;
    ctx.beginPath(); ctx.arc(-s * 0.15, 0, s * 0.14, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(s * 0.3, 0); ctx.lineTo(s * 0.3, s * 0.12); ctx.moveTo(s * 0.18, 0); ctx.lineTo(s * 0.18, s * 0.1); ctx.stroke();
    ctx.restore();
  }
  function drawFragment(x, y, s, time, faint) {
    ctx.save(); ctx.translate(x, y); ctx.globalAlpha = faint ? 0.35 : 1;
    if (Assets.has('fragment')) { ctx.shadowColor = '#c56bff'; ctx.shadowBlur = s * (0.5 + 0.3 * Math.sin(time * 4 + y)); sprite('fragment', 0, 0, s, 0.8); ctx.restore(); return; }
    ctx.fillStyle = '#3a3040'; ctx.fillRect(-s * 0.26, -s * 0.3, s * 0.52, s * 0.6);
    ctx.strokeStyle = '#ffd98a'; ctx.lineWidth = 1; ctx.strokeRect(-s * 0.26, -s * 0.3, s * 0.52, s * 0.6);
    ctx.fillStyle = '#ffd98a'; ctx.shadowColor = '#ffb347'; ctx.shadowBlur = s * (0.5 + 0.3 * Math.sin(time * 4 + y));
    ctx.font = `${Math.round(s * 0.5)}px serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('ᛟ', 0, 0);
    ctx.restore();
  }
  function drawRelic(x, y, s, time, type) {
    ctx.save(); ctx.translate(x, y);
    const rk = Assets.has('relic_' + type) ? 'relic_' + type : Assets.has('chest') ? 'chest' : null;
    if (rk) { ctx.shadowColor = '#ffd700'; ctx.shadowBlur = s * (0.8 + 0.4 * Math.sin(time * 5)); sprite(rk, 0, 0, s, 0.85); ctx.restore(); return; }
    if (Assets.has('relic')) { ctx.shadowColor = '#ffd700'; ctx.shadowBlur = s * (0.8 + 0.4 * Math.sin(time * 5)); sprite('relic', 0, 0, s, 0.9); ctx.restore(); return; }
    ctx.shadowColor = '#ffd700'; ctx.shadowBlur = s * (0.8 + 0.4 * Math.sin(time * 5));
    ctx.fillStyle = '#5a3a1a'; ctx.fillRect(-s * 0.32, -s * 0.18, s * 0.64, s * 0.4);
    ctx.fillStyle = '#d4a017'; ctx.fillRect(-s * 0.32, -s * 0.22, s * 0.64, s * 0.1); ctx.fillRect(-s * 0.06, -s * 0.1, s * 0.12, s * 0.16);
    ctx.restore();
  }
  function drawPlayer(p, x, y, s, time, d) {
    const color = S.playerColor.get(p.id) || '#fff';
    const moving = d && d.moving > 0, frame = moving ? walkFrame(time, d.ph) : 0;
    const bob = moving ? Math.abs(Math.sin(time * WALK_FPS * Math.PI + (d.ph || 0))) * s * 0.06 : 0;
    ctx.save(); ctx.translate(x, y);
    if (p.down) {
      ctx.globalAlpha = 0.8; ctx.fillStyle = '#444'; ctx.beginPath(); ctx.arc(0, 0, s * 0.3, 0, 7); ctx.fill();
      ctx.strokeStyle = '#ff3b3b'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-s * 0.15, -s * 0.15); ctx.lineTo(s * 0.15, s * 0.15); ctx.moveTo(s * 0.15, -s * 0.15); ctx.lineTo(-s * 0.15, s * 0.15); ctx.stroke();
      if (p.rv > 0) { ctx.strokeStyle = '#5ad17a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, s * 0.45, -Math.PI / 2, -Math.PI / 2 + p.rv * Math.PI * 2); ctx.stroke(); }
    } else {
      if (p.inv) { ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, s * 0.42 + Math.sin(time * 10) * 2, 0, 7); ctx.stroke(); }
      ctx.shadowColor = color; ctx.shadowBlur = s * 0.4;
      const idx = S.room ? Math.max(0, S.room.players.findIndex((r) => r.id === p.id)) : 0;
      const pk = dirKey('player' + (idx % 3), p.fx, p.fy, frame);
      if (pk) { ctx.strokeStyle = color; ctx.globalAlpha = 0.55; ctx.lineWidth = Math.max(2, s * 0.07); ctx.beginPath(); ctx.ellipse(0, s * 0.3, s * 0.36, s * 0.16, 0, 0, 7); ctx.stroke(); ctx.globalAlpha = 1; ctx.shadowBlur = 0; sprite(pk, 0, -s * 0.25 - bob, s, 1.5); }
      else {
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, 0, s * 0.3, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
      ctx.fillStyle = '#1a1020'; ctx.beginPath(); ctx.arc(p.fx * s * 0.12 - s * 0.07, p.fy * s * 0.12 - s * 0.03, s * 0.05, 0, 7); ctx.arc(p.fx * s * 0.12 + s * 0.07, p.fy * s * 0.12 - s * 0.03, s * 0.05, 0, 7); ctx.fill();
      }
    }
    ctx.globalAlpha = 1; ctx.fillStyle = p.id === S.id ? '#fff' : color; ctx.font = `${Math.max(9, Math.round(s * 0.42))}px Georgia`; ctx.textAlign = 'center'; ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
    ctx.fillText(nameOf(p.id), 0, -s * 0.95);
    ctx.restore();
  }
  function drawMonster(mo, x, y, s, time, ph, moving) {
    ctx.save(); ctx.translate(x, y);
    const bob = Math.sin(time * 6 + ph) * s * 0.05;
    const still = mo.t === 'crawler' && mo.s === 'wait';
    const frame = moving && !still ? walkFrame(time + (mo.s === 'dash' || mo.s === 'chase' ? time : 0), ph) : 0;
    const skey = dirKey(mo.t, mo.dx, mo.dy, frame);
    if (skey) {
      let size = { zombie: 1.5, ghost: 1.7, crawler: 1.5, imp: 1.15, demon: 2.2 }[mo.t] || 1.4;
      if (mo.t === 'crawler' && mo.s === 'dash') size = 1.8;
      if (mo.t === 'demon') { ctx.shadowColor = mo.s === 'chase' ? '#ff2a2a' : '#6a0a0a'; ctx.shadowBlur = s * (mo.s === 'chase' ? 1.4 : 0.7); }
      if (mo.t === 'ghost') { ctx.shadowColor = '#9fe8ff'; ctx.shadowBlur = s * 0.8; }
      sprite(skey, 0, bob - s * 0.2, s, size, false, mo.t === 'ghost' ? 0.6 + 0.25 * Math.sin(time * 4 + ph) : 1);
      ctx.restore(); return;
    }
    switch (mo.t) {
      case 'zombie': {
        ctx.fillStyle = '#4f6b3a'; ctx.beginPath(); ctx.ellipse(0, bob, s * 0.34, s * 0.4, 0, 0, 7); ctx.fill();
        ctx.strokeStyle = '#3a4f2a'; ctx.lineWidth = Math.max(2, s * 0.12); ctx.beginPath(); ctx.moveTo(-s * 0.2, bob); ctx.lineTo(-s * 0.2 + mo.dx * s * 0.45, bob + mo.dy * s * 0.45 + s * 0.05); ctx.moveTo(s * 0.2, bob); ctx.lineTo(s * 0.2 + mo.dx * s * 0.45, bob + mo.dy * s * 0.45 - s * 0.05); ctx.stroke();
        ctx.fillStyle = '#e8e8c8'; ctx.beginPath(); ctx.arc(-s * 0.12, bob - s * 0.1, s * 0.07, 0, 7); ctx.arc(s * 0.12, bob - s * 0.1, s * 0.07, 0, 7); ctx.fill();
        ctx.fillStyle = '#8a1a1a'; ctx.fillRect(-s * 0.14, bob + s * 0.12, s * 0.28, s * 0.06);
        break;
      }
      case 'ghost': {
        ctx.globalAlpha = 0.55 + 0.25 * Math.sin(time * 4 + ph);
        ctx.shadowColor = '#bfe8ff'; ctx.shadowBlur = s * 0.8;
        ctx.fillStyle = '#dff4ff'; ctx.beginPath(); ctx.arc(0, bob - s * 0.05, s * 0.34, Math.PI, 0);
        for (let i = 0; i < 5; i++) ctx.lineTo(s * 0.34 - i * s * 0.17, bob + s * 0.35 + (i % 2 ? -s * 0.1 : 0) + Math.sin(time * 8 + i) * s * 0.03);
        ctx.closePath(); ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = '#0a0a14'; ctx.beginPath(); ctx.ellipse(-s * 0.12, bob - s * 0.05, s * 0.07, s * 0.11, 0, 0, 7); ctx.ellipse(s * 0.12, bob - s * 0.05, s * 0.07, s * 0.11, 0, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.ellipse(0, bob + s * 0.15, s * 0.07, s * 0.1, 0, 0, 7); ctx.fill();
        break;
      }
      case 'crawler': {
        const dash = mo.s === 'dash', wig = Math.sin(time * (dash ? 40 : 14) + ph) * s * 0.12;
        ctx.strokeStyle = '#5a1420'; ctx.lineWidth = Math.max(1.5, s * 0.07);
        for (let i = -1; i <= 1; i++) { ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-s * 0.45, i * s * 0.3 + wig); ctx.moveTo(0, 0); ctx.lineTo(s * 0.45, i * s * 0.3 - wig); ctx.stroke(); }
        ctx.fillStyle = dash ? '#b3121a' : '#7a1a28'; ctx.beginPath(); ctx.ellipse(0, 0, s * (dash ? 0.4 : 0.3), s * 0.22, mo.dx ? 0 : Math.PI / 2, 0, 7); ctx.fill();
        ctx.fillStyle = '#ffd34d'; ctx.beginPath(); ctx.arc(mo.dx * s * 0.2 - s * 0.06, mo.dy * s * 0.2, s * 0.045, 0, 7); ctx.arc(mo.dx * s * 0.2 + s * 0.06, mo.dy * s * 0.2, s * 0.045, 0, 7); ctx.fill();
        break;
      }
      case 'imp': {
        ctx.fillStyle = '#e0561c'; ctx.beginPath(); ctx.arc(0, bob, s * 0.25, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.moveTo(-s * 0.18, bob - s * 0.15); ctx.lineTo(-s * 0.26, bob - s * 0.42); ctx.lineTo(-s * 0.06, bob - s * 0.22); ctx.moveTo(s * 0.18, bob - s * 0.15); ctx.lineTo(s * 0.26, bob - s * 0.42); ctx.lineTo(s * 0.06, bob - s * 0.22); ctx.fill();
        ctx.fillStyle = '#fff04d'; ctx.beginPath(); ctx.arc(-s * 0.09, bob - s * 0.04, s * 0.05, 0, 7); ctx.arc(s * 0.09, bob - s * 0.04, s * 0.05, 0, 7); ctx.fill();
        ctx.strokeStyle = '#2a0a05'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(0, bob + s * 0.05, s * 0.12, 0.2, Math.PI - 0.2); ctx.stroke();
        break;
      }
      case 'demon': {
        const chase = mo.s === 'chase';
        ctx.shadowColor = chase ? '#ff2a2a' : '#6a0a0a'; ctx.shadowBlur = s * (chase ? 1.4 : 0.7);
        ctx.fillStyle = '#3a0608'; ctx.beginPath(); ctx.ellipse(0, bob, s * 0.46, s * 0.5, 0, 0, 7); ctx.fill();
        ctx.fillStyle = '#1a0304'; ctx.beginPath(); ctx.moveTo(-s * 0.3, bob - s * 0.3); ctx.lineTo(-s * 0.5, bob - s * 0.75); ctx.lineTo(-s * 0.1, bob - s * 0.4); ctx.moveTo(s * 0.3, bob - s * 0.3); ctx.lineTo(s * 0.5, bob - s * 0.75); ctx.lineTo(s * 0.1, bob - s * 0.4); ctx.fill();
        ctx.shadowBlur = s * 0.8; ctx.shadowColor = '#ff3030';
        ctx.fillStyle = chase ? '#fff' : '#ff3030'; ctx.beginPath(); ctx.arc(-s * 0.15, bob - s * 0.1, s * 0.08, 0, 7); ctx.arc(s * 0.15, bob - s * 0.1, s * 0.08, 0, 7); ctx.fill();
        ctx.shadowBlur = 0; ctx.fillStyle = '#ffb3b3'; for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(i * s * 0.09 - s * 0.03, bob + s * 0.15); ctx.lineTo(i * s * 0.09 + s * 0.03, bob + s * 0.15); ctx.lineTo(i * s * 0.09, bob + s * 0.3); ctx.fill(); }
        break;
      }
    }
    ctx.restore();
  }

  // ============================================================ jump scare
  function shake(ms) { const g = $('#game'); g.classList.add('shake'); clearTimeout(shake.t); shake.t = setTimeout(() => g.classList.remove('shake'), ms); }
  function jumpScare(reason, type) {
    const el = $('#scare'), c = $('#scare-canvas');
    c.width = innerWidth; c.height = innerHeight;
    const faces = Assets.img.scares || [];
    const byType = faces.filter((f) => f.type === type);
    const face = (byType.length ? byType : faces)[Math.floor(Math.random() * Math.max(1, (byType.length ? byType : faces).length))];
    if (face) {
      const x = c.getContext('2d');
      const sc = Math.min(c.width / face.sw, c.height / face.sh) * 1.15, w = face.sw * sc, h = face.sh * sc;
      x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
      const jx = (Math.random() - 0.5) * 40, jy = (Math.random() - 0.5) * 40;
      for (const [ox, alpha] of [[-10, 0.45], [10, 0.45], [0, 1]]) { x.globalAlpha = alpha; x.drawImage(face.img, face.sx, face.sy, face.sw, face.sh, (c.width - w) / 2 + ox + jx, (c.height - h) / 2 + jy, w, h); }
      x.globalAlpha = 1; x.fillStyle = 'rgba(0,0,0,.3)'; for (let y = 0; y < c.height; y += 4) x.fillRect(0, y, c.width, 2);
      x.fillStyle = 'rgba(160,0,0,.18)'; x.fillRect(0, 0, c.width, c.height);
    } else drawScareFace(c.getContext('2d'), c.width, c.height, type);
    el.classList.remove('hidden'); shake(700); Audio.scream();
    if (navigator.vibrate) navigator.vibrate([120, 40, 200]);
    clearTimeout(jumpScare.t);
    jumpScare.t = setTimeout(() => { el.classList.add('hidden'); $('#game').classList.add('redflash'); setTimeout(() => $('#game').classList.remove('redflash'), 650); }, 550 + Math.random() * 250);
  }
  function drawScareFace(x, w, h, type) {
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.32;
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    // chromatic ghosting
    for (const [ox, oy, col] of [[-6, 0, 'rgba(255,0,0,.5)'], [6, 0, 'rgba(0,255,255,.35)'], [0, 0, null]]) {
      x.save(); x.translate(cx + ox, cy + oy);
      x.fillStyle = col || (type === 'demon' ? '#3a0608' : type === 'ghost' ? '#dfe8ef' : '#cfc4b8');
      x.beginPath(); x.ellipse(0, 0, r * 0.78, r, 0, 0, 7); x.fill();
      if (!col) {
        // rot
        x.fillStyle = 'rgba(60,70,40,.5)'; for (let i = 0; i < 14; i++) { x.beginPath(); x.arc((Math.random() - 0.5) * r * 1.3, (Math.random() - 0.5) * r * 1.7, r * (0.03 + Math.random() * 0.08), 0, 7); x.fill(); }
        // eyes
        x.fillStyle = '#000'; x.beginPath(); x.ellipse(-r * 0.3, -r * 0.2, r * 0.19, r * 0.28, 0.2, 0, 7); x.ellipse(r * 0.3, -r * 0.2, r * 0.19, r * 0.28, -0.2, 0, 7); x.fill();
        x.fillStyle = type === 'demon' ? '#ff2020' : '#f3f3f3'; x.beginPath(); x.arc(-r * 0.3 + (Math.random() - 0.5) * r * 0.1, -r * 0.2, r * 0.05, 0, 7); x.arc(r * 0.3 + (Math.random() - 0.5) * r * 0.1, -r * 0.2, r * 0.05, 0, 7); x.fill();
        // veins
        x.strokeStyle = 'rgba(160,20,20,.7)'; x.lineWidth = 2;
        for (let i = 0; i < 12; i++) { x.beginPath(); let px = (Math.random() - 0.5) * r, py = (Math.random() - 0.5) * r * 1.4; x.moveTo(px, py); for (let j = 0; j < 4; j++) { px += (Math.random() - 0.5) * r * 0.3; py += (Math.random() - 0.5) * r * 0.3; x.lineTo(px, py); } x.stroke(); }
        // mouth
        x.fillStyle = '#0a0000'; x.beginPath(); x.ellipse(0, r * 0.45, r * 0.38, r * 0.3 + Math.random() * r * 0.1, 0, 0, 7); x.fill();
        x.fillStyle = '#e8e2c8'; for (let i = -4; i <= 4; i++) { x.beginPath(); x.moveTo(i * r * 0.085 - r * 0.035, r * 0.2); x.lineTo(i * r * 0.085 + r * 0.035, r * 0.2); x.lineTo(i * r * 0.085, r * 0.2 + r * (0.12 + Math.random() * 0.1)); x.fill(); }
      }
      x.restore();
    }
    // scanlines
    x.fillStyle = 'rgba(0,0,0,.35)'; for (let y = 0; y < h; y += 4) x.fillRect(0, y, w, 2);
    x.fillStyle = 'rgba(160,0,0,.25)'; x.fillRect(0, 0, w, h);
  }

  connect();
})();
