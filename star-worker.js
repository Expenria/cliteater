/* =========================================================
   star-worker.js  (v4)
   Runs the entire star simulation off the main thread.
========================================================= */
'use strict';

let canvas = null;
let ctx = null;
let W = 1, H = 1, DPR = 1;

let cfg = {
  global:  { maxStars: 500, triggerEnabled: false },
  base:    { enabled: true, initialDelay: 800, spawnInterval: 400, reproChance: 3, tickMs: 500,
             lifespan: 5, color: '#ffffff', shape: 'square', size: 3, fadeIn: 0.4, fadeOut: 0.5,
             flashOut: true, randomRotation: false },
  spawned: { enabled: true, reproChance: 5, tickMs: 200, lifespan: 3, color: '#a5b4fc', shape: 'square',
             size: 3, fadeIn: 0.4, fadeOut: 0.5, flashOut: true, randomRotation: false },
  effects: [],
  activeEffectId: null
};
let activeEffect = null;

const MAX_POOL = 200000;
const pool = new Array(MAX_POOL);
const poolFree = new Int32Array(MAX_POOL);
let poolFreeTop = MAX_POOL;
const liveIdx = new Int32Array(MAX_POOL);
let liveTail = 0;
let liveCount = 0, liveBaseCount = 0, liveSpawnedCount = 0;

let baseSpawnArmed = false;
let nextBaseSpawnAt = 0;

const imageCache = new Map();
const pathCache = new Map();
const imagePool = [];
let unusedPool = [];

let bubbleMask = null;

function resetPool() {
  for (let i = 0; i < MAX_POOL; i++) {
    pool[i] = { alive:false, x:0, y:0, isBase:false, birth:0, deathStart:0, nextTick:0, imgUrl:null, rotation:0 };
    poolFree[i] = MAX_POOL - 1 - i;
  }
  poolFreeTop = MAX_POOL;
  liveCount = 0; liveBaseCount = 0; liveSpawnedCount = 0;
  liveTail = 0;
}
resetPool();

function allocSlot() { return poolFreeTop > 0 ? poolFree[--poolFreeTop] : -1; }
function addLive(i) { liveIdx[liveTail++] = i; }

let raf = false;
let lastFrameAt = 0;
let lastCountMsgAt = 0;
const COUNT_MSG_INTERVAL = 100;

self.onmessage = function (ev) {
  const m = ev.data || {};
  switch (m.type) {
    case 'canvas':
      canvas = m.canvas;
      W = m.w; H = m.h; DPR = m.dpr;
      canvas.width = W * DPR;
      canvas.height = H * DPR;
      ctx = canvas.getContext('2d');
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      postMsg({ type: 'canvas-ready', W, H, DPR, cw: canvas.width, ch: canvas.height });
      if (!raf) { raf = true; lastFrameAt = performance.now(); requestAnimationFrame(loop); }
      break;

    case 'init':
      if (m.cfg) cfg = m.cfg;
      activeEffect = pickActiveEffect(cfg);
      reconfigureForEffect();
      resetSim();
      break;

    case 'cfg':
      if (m.cfg) cfg = m.cfg;
      activeEffect = pickActiveEffect(cfg);
      reconfigureForEffect();
      break;

    case 'chars':
      if (activeEffect && activeEffect.type === 'bubble' && m.chars) {
        activeEffect.chars = m.chars;
        recomputeBubbleMask();
      }
      break;

    case 'image-pool':
      if (activeEffect && activeEffect.type === 'images') {
        activeEffect.exceptions = m.exceptions || {};
        activeEffect.defaultSize = m.defaultSize || 60;
        loadImagePool(m.urls || []);
      }
      break;

    case 'reset': resetSim(); break;

    case 'resize':
      W = m.w; H = m.h; DPR = m.dpr;
      canvas.width = W * DPR;
      canvas.height = H * DPR;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      if (activeEffect && activeEffect.type === 'bubble') recomputeBubbleMask();
      break;

    case 'shutdown': raf = false; break;
  }
};

