// Nightfall audio engine. Every sound is synthesized with the WebAudio API:
// an evolving ambient score, wind, positional monster voices, phantom sounds
// that fake a monster's approach, heartbeat by proximity, and jump scares.
(function () {
  'use strict';

  const A = {
    ctx: null, master: null, music: null, sfx: null, muted: false, ready: false,
    intensity: 0, heartbeat: { next: 0 }, musicTimer: 0, ambientTimer: 0, convolver: null,
  };

  function init() {
    if (A.ready) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    A.ctx = new Ctx();
    A.master = A.ctx.createGain(); A.master.gain.value = A.muted ? 0 : 1.0; A.master.connect(A.ctx.destination);
    A.music = A.ctx.createGain(); A.music.gain.value = 0.85; A.music.connect(A.master);
    A.sfx = A.ctx.createGain(); A.sfx.gain.value = 1; A.sfx.connect(A.master);
    // cheap reverb for ghosts and the altar
    A.convolver = A.ctx.createConvolver();
    A.convolver.buffer = impulse(2.2, 2.5);
    const revGain = A.ctx.createGain(); revGain.gain.value = 0.5;
    A.convolver.connect(revGain).connect(A.master);
    A.ready = true;
    if (window.NightAssets && window.NightAssets.decodeAll) window.NightAssets.decodeAll(A.ctx);
  }
  // Play an external sample (from assets/manifest.json) if one is loaded.
  function playSample(key, pos, radius, dest) {
    const buf = window.NightAssets && window.NightAssets.sample(key);
    if (!buf || !A.ready) return false;
    const src = A.ctx.createBufferSource(); src.buffer = buf;
    const out = spatial(dest || A.sfx, pos, radius || 12);
    if (pos && out.vol < 0.02) return true;
    src.connect(out.node); src.start();
    return true;
  }
  function resume() { if (A.ctx && A.ctx.state === 'suspended') A.ctx.resume(); }

  function impulse(seconds, decay) {
    const rate = A.ctx.sampleRate, len = rate * seconds, buf = A.ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return buf;
  }
  function noiseBuffer(seconds) {
    const rate = A.ctx.sampleRate, len = Math.floor(rate * seconds), buf = A.ctx.createBuffer(1, len, rate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  const now = () => A.ctx.currentTime;

  // ---- building blocks ----------------------------------------------------
  function env(gain, t, a, peak, d, sustain = 0) {
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + a);
    gain.gain.exponentialRampToValueAtTime(Math.max(sustain, 0.0001), t + a + d);
  }
  // Spatial output: pan by horizontal offset, attenuate by distance (tiles).
  function spatial(dest, pos, radius = 12) {
    const g = A.ctx.createGain();
    let vol = 1, pan = 0;
    if (pos && A.listener) {
      const dx = pos.x - A.listener.x, dy = pos.y - A.listener.y, d = Math.hypot(dx, dy);
      vol = Math.pow(Math.max(0, 1 - d / radius), 1.4);
      pan = Math.max(-1, Math.min(1, dx / 7));
    }
    g.gain.value = vol;
    if (A.ctx.createStereoPanner) { const p = A.ctx.createStereoPanner(); p.pan.value = pan; g.connect(p).connect(dest); } else g.connect(dest);
    return { node: g, vol };
  }
  function osc(type, freq, t0, t1, dest) {
    const o = A.ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t0); o.connect(dest); o.start(t0); o.stop(t1 + 0.05); return o;
  }
  function noise(t0, t1, dest, filterType, freq, q = 1) {
    const s = A.ctx.createBufferSource(); s.buffer = noiseBuffer(Math.min(4, t1 - t0 + 0.1)); s.loop = true;
    const f = A.ctx.createBiquadFilter(); f.type = filterType; f.frequency.value = freq; f.Q.value = q;
    s.connect(f).connect(dest); s.start(t0); s.stop(t1 + 0.05); return { src: s, filter: f };
  }
  function distortion(amount) {
    const ws = A.ctx.createWaveShaper(), n = 256, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; curve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x)); }
    ws.curve = curve; return ws;
  }

  // ---- ambient music -------------------------------------------------------
  const SCALE = [0, 1, 3, 5, 6, 8, 10]; // phrygian-ish, very unhappy
  let drone = null;
  function startMusic() {
    if (!A.ready || drone) return;
    const t = now();

    const bus = A.ctx.createGain(); bus.gain.value = 0; bus.connect(A.music);
    bus.gain.linearRampToValueAtTime(1, t + 4);
    const lp = A.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380; lp.connect(bus);
    const voices = [];
    for (const [f, type] of [[55, 'sawtooth'], [55.4, 'sawtooth'], [82.4, 'triangle'], [27.5, 'sine']]) {
      const o = A.ctx.createOscillator(); o.type = type; o.frequency.value = f;
      const g = A.ctx.createGain(); g.gain.value = type === 'sine' ? 0.6 : 0.22;
      o.connect(g).connect(lp); o.start(); voices.push(o);
    }
    const lfo = A.ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = A.ctx.createGain(); lfoG.gain.value = 90; lfo.connect(lfoG).connect(lp.frequency); lfo.start();
    // wind
    const wind = noise(t, t + 1e6, bus, 'bandpass', 500, 0.6);
    wind.src.stop(t + 36000);
    const wg = A.ctx.createGain(); wg.gain.value = 0.32; wind.filter.disconnect(); wind.filter.connect(wg).connect(bus);
    const wlfo = A.ctx.createOscillator(); wlfo.frequency.value = 0.11; const wlg = A.ctx.createGain(); wlg.gain.value = 350; wlfo.connect(wlg).connect(wind.filter.frequency); wlfo.start();
    drone = { bus, lp, voices, lfo, wlfo, wind, wg, root: 55 };
    // the recorded score, when present, loops on top of the synth bed
    const sample = window.NightAssets && window.NightAssets.sample('music');
    if (sample) {
      const sg = A.ctx.createGain(); sg.gain.value = 0.7; sg.connect(bus);
      const src = A.ctx.createBufferSource(); src.buffer = sample; src.loop = true; src.connect(sg); src.start();
      drone.src = src; drone.sample = true;
    }
    A.musicTimer = t + 3;
  }
  function stopMusic() {
    if (!drone) return;
    const t = now();
    drone.bus.gain.cancelScheduledValues(t); drone.bus.gain.setValueAtTime(drone.bus.gain.value, t); drone.bus.gain.linearRampToValueAtTime(0, t + 1.5);
    const d = drone; drone = null;
    setTimeout(() => { try { if (d.src) d.src.stop(); d.voices.forEach((o) => o.stop()); d.lfo.stop(); d.wlfo.stop(); d.wind.src.stop(); } catch (e) { /* already stopped */ } }, 1800);
  }
  // Sparse, mournful pad notes; more and higher as intensity rises.
  function musicTick() {
    if (!drone) return;
    const t = now();
    if (t < A.musicTimer) return;
    const inten = A.intensity;
    A.musicTimer = t + (inten > 0.6 ? 1.2 + Math.random() * 1.5 : 3 + Math.random() * 5);
    drone.lp.frequency.setTargetAtTime(380 + inten * 900, t, 1.5);
    if (drone.sample && inten < 0.5 && Math.random() < 0.6) return; // let the score breathe
    const deg = SCALE[Math.floor(Math.random() * SCALE.length)];
    const octave = Math.random() < 0.3 + inten * 0.4 ? 2 : 1;
    const f = drone.root * Math.pow(2, deg / 12) * octave * 2;
    const g = A.ctx.createGain(); g.connect(A.convolver); g.connect(A.music);
    env(g, t, 1.2, 0.11 + inten * 0.08, 3.5 + Math.random() * 2);
    const o = osc(Math.random() < 0.5 ? 'sine' : 'triangle', f, t, t + 7, g);
    o.detune.setValueAtTime(-8 + Math.random() * 16, t);
    if (inten > 0.5 && Math.random() < 0.5) { // dissonant partner
      const g2 = A.ctx.createGain(); g2.connect(A.music); env(g2, t + 0.3, 0.8, 0.06, 3);
      osc('sine', f * Math.pow(2, 1 / 12), t + 0.3, t + 6, g2);
    }
    if (inten > 0.75 && Math.random() < 0.6) pulse(t); // low war-drum pulse when danger is near
  }
  function pulse(t) {
    const g = A.ctx.createGain(); g.connect(A.music); env(g, t, 0.01, 0.7, 0.35);
    const o = osc('sine', 48, t, t + 0.5, g); o.frequency.exponentialRampToValueAtTime(30, t + 0.4);
  }

  // ---- random ambient scares (client side, non positional) ------------------
  function ambientTick() {
    if (!drone) return;
    const t = now();
    if (t < A.ambientTimer) return;
    A.ambientTimer = t + 14 + Math.random() * 26;
    const pick = Math.random();
    const fakePos = A.listener ? { x: A.listener.x + (Math.random() - 0.5) * 12, y: A.listener.y + (Math.random() - 0.5) * 12 } : null;
    if (pick < 0.3) whisper(fakePos);
    else if (pick < 0.55) knock(fakePos);
    else if (pick < 0.75) creak(fakePos);
    else if (pick < 0.9) childLaugh(fakePos);
    else breath();
  }
  function whisper(pos) {
    if (playSample('whisper', pos, 14)) return;
    const t = now(); const sp = spatial(A.sfx, pos, 14);
    for (let i = 0; i < 5; i++) {
      const t0 = t + i * (0.18 + Math.random() * 0.12);
      const g = A.ctx.createGain(); g.connect(sp.node); env(g, t0, 0.04, 0.22, 0.14 + Math.random() * 0.1);
      noise(t0, t0 + 0.3, g, 'bandpass', 1200 + Math.random() * 2200, 6);
    }
  }
  function knock(pos) {
    if (playSample('knock', pos, 16)) return;
    const t = now(); const sp = spatial(A.sfx, pos, 16);
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const t0 = t + i * 0.42;
      const g = A.ctx.createGain(); g.connect(sp.node); env(g, t0, 0.005, 0.7, 0.18);
      noise(t0, t0 + 0.2, g, 'lowpass', 180, 1);
      const o = osc('sine', 90, t0, t0 + 0.2, g); o.frequency.exponentialRampToValueAtTime(45, t0 + 0.15);
    }
  }
  function creak(pos) {
    if (playSample('creak', pos, 14)) return;
    const t = now(); const sp = spatial(A.sfx, pos, 14);
    const g = A.ctx.createGain(); g.connect(sp.node); env(g, t, 0.3, 0.12, 1.4);
    const o = osc('sawtooth', 160, t, t + 1.9, g);
    o.frequency.linearRampToValueAtTime(90 + Math.random() * 60, t + 1.6);
    const f = A.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 600; f.Q.value = 8; o.disconnect(); o.connect(f).connect(g);
  }
  function childLaugh(pos) {
    const t = now(); const sp = spatial(A.sfx, pos, 15);
    const g = A.ctx.createGain(); g.connect(A.convolver); g.connect(sp.node);
    for (let i = 0; i < 6; i++) {
      const t0 = t + i * 0.13; const gg = A.ctx.createGain(); gg.connect(g); env(gg, t0, 0.02, 0.08, 0.1);
      osc('triangle', 700 + Math.random() * 300 - i * 40, t0, t0 + 0.15, gg);
    }
  }
  function breath() {
    const t = now(); const g = A.ctx.createGain(); g.connect(A.sfx);
    for (let i = 0; i < 2; i++) { const t0 = t + i * 1.1; env(g, t0, 0.45, 0.16, 0.5); noise(t0, t0 + 1.1, g, 'bandpass', 500 + i * 200, 0.7); }
  }

  // ---- monster voices --------------------------------------------------------
  const VOICE = {
    zombie(pos, opts) {
      const t = now(); const sp = spatial(A.sfx, pos); if (sp.vol < 0.02) return;
      const g = A.ctx.createGain(); g.connect(sp.node); env(g, t, 0.25, 0.5, 1.3);
      const o = osc('sawtooth', 110, t, t + 1.8, g); o.frequency.linearRampToValueAtTime(70, t + 1.4);
      const f = A.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500; o.disconnect(); o.connect(f).connect(g);
      const v = A.ctx.createOscillator(); v.frequency.value = 6; const vg = A.ctx.createGain(); vg.gain.value = 9; v.connect(vg).connect(o.frequency); v.start(t); v.stop(t + 1.8);
    },
    ghost(pos, opts) {
      const t = now(); const sp = spatial(A.sfx, pos, 14); if (sp.vol < 0.02) return;
      const g = A.ctx.createGain(); g.connect(A.convolver); g.connect(sp.node); env(g, t, 0.6, 0.18, 2.2);
      const o = osc('sine', 640, t, t + 3, g); o.frequency.exponentialRampToValueAtTime(320, t + 2.6);
      const v = A.ctx.createOscillator(); v.frequency.value = 5; const vg = A.ctx.createGain(); vg.gain.value = 18; v.connect(vg).connect(o.frequency); v.start(t); v.stop(t + 3);
      const ng = A.ctx.createGain(); ng.connect(sp.node); env(ng, t, 0.8, 0.07, 1.8); noise(t, t + 2.8, ng, 'bandpass', 900, 3);
    },
    crawler(pos, opts) {
      const t = now(); const sp = spatial(A.sfx, pos, 10); if (sp.vol < 0.02) return;
      const n = opts && opts.dash ? 16 : 9;
      for (let i = 0; i < n; i++) {
        const t0 = t + i * (opts && opts.dash ? 0.035 : 0.06) + Math.random() * 0.02;
        const g = A.ctx.createGain(); g.connect(sp.node); env(g, t0, 0.003, 0.35, 0.04);
        noise(t0, t0 + 0.06, g, 'highpass', 2500 + Math.random() * 2000, 2);
      }
      if (opts && opts.dash) { const g = A.ctx.createGain(); g.connect(sp.node); env(g, t, 0.05, 0.3, 0.5); noise(t, t + 0.6, g, 'bandpass', 1800, 1.5); }
    },
    imp(pos, opts) {
      const t = now(); const sp = spatial(A.sfx, pos, 12); if (sp.vol < 0.02) return;
      const g = A.ctx.createGain(); g.connect(sp.node);
      const base = 500 + Math.random() * 200;
      for (let i = 0; i < 7; i++) {
        const t0 = t + i * 0.09; const gg = A.ctx.createGain(); gg.connect(g); env(gg, t0, 0.01, 0.2, 0.07);
        osc('square', base * (1 + (i % 2) * 0.25) + i * 30, t0, t0 + 0.1, gg);
      }
    },
    demon(pos, opts) {
      const t = now(); const sp = spatial(A.sfx, pos, 16); if (sp.vol < 0.02) return;
      const roar = opts && opts.roar;
      const g = A.ctx.createGain(); g.connect(sp.node); env(g, t, roar ? 0.08 : 0.4, roar ? 0.9 : 0.45, roar ? 1.6 : 1.4);
      const dist = distortion(roar ? 60 : 25); dist.connect(g);
      const o = osc('sawtooth', roar ? 95 : 60, t, t + 2, dist); o.frequency.linearRampToValueAtTime(roar ? 55 : 45, t + 1.6);
      const o2 = osc('square', roar ? 48 : 30, t, t + 2, dist); o2.frequency.linearRampToValueAtTime(28, t + 1.8);
      const f = A.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = roar ? 900 : 400; dist.disconnect(); dist.connect(f).connect(g);
      if (roar) { const ng = A.ctx.createGain(); ng.connect(sp.node); env(ng, t, 0.05, 0.5, 1.2); noise(t, t + 1.4, ng, 'lowpass', 700, 1); }
    },
  };
  function monster(type, pos, opts) {
    if (!A.ready || !VOICE[type]) return;
    opts = opts || {};
    const key = type + (opts.dash ? '_dash' : opts.roar ? '_roar' : '');
    if (playSample(key, pos, 13) || (key !== type && playSample(type, pos, 13))) return;
    VOICE[type](pos, opts);
  }
  // Phantom: the same voice, slightly muffled, from where no monster is.
  function phantom(type, pos) {
    if (!A.ready) return;
    monster(type, pos, { phantom: true });
    const t = now(); const g = A.ctx.createGain(); g.connect(A.sfx); env(g, t, 0.3, 0.05, 1.5); noise(t, t + 1.8, g, 'lowpass', 300, 1);
  }

  // ---- heartbeat by proximity -----------------------------------------------
  function heartbeatTick(nearest) {
    if (!A.ready) return;
    const t = now();
    const danger = nearest == null ? 0 : Math.max(0, Math.min(1, 1 - nearest / 9));
    A.intensity += (danger - A.intensity) * 0.06;
    if (danger < 0.12 || t < A.heartbeat.next) return;
    const period = 1.1 - danger * 0.65;
    A.heartbeat.next = t + period;
    const vol = 0.25 + danger * 0.6;
    for (const [dt, f, v] of [[0, 55, vol], [0.17, 48, vol * 0.7]]) {
      const g = A.ctx.createGain(); g.connect(A.sfx); env(g, t + dt, 0.01, v, 0.16);
      const o = osc('sine', f, t + dt, t + dt + 0.3, g); o.frequency.exponentialRampToValueAtTime(30, t + dt + 0.2);
    }
  }

  // ---- stingers --------------------------------------------------------------
  function scream() {
    if (!A.ready || playSample('scream')) return;
    const t = now();
    const g = A.ctx.createGain(); g.connect(A.sfx); env(g, t, 0.01, 1.2, 0.9);
    const dist = distortion(80); dist.connect(g);
    const o = osc('sawtooth', 1400, t, t + 1.1, dist); o.frequency.exponentialRampToValueAtTime(420, t + 0.9);
    const o2 = osc('square', 1890, t, t + 1.1, dist); o2.frequency.exponentialRampToValueAtTime(380, t + 0.9);
    const ng = A.ctx.createGain(); ng.connect(A.sfx); env(ng, t, 0.005, 0.9, 0.7); noise(t, t + 0.9, ng, 'highpass', 900, 0.5);
    const bg = A.ctx.createGain(); bg.connect(A.sfx); env(bg, t, 0.01, 0.8, 0.5); const b = osc('sine', 70, t, t + 0.6, bg); b.frequency.exponentialRampToValueAtTime(25, t + 0.5);
  }
  function pickup(kind) {
    if (!A.ready || playSample(kind)) return;
    const t = now(); const g = A.ctx.createGain(); g.connect(A.convolver); g.connect(A.sfx);
    if (kind === 'key') { for (let i = 0; i < 3; i++) { const gg = A.ctx.createGain(); gg.connect(g); env(gg, t + i * 0.07, 0.005, 0.25, 0.25); osc('triangle', 1800 + Math.random() * 600, t + i * 0.07, t + i * 0.07 + 0.3, gg); } }
    else if (kind === 'fragment') { for (let i = 0; i < 3; i++) { const gg = A.ctx.createGain(); gg.connect(g); env(gg, t + i * 0.12, 0.02, 0.22, 0.6); osc('sine', [392, 466, 622][i], t + i * 0.12, t + i * 0.12 + 0.7, gg); } }
    else { for (let i = 0; i < 5; i++) { const gg = A.ctx.createGain(); gg.connect(g); env(gg, t + i * 0.1, 0.02, 0.2, 0.9); osc('sine', 523 * Math.pow(2, [0, 3, 7, 10, 12][i] / 12), t + i * 0.1, t + i * 0.1 + 1, gg); } }
  }
  function door(pos) {
    if (!A.ready || playSample('door', pos, 18)) return;
    const t = now(); const sp = spatial(A.sfx, pos, 18);
    const g = A.ctx.createGain(); g.connect(sp.node); env(g, t, 0.05, 0.4, 1.1);
    const o = osc('sawtooth', 120, t, t + 1.3, g); o.frequency.linearRampToValueAtTime(190, t + 1.0);
    const f = A.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 500; f.Q.value = 6; o.disconnect(); o.connect(f).connect(g);
    const tg = A.ctx.createGain(); tg.connect(sp.node); env(tg, t + 1.05, 0.005, 0.6, 0.2); noise(t + 1.05, t + 1.3, tg, 'lowpass', 250, 1);
  }
  // close call: a bright rising two-note chime, higher with the streak
  function closeCall(streak) {
    if (!A.ready || playSample('closecall')) return;
    const t = now(); const base = 880 * Math.pow(2, Math.min(4, streak - 1) / 12);
    for (let i = 0; i < 2; i++) { const g = A.ctx.createGain(); g.connect(A.convolver); g.connect(A.sfx); env(g, t + i * 0.09, 0.005, 0.35, 0.35); osc('triangle', base * (i ? 1.5 : 1), t + i * 0.09, t + i * 0.09 + 0.4, g); }
    const h = A.ctx.createGain(); h.connect(A.sfx); env(h, t, 0.005, 0.5, 0.12); const o = osc('sine', 60, t, t + 0.2, h); o.frequency.exponentialRampToValueAtTime(30, t + 0.15);
  }
  // tension events
  function eventSound(type) {
    if (!A.ready || playSample('event_' + type)) return;
    const t = now();
    if (type === 'blackout') { // the lamps die: electric buzz then a thud
      const g = A.ctx.createGain(); g.connect(A.sfx); env(g, t, 0.02, 0.35, 0.6); const o = osc('sawtooth', 120, t, t + 0.7, g); o.frequency.exponentialRampToValueAtTime(30, t + 0.6);
      const ng = A.ctx.createGain(); ng.connect(A.sfx); env(ng, t, 0.01, 0.3, 0.25); noise(t, t + 0.3, ng, 'bandpass', 3000, 2);
      const b = A.ctx.createGain(); b.connect(A.sfx); env(b, t + 0.5, 0.01, 0.8, 0.5); const o2 = osc('sine', 70, t + 0.5, t + 1.1, b); o2.frequency.exponentialRampToValueAtTime(25, t + 1.0);
    } else if (type === 'hunt') { bell(4); const g = A.ctx.createGain(); g.connect(A.sfx); env(g, t, 0.3, 0.3, 3); noise(t, t + 3.3, g, 'lowpass', 300, 1); }
    else if (type === 'slam') { // iron door slam with a long rumble
      const g = A.ctx.createGain(); g.connect(A.sfx); env(g, t, 0.003, 1, 0.5); noise(t, t + 0.6, g, 'lowpass', 500, 1);
      const o = osc('sine', 90, t, t + 0.8, g); o.frequency.exponentialRampToValueAtTime(28, t + 0.6);
      const r = A.ctx.createGain(); r.connect(A.convolver); r.connect(A.sfx); env(r, t + 0.05, 0.1, 0.25, 1.8); noise(t, t + 2, r, 'lowpass', 160, 1);
    }
  }
  function flare(pos) {
    if (!A.ready || playSample('flare', pos, 20)) return;
    const t = now(); const sp = spatial(A.sfx, pos, 20);
    const g = A.ctx.createGain(); g.connect(sp.node); env(g, t, 0.01, 0.5, 0.9); noise(t, t + 1, g, 'highpass', 1500, 0.7);
    const o = osc('sine', 300, t, t + 0.5, g); o.frequency.exponentialRampToValueAtTime(1200, t + 0.3);
  }
  function hintWhisper() { if (!A.ready || playSample('hint')) return; whisper(null); }
  function bell(count = 3) {
    if (!A.ready || playSample('bell')) return;
    const t = now();
    for (let i = 0; i < count; i++) {
      const t0 = t + i * 1.3; const g = A.ctx.createGain(); g.connect(A.convolver); g.connect(A.sfx); env(g, t0, 0.01, 0.5, 2.5);
      osc('sine', 220, t0, t0 + 3, g); const g2 = A.ctx.createGain(); g2.connect(g); g2.gain.value = 0.4; osc('sine', 220 * 2.76, t0, t0 + 2, g2);
    }
  }
  function caught() {
    if (!A.ready || playSample('caught')) return;
    const t = now(); const g = A.ctx.createGain(); g.connect(A.sfx); env(g, t, 0.005, 1, 0.6);
    const o = osc('sine', 120, t, t + 0.7, g); o.frequency.exponentialRampToValueAtTime(20, t + 0.6);
    const ng = A.ctx.createGain(); ng.connect(A.sfx); env(ng, t, 0.005, 0.6, 0.4); noise(t, t + 0.5, ng, 'lowpass', 400, 1);
  }
  function wrong() {
    if (!A.ready || playSample('wrong')) return;
    const t = now(); const g = A.ctx.createGain(); g.connect(A.convolver); g.connect(A.sfx); env(g, t, 0.05, 0.4, 1.5);
    const o = osc('sawtooth', 220, t, t + 1.6, g); o.frequency.exponentialRampToValueAtTime(55, t + 1.4);
    const o2 = osc('sawtooth', 233, t, t + 1.6, g); o2.frequency.exponentialRampToValueAtTime(58, t + 1.4);
  }
  function victory() {
    if (!A.ready || playSample('victory')) return;
    const t = now();
    [0, 3, 7, 12, 7, 12, 15].forEach((semi, i) => { const g = A.ctx.createGain(); g.connect(A.convolver); g.connect(A.sfx); env(g, t + i * 0.18, 0.02, 0.25, 1.6); osc('triangle', 261.6 * Math.pow(2, semi / 12), t + i * 0.18, t + i * 0.18 + 1.8, g); });
  }
  function defeat() {
    if (!A.ready || playSample('defeat')) return;
    const t = now();
    [12, 7, 3, 0].forEach((semi, i) => { const g = A.ctx.createGain(); g.connect(A.convolver); g.connect(A.sfx); env(g, t + i * 0.6, 0.05, 0.3, 2.2); osc('sawtooth', 110 * Math.pow(2, semi / 12), t + i * 0.6, t + i * 0.6 + 2.5, g); });
  }
  function setMuted(m) { A.muted = m; if (A.master) A.master.gain.setTargetAtTime(m ? 0 : 1.0, now(), 0.05); }
  function setListener(pos) { A.listener = pos; }
  function tick(nearestMonsterDist) { if (!A.ready) return; heartbeatTick(nearestMonsterDist); musicTick(); ambientTick(); }

  window.NightAudio = { init, resume, startMusic, stopMusic, tick, monster, phantom, scream, pickup, door, bell, caught, wrong, victory, defeat, setMuted, setListener, whisper, knock, creak, closeCall, eventSound, flare, hintWhisper, get ready() { return A.ready; }, get ctx() { return A.ctx; } };
})();
