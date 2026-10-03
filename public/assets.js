// Asset loader. Nightfall ships with procedural art and synthesized audio so
// it runs with zero files; real art comes from atlases listed in
// assets/manifest.json. A sprite entry names an atlas cell (col,row) and the
// loader cuts it out, trimming transparent padding so every sprite is tight.
// Anything missing keeps its procedural fallback.
(function () {
  'use strict';
  const Assets = { img: {}, snd: {}, atlas: {}, manifest: null, loaded: false, decoded: false, audioFiles: {} };

  function loadImage(src) {
    return new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => { console.warn('[assets] missing', src); res(null); }; im.src = src; });
  }

  // Alpha bounding box of a region of an image (for trimming atlas cells).
  function trimBounds(im, sx, sy, sw, sh) {
    const c = document.createElement('canvas'); c.width = sw; c.height = sh;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(im, sx, sy, sw, sh, 0, 0, sw, sh);
    const d = x.getImageData(0, 0, sw, sh).data;
    let x0 = sw, y0 = sh, x1 = -1, y1 = -1;
    for (let y = 0; y < sh; y++) for (let xx = 0; xx < sw; xx++) {
      if (d[(y * sw + xx) * 4 + 3] > 24) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return { sx, sy, sw, sh };
    return { sx: sx + x0, sy: sy + y0, sw: x1 - x0 + 1, sh: y1 - y0 + 1 };
  }

  function cell(atlas, col, row) {
    const im = atlas.img, cw = im.width / atlas.cols, ch = im.height / atlas.rows;
    return { sx: Math.round(col * cw), sy: Math.round(row * ch), sw: Math.round((col + 1) * cw) - Math.round(col * cw), sh: Math.round((row + 1) * ch) - Math.round(row * ch) };
  }

  Assets.load = async function () {
    let manifest;
    try { manifest = await (await fetch('assets/manifest.json', { cache: 'no-cache' })).json(); } catch { manifest = {}; }
    Assets.manifest = manifest;
    await Promise.all(Object.entries(manifest.atlases || {}).map(async ([name, a]) => {
      const img = await loadImage('assets/' + a.file);
      if (img) Assets.atlas[name] = { img, cols: a.cols, rows: a.rows };
    }));
    const resolve = (entry) => {
      if (typeof entry === 'string') return null; // handled below (standalone file)
      const atlas = Assets.atlas[entry.atlas]; if (!atlas) return null;
      const c = cell(atlas, entry.col, entry.row);
      const r = entry.trim === false ? c : trimBounds(atlas.img, c.sx, c.sy, c.sw, c.sh);
      return { img: atlas.img, ...r, width: r.sw, height: r.sh, meta: entry };
    };
    const files = [];
    for (const [key, entry] of Object.entries(manifest.sprites || {})) {
      if (typeof entry === 'string') files.push(loadImage('assets/' + entry).then((im) => { if (im) Assets.img[key] = { img: im, sx: 0, sy: 0, sw: im.width, sh: im.height, width: im.width, height: im.height, meta: {} }; }));
      else { const s = resolve(entry); if (s) Assets.img[key] = s; }
    }
    Assets.img.scares = [];
    for (const [key, entry] of Object.entries(manifest.scares || {})) {
      if (typeof entry === 'string') files.push(loadImage('assets/' + entry).then((im) => { if (im) Assets.img.scares.push({ img: im, sx: 0, sy: 0, sw: im.width, sh: im.height, type: key }); }));
      else { const s = resolve(entry); if (s) Assets.img.scares.push({ ...s, type: entry.type || key }); }
    }
    await Promise.all(files);
    Assets.audioFiles = manifest.audio || {};
    Assets.themes = manifest.themes || {};
    Assets.loaded = true;
  };

  // Audio decoding needs an AudioContext (user gesture); called lazily by the audio engine.
  Assets.decodeAll = async function (ctx) {
    if (!ctx || Assets.decoded) return;
    Assets.decoded = true;
    await Promise.all(Object.entries(Assets.audioFiles).map(async ([key, file]) => {
      try { const buf = await (await fetch('assets/' + file)).arrayBuffer(); Assets.snd[key] = await ctx.decodeAudioData(buf); }
      catch (e) { console.warn('[assets] could not load audio', file, e.message); }
    }));
  };
  Assets.has = (key) => !!Assets.img[key];
  Assets.get = (key) => Assets.img[key] || null;
  Assets.sample = (key) => Assets.snd[key] || null;
  window.NightAssets = Assets;
})();