function postMsg(obj) { self.postMessage(obj); }

function pickActiveEffect(c) {
  if (!c.effects || !c.effects.length) return null;
  return c.effects.find(e => e.id === c.activeEffectId) || c.effects[0] || null;
}

function reconfigureForEffect() {
  if (!activeEffect) { bubbleMask = null; return; }
  if (activeEffect.type === 'bubble') recomputeBubbleMask();
  else bubbleMask = null;
}

function resetSim() {
  for (let i = 0; i < MAX_POOL; i++) {
    if (pool[i].alive) { pool[i].alive = false; pool[i].imgUrl = null; poolFree[poolFreeTop++] = i; }
  }
  liveCount = 0; liveBaseCount = 0; liveSpawnedCount = 0;
  liveTail = 0;
  baseSpawnArmed = false;
  nextBaseSpawnAt = performance.now() + (cfg.base.initialDelay || 0);
}

let maskCanvas = null, maskCtx = null;

function recomputeBubbleMask() {
  if (!activeEffect || activeEffect.type !== 'bubble' || !activeEffect.chars || !activeEffect.chars.length) {
    bubbleMask = null; return;
  }
  const scale = 0.5;
  const cw = Math.max(1, Math.floor(W * scale));
  const ch = Math.max(1, Math.floor(H * scale));
  if (!maskCanvas) { maskCanvas = new OffscreenCanvas(cw, ch); maskCtx = maskCanvas.getContext('2d'); }
  else { maskCanvas.width = cw; maskCanvas.height = ch; maskCtx = maskCanvas.getContext('2d'); }
  maskCtx.clearRect(0, 0, cw, ch);
  maskCtx.fillStyle = '#fff';
  maskCtx.textAlign = 'center';
  maskCtx.textBaseline = 'middle';
  for (const c of activeEffect.chars) {
    if (!c.char) continue;
    maskCtx.save();
    maskCtx.translate(c.x * scale, c.y * scale);
    if (c.rotation) maskCtx.rotate(c.rotation * Math.PI / 180);
    maskCtx.font = `900 ${Math.max(1, c.size * scale)}px 'Arial Black', Arial, sans-serif`;
    maskCtx.fillText(c.char, 0, 0);
    maskCtx.restore();
  }
  let imgData;
  try { imgData = maskCtx.getImageData(0, 0, cw, ch); }
  catch (e) { postMsg({ type: 'error', message: 'getImageData failed: ' + e.message }); bubbleMask = null; return; }
  const data = new Uint8Array(cw * ch);
  const src = imgData.data;
  let minX = cw, minY = ch, maxX = 0, maxY = 0, found = false;
  const points = [];
  const step = 4;
  for (let y = 0; y < ch; y += step) {
    for (let x = 0; x < cw; x += step) {
      if (src[(y * cw + x) * 4 + 3] > 128) {
        data[y * cw + x] = 1;
        points.push((x / scale) | 0, (y / scale) | 0);
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
        found = true;
      }
    }
  }
  bubbleMask = found ? {
    data, w: cw, h: ch, scale,
    bounds: { minX: minX / scale, minY: minY / scale, maxX: maxX / scale, maxY: maxY / scale },
    points: new Int32Array(points)
  } : null;
}

function isInMask(x, y) {
  if (!bubbleMask) return false;
  const mx = (x * bubbleMask.scale) | 0;
  const my = (y * bubbleMask.scale) | 0;
  if (mx < 0 || my < 0 || mx >= bubbleMask.w || my >= bubbleMask.h) return false;
  return bubbleMask.data[my * bubbleMask.w + mx] === 1;
}

let spawnPointX = 0, spawnPointY = 0;

function getSpawnPoint(effect) {
  if (effect && effect.type === 'bubble' && bubbleMask) {
    const threshold = Number(effect.minStarsForBubble) || 0;
    const over = liveCount >= threshold;
    if (over) {
      const b = bubbleMask.bounds;
      const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
      for (let t = 0; t < 40; t++) {
        const x = b.minX + Math.random() * bw;
        const y = b.minY + Math.random() * bh;
        if (isInMask(x, y)) { spawnPointX = x; spawnPointY = y; return; }
      }
      const pts = bubbleMask.points;
      if (pts.length >= 2) {
        const idx = (Math.random() * (pts.length / 2)) | 0;
        spawnPointX = pts[idx * 2]; spawnPointY = pts[idx * 2 + 1];
        return;
      }
    } else if (effect.beforeThresholdMode === 'avoid') {
      for (let t = 0; t < 80; t++) {
        const x = Math.random() * W;
        const y = Math.random() * H;
        if (!isInMask(x, y)) { spawnPointX = x; spawnPointY = y; return; }
      }
    }
  }
  spawnPointX = Math.random() * W;
  spawnPointY = Math.random() * H;
}

async function loadImagePool(urls) {
  imagePool.length = 0;
  unusedPool = [];
  if (!urls.length) {
    postMsg({ type: 'image-status', loaded: 0, error: 'No images found.' });
    return;
  }
  for (const url of urls) {
    try {
      if (!imageCache.has(url)) {
        const res = await fetch(url, { cache: 'force-cache' });
        if (!res.ok) continue;
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob);
        imageCache.set(url, bmp);
      }
      imagePool.push(url);
    } catch (e) { /* skip broken */ }
  }
  if (!imagePool.length) {
    postMsg({ type: 'image-status', loaded: 0, error: 'Could not load any images.' });
  } else {
    postMsg({ type: 'image-status', loaded: imagePool.length, error: null });
  }
}

function pickNextImage() {
  if (!imagePool.length) return null;
  if (unusedPool.length === 0) {
    unusedPool = imagePool.slice();
    for (let i = unusedPool.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = unusedPool[i]; unusedPool[i] = unusedPool[j]; unusedPool[j] = t;
    }
  }
  return unusedPool.pop();
}

function spawnStar(isBase) {
  const i = allocSlot();
  if (i < 0) return;
  const s = pool[i];
  const type = isBase ? cfg.base : cfg.spawned;
  const now = performance.now();
  getSpawnPoint(activeEffect);
  s.alive = true;
  s.x = spawnPointX;
  s.y = spawnPointY;
  s.isBase = isBase;
  s.birth = now;
  s.deathStart = now + type.lifespan * 1000;
  s.nextTick = now + type.tickMs;
  s.rotation = type.randomRotation ? Math.random() * 360 : 0;
  if (activeEffect && activeEffect.type === 'images' && imagePool.length) {
    const threshold = Number(activeEffect.minStarsForImages) || 0;
    s.imgUrl = (liveCount >= threshold) ? pickNextImage() : null;
  } else {
    s.imgUrl = null;
  }
  addLive(i);
  liveCount++;
  if (isBase) liveBaseCount++; else liveSpawnedCount++;
}

function killStar(i) {
  const s = pool[i];
  if (!s.alive) return;
  s.alive = false;
  if (s.isBase) liveBaseCount--; else liveSpawnedCount--;
  liveCount--;
  s.imgUrl = null;
  poolFree[poolFreeTop++] = i;
}

function loop() {
  if (!raf || !ctx) return;
  const now = performance.now();

  const hasSpawned = liveSpawnedCount > 0;
  if (hasSpawned) {
    baseSpawnArmed = false;
  } else {
    if (!baseSpawnArmed) {
      baseSpawnArmed = true;
      nextBaseSpawnAt = now + (liveBaseCount > 0 ? 0 : (cfg.base.initialDelay || 0));
    }
    if (cfg.base.enabled && liveCount < cfg.global.maxStars && now >= nextBaseSpawnAt) {
      spawnStar(true);
      nextBaseSpawnAt = now + cfg.base.spawnInterval;
    }
  }

  const tickEnd = liveTail;
  for (let k = 0; k < tickEnd; k++) {
    const i = liveIdx[k];
    const s = pool[i];
    if (!s.alive) continue;
    const type = s.isBase ? cfg.base : cfg.spawned;
    if (now >= s.deathStart + type.fadeOut * 1000) { killStar(i); continue; }
    if (now < s.deathStart && now >= s.nextTick) {
      s.nextTick = now + type.tickMs;
      if (cfg.spawned.enabled && liveCount < cfg.global.maxStars) {
        if (Math.random() * 100 < type.reproChance) spawnStar(false);
      }
    }
  }

  let w = 0;
  for (let k = 0; k < liveTail; k++) {
    const i = liveIdx[k];
    if (pool[i].alive) liveIdx[w++] = i;
  }
  liveTail = w;

  if (cfg.global.triggerEnabled && liveCount >= cfg.global.maxStars) {
    const c = (activeEffect && activeEffect.flashColor) ? activeEffect.flashColor : '#ffffff';
    postMsg({ type: 'flash', color: c });
    resetSim();
  }

  renderStars(now);

  if (now - lastCountMsgAt > COUNT_MSG_INTERVAL) {
    lastCountMsgAt = now;
    postMsg({ type: 'count', total: liveCount, base: liveBaseCount, spawned: liveSpawnedCount });
  }

  requestAnimationFrame(loop);
}

const CULL_PAD = 32;

function renderStars(now) {
  ctx.clearRect(0, 0, W, H);

  if (activeEffect && activeEffect.type === 'bubble' && activeEffect.showOutline && (activeEffect.outlineOpacity ?? 0.5) > 0 && activeEffect.chars) {
    ctx.save();
    ctx.strokeStyle = activeEffect.outlineColor;
    ctx.globalAlpha = Math.min(1, Math.max(0, activeEffect.outlineOpacity ?? 0.5));
    ctx.lineWidth = activeEffect.outlineWidth;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of activeEffect.chars) {
      if (!c.char) continue;
      ctx.save();
      ctx.translate(c.x, c.y);
      if (c.rotation) ctx.rotate(c.rotation * Math.PI / 180);
      ctx.font = `900 ${c.size}px 'Arial Black', Arial, sans-serif`;
      ctx.strokeText(c.char, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  pathCache.clear();

  for (let k = 0; k < liveTail; k++) {
    const i = liveIdx[k];
    const s = pool[i];
    if (!s.alive) continue;
    if (s.x < -CULL_PAD || s.x > W + CULL_PAD || s.y < -CULL_PAD || s.y > H + CULL_PAD) continue;

    const type = s.isBase ? cfg.base : cfg.spawned;
    const fi = Math.max(1, type.fadeIn * 1000);
    const fo = Math.max(1, type.fadeOut * 1000);
    let alpha = 1, size = type.size;
    if (now < s.birth + fi) alpha = (now - s.birth) / fi;
    else if (now >= s.deathStart) {
      const t = (now - s.deathStart) / fo;
      if (type.flashOut) { alpha = (1 - t) * (1 - t); size = type.size * (1 + t * 2.5); }
      else alpha = 1 - t;
    }
    if (alpha <= 0) continue;

    if (s.imgUrl) {
      const bmp = imageCache.get(s.imgUrl);
      if (bmp) {
        const sizePx = (activeEffect && activeEffect.exceptions && activeEffect.exceptions[s.imgUrl]) ||
                       (activeEffect ? activeEffect.defaultSize : 60);
        const aspect = bmp.width / bmp.height;
        let dw, dh;
        if (aspect > 1) { dw = sizePx; dh = sizePx / aspect; } else { dw = sizePx * aspect; dh = sizePx; }
        ctx.globalAlpha = Math.min(1, alpha);
        ctx.save();
        ctx.translate(s.x, s.y);
        if (s.rotation) ctx.rotate(s.rotation * Math.PI / 180);
        ctx.drawImage(bmp, -dw / 2, -dh / 2, dw, dh);
        ctx.restore();
        continue;
      }
    }

    const bucketSize = size < 8 ? Math.round(size) : Math.round(size / 2) * 2;
    const alphaBucket = alpha > 0.85 ? 3 : alpha > 0.5 ? 2 : 1;
    const key = type.color + '|' + type.shape + '|' + bucketSize + '|' + alphaBucket;
    let batch = pathCache.get(key);
    if (!batch) {
      batch = { path: new Path2D(), alpha: alpha > 0.85 ? 1 : (alpha > 0.5 ? 0.75 : 0.4),
                color: type.color, shape: type.shape, size: bucketSize, stars: [] };
      pathCache.set(key, batch);
    }
    batch.stars.push(s.x, s.y, s.rotation || 0);
  }

  for (const batch of pathCache.values()) {
    const p = batch.path;
    const sz = batch.size;
    const pts = batch.stars;
    for (let j = 0; j < pts.length; j += 3) {
      addShapePath(p, batch.shape, sz, pts[j], pts[j + 1], pts[j + 2]);
    }
    ctx.globalAlpha = batch.alpha;
    ctx.fillStyle = batch.color;
    ctx.fill(p);
  }

  ctx.globalAlpha = 1;
}

function addShapePath(p, shape, s, x, y, rotation) {
  const h = s / 2;
  if (shape === 'circle') {
    p.moveTo(x + h, y);
    p.arc(x, y, h, 0, Math.PI * 2);
    return;
  }
  const rad = rotation * Math.PI / 180;
  const c = Math.cos(rad), sn = Math.sin(rad);
  const tp = (px, py) => [px * c - py * sn + x, px * sn + py * c + y];
  switch (shape) {
    case 'square': {
      const [a, b] = tp(-h, -h), [c2, d] = tp(h, -h), [e, f] = tp(h, h), [g, k] = tp(-h, h);
      p.moveTo(a, b); p.lineTo(c2, d); p.lineTo(e, f); p.lineTo(g, k); p.closePath();
      return;
    }
    case 'triangle': {
      const [a, b] = tp(0, -s * 0.62);
      const [c2, d] = tp(s * 0.58, s * 0.42);
      const [e, f] = tp(-s * 0.58, s * 0.42);
      p.moveTo(a, b); p.lineTo(c2, d); p.lineTo(e, f); p.closePath();
      return;
    }
    case 'diamond': {
      const [a, b] = tp(0, -s * 0.65);
      const [c2, d] = tp(s * 0.65, 0);
      const [e, f] = tp(0, s * 0.65);
      const [g, k] = tp(-s * 0.65, 0);
      p.moveTo(a, b); p.lineTo(c2, d); p.lineTo(e, f); p.lineTo(g, k); p.closePath();
      return;
    }
    case 'star': {
      for (let i = 0; i < 10; i++) {
        const r = (i % 2 === 0) ? s * 0.72 : s * 0.30;
        const a = -Math.PI / 2 + i * Math.PI / 5;
        const [X, Y] = tp(Math.cos(a) * r, Math.sin(a) * r);
        if (i === 0) p.moveTo(X, Y); else p.lineTo(X, Y);
      }
      p.closePath();
      return;
    }
    case 'plus': {
      const t = Math.max(1, s * 0.34);
      let [a, b] = tp(-t / 2, -h), [c2, d] = tp(t / 2, -h), [e, f] = tp(t / 2, h), [g, k] = tp(-t / 2, h);
      p.moveTo(a, b); p.lineTo(c2, d); p.lineTo(e, f); p.lineTo(g, k); p.closePath();
      [a, b] = tp(-h, -t / 2); [c2, d] = tp(h, -t / 2); [e, f] = tp(h, t / 2); [g, k] = tp(-h, t / 2);
      p.moveTo(a, b); p.lineTo(c2, d); p.lineTo(e, f); p.lineTo(g, k); p.closePath();
      return;
    }
    default: {
      const [a, b] = tp(-h, -h), [c2, d] = tp(h, -h), [e, f] = tp(h, h), [g, k] = tp(-h, h);
      p.moveTo(a, b); p.lineTo(c2, d); p.lineTo(e, f); p.lineTo(g, k); p.closePath();
    }
  }
}
