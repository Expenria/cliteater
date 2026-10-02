/* =========================================================
   star-worker.js
   Runs the entire star simulation off the main thread.
   - Owns its own copy of `cfg` and its own `stars` pool.
   - Receives OffscreenCanvas via transfer.
   - Communicates with the main page via postMessage only.
   - Zero allocations in the hot loop. Batched Path2D draws.
========================================================= */

'use strict';

/* ---------------------------------------------------------
   State
--------------------------------------------------------- */
let canvas = null;
let ctx = null;
let W = 1, H = 1, DPR = 1;

// Worker-side config. Populated by 'init'.
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

// Star pool. Pre-allocated, never reallocated.
// Each slot: { alive, x, y, isBase, birth, deathStart, nextTick, imgUrl, rotation }
const MAX_POOL = 200000;                 // hard ceiling; bumped by maxStars if higher
let pool = new Array(MAX_POOL);
let poolFree = new Array(MAX_POOL);      // stack of free indices
let poolFreeTop = MAX_POOL;              // next free slot
let liveCount = 0;
let liveBaseCount = 0;
let liveSpawnedCount = 0;

// Fast iteration list of live indices (rebuilt each frame from the pool's live flag).
// Actually simpler: we keep a flat liveIdx array maintained on spawn/kill.
const liveIdx = new Int32Array(MAX_POOL);
let liveHead = 0, liveTail = 0;

// Spawn state
let baseSpawnArmed = false;
let nextBaseSpawnAt = 0;

// Image cache: url -> ImageBitmap
const imageCache = new Map();

// Render batching: shape+color+size-bucket -> Path2D for this frame
// We build these fresh each frame, but reuse the same keys to avoid map churn.
const pathCache = new Map();
const KEY_SEP = '|';

// Effects working memory
let bubbleMask = null;   // { data: Uint8Array, w, h, scale, bounds, points }
let imagePool = [];
let unusedPool = [];

/* ---------------------------------------------------------
   Init / pool
--------------------------------------------------------- */
function resetPool() {
  for (let i = 0; i < MAX_POOL; i++) {
    pool[i] = { alive: false, x: 0, y: 0, isBase: false, birth: 0, deathStart: 0,
                nextTick: 0, imgUrl: null, rotation: 0 };
    poolFree[i] = MAX_POOL - 1 - i;
  }
  poolFreeTop = MAX_POOL;
  liveCount = 0; liveBaseCount = 0; liveSpawnedCount = 0;
  liveHead = 0; liveTail = 0;
}
resetPool();

function allocSlot() {
  if (poolFreeTop <= 0) return -1;
  return poolFree[--poolFreeTop];
}
function freeSlot(i) {
  const s = pool[i];
  s.alive = false;
  s.imgUrl = null;
  poolFree[poolFreeTop++] = i;
}
function addLive(i) {
  if (liveTail >= MAX_POOL) liveTail = 0;   // wrap (shouldn't happen; liveCount < MAX_POOL)
  liveIdx[liveTail++] = i;
}
function removeLive(i) {
  // We don't remove in place; the loop below rebuilds liveIdx each frame from
  // pool[i].alive checks. This keeps it O(n) with n=liveCount but no shifting.
}

/* ---------------------------------------------------------
   Timing
--------------------------------------------------------- */
let raf = false;
let lastFrameAt = 0;
let lastCountMsgAt = 0;
const COUNT_MSG_INTERVAL = 100;           // ms → ~10 Hz

/* ---------------------------------------------------------
   Message protocol
--------------------------------------------------------- */
self.onmessage = function (ev) {
  const m = ev.data || {};
  switch (m.type) {
    case 'canvas':
      canvas = m.canvas;
      ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
      // Canvas was transferred at the device-pixel size set by main.
      W = m.w; H = m.h; DPR = m.dpr;
      // No main-thread touch from here on.
      if (!raf) { raf = true; lastFrameAt = performance.now(); requestAnimationFrame(loop); }
      break;

    case 'init':
      if (m.cfg) cfg = m.cfg;
      activeEffect = pickActiveEffect(cfg);
      reconfigureForEffect();
      resetSim();
      break;

    case 'cfg':
      // Full config replacement (GUI edits go through here).
      if (m.cfg) cfg = m.cfg;
      activeEffect = pickActiveEffect(cfg);
      reconfigureForEffect();
      // Note: we do NOT reset stars on every config change.
      break;

    case 'chars':
      // Bubble character drag. Recompute mask (throttled by main).
      if (activeEffect && activeEffect.type === 'bubble' && m.chars) {
        activeEffect.chars = m.chars;
        recomputeBubbleMask();
      }
      break;

    case 'clear-mask':
      bubbleMask = null;
      break;

    case 'image-pool':
      if (activeEffect && activeEffect.type === 'images') {
        activeEffect.exceptions = m.exceptions || {};
        activeEffect.defaultSize = m.defaultSize || 60;
        loadImagePool(m.urls || []);
      }
      break;

    case 'reset':
      resetSim();
      break;

    case 'resize':
      W = m.w; H = m.h; DPR = m.dpr;
      if (activeEffect && activeEffect.type === 'bubble') recomputeBubbleMask();
      break;

    case 'shutdown':
      raf = false;
      break;
  }
};

function postMsg(obj) {
  self.postMessage(obj);
}

/* ---------------------------------------------------------
   Config helpers
--------------------------------------------------------- */
function pickActiveEffect(c) {
  if (!c.effects || !c.effects.length) return null;
  return c.effects.find(e => e.id === c.activeEffectId) || c.effects[0] || null;
}

function reconfigureForEffect() {
  if (!activeEffect) { bubbleMask = null; return; }
  if (activeEffect.type === 'bubble') {
    recomputeBubbleMask();
  } else {
    bubbleMask = null;
  }
  if (activeEffect.type === 'images') {
    // Main page will follow up with an 'image-pool' message after this.
  }
}

/* ---------------------------------------------------------
   Sim reset
--------------------------------------------------------- */
function resetSim() {
  // Free all live slots.
  for (let i = 0; i < MAX_POOL; i++) {
    if (pool[i].alive) { pool[i].alive = false; pool[i].imgUrl = null; poolFree[poolFreeTop++] = i; }
  }
  liveCount = 0; liveBaseCount = 0; liveSpawnedCount = 0;
  liveHead = 0; liveTail = 0;
  baseSpawnArmed = false;
  nextBaseSpawnAt = performance.now() + (cfg.base.initialDelay || 0);
}

/* ---------------------------------------------------------
   Bubble mask (rejection-sampling friendly)
--------------------------------------------------------- */
let maskCanvas = null;
let maskCtx = null;

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

/* ---------------------------------------------------------
   Spawn point selection (zero allocations)
--------------------------------------------------------- */
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

/* ---------------------------------------------------------
   Image pool (for 'images' effect)
--------------------------------------------------------- */
let loadedImages = 0;
let imageLoadError = null;

async function loadImagePool(urls) {
  imagePool = [];
  unusedPool = [];
  loadedImages = 0;
  imageLoadError = null;
  if (!urls.length) {
    imageLoadError = 'no images';
    postMsg({ type: 'image-status', loaded: 0, error: 'No images found.' });
    return;
  }
  for (const url of urls) {
    try {
      const bmp = await fetchImageBitmap(url);
      if (bmp) { imageCache.set(url, bmp); imagePool.push(url); }
    } catch (e) { /* skip broken */ }
  }
  loadedImages = imagePool.length;
  if (!loadedImages) imageLoadError = 'load failed';
  postMsg({ type: 'image-status', loaded: loadedImages, error: imageLoadError });
}

async function fetchImageBitmap(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  try {
    const res = await fetch(url, { cache: 'force-cache' });
    if (!res.ok) throw new Error(res.status + '');
    const blob = await res.blob();
    return await createImageBitmap(blob);
  } catch (e) {
    return null;
  }
}

function pickNextImage() {
  if (!imagePool.length) return null;
  if (unusedPool.length === 0) {
    // Reshuffle
    unusedPool = imagePool.slice();
    for (let i = unusedPool.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = unusedPool[i]; unusedPool[i] = unusedPool[j]; unusedPool[j] = t;
    }
  }
  return unusedPool.pop();
}

/* ---------------------------------------------------------
   Star spawn / tick / kill
--------------------------------------------------------- */
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
  // Image assignment
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

/* ---------------------------------------------------------
   Main loop
--------------------------------------------------------- */
function loop() {
  if (!raf || !ctx) return;
  const now = performance.now();
  const dt = now - lastFrameAt;
  lastFrameAt = now;

  // --- Simulation ---
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

  // Tick every live star
  for (let k = 0; k < liveTail; k++) {
    const i = liveIdx[k];
    const s = pool[i];
    if (!s.alive) continue;
    const type = s.isBase ? cfg.base : cfg.spawned;
    if (now >= s.deathStart + type.fadeOut * 1000) {
      killStar(i);
      continue;
    }
    if (now < s.deathStart && now >= s.nextTick) {
      s.nextTick = now + type.tickMs;
      if (cfg.spawned.enabled && liveCount < cfg.global.maxStars) {
        if (Math.random() * 100 < type.reproChance) spawnStar(false);
      }
    }
  }

  // Compact liveIdx (rebuild) — O(liveCount), no allocations
  let w = 0;
  for (let k = 0; k < liveTail; k++) {
    const i = liveIdx[k];
    if (pool[i].alive) liveIdx[w++] = i;
  }
  liveTail = w;

  // --- N-trigger ---
  if (cfg.global.triggerEnabled && liveCount >= cfg.global.maxStars) {
    const c = (activeEffect && activeEffect.flashColor) ? activeEffect.flashColor : '#ffffff';
    postMsg({ type: 'flash', color: c });
    resetSim();
  }

  // --- Render ---
  renderStars(now);

  // --- Count message (throttled) ---
  if (now - lastCountMsgAt > COUNT_MSG_INTERVAL) {
    lastCountMsgAt = now;
    postMsg({ type: 'count', total: liveCount, base: liveBaseCount, spawned: liveSpawnedCount });
  }

  requestAnimationFrame(loop);
}

/* ---------------------------------------------------------
   Render
   Batched by (color, shape, size-bucket). One fill() per bucket.
--------------------------------------------------------- */
const CULL_PAD = 32;

function renderStars(now) {
  ctx.clearRect(0, 0, W, H);

  // Bubble outline (behind stars)
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

  // Clear batching caches
  pathCache.clear();

  // Iterate live stars, build path groups and image draw list
  for (let k = 0; k < liveTail; k++) {
    const i = liveIdx[k];
    const s = pool[i];
    if (!s.alive) continue;
    // Cull
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

    // --- Image star ---
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
      // Fall through to shape if image not ready
    }

    // --- Shape star: bucket by (color, shape, rounded size) ---
    const bucketSize = size < 8 ? Math.round(size) : Math.round(size / 2) * 2;
    const key = type.color + KEY_SEP + type.shape + KEY_SEP + bucketSize + KEY_SEP + (alpha > 0.85 ? 3 : alpha > 0.5 ? 2 : 1);
    let path = pathCache.get(key);
    if (!path) {
      path = { path: new Path2D(), alpha: alpha > 0.85 ? 1 : (alpha > 0.5 ? 0.75 : 0.4),
               color: type.color, shape: type.shape, size: bucketSize, stars: [] };
      pathCache.set(key, path);
    }
    path.stars.push(s.x, s.y, s.rotation || 0);
  }

  // Fill each batch
  for (const batch of pathCache.values()) {
    const p = batch.path;
    const sz = batch.size;
    const h = sz / 2;
    const pts = batch.stars;
    for (let j = 0; j < pts.length; j += 3) {
      const x = pts[j], y = pts[j + 1], rot = pts[j + 2];
      if (rot) {
        const r = rot * Math.PI / 180;
        const cos = Math.cos(r), sin = Math.sin(r);
        addShape(p, 0, 0, sz, batch.shape, cos, sin, x, y);
      } else {
        addShape(p, x, y, sz, batch.shape, 1, 0, 0, 0);
      }
    }
    ctx.globalAlpha = batch.alpha;
    ctx.fillStyle = batch.color;
    ctx.fill(p);
  }

  ctx.globalAlpha = 1;
}

// Add one shape to a Path2D. If cos/sin/offset given, apply rotation+translation inline.
function addShape(p, x, y, s, shape, cos, sin, ox, oy) {
  const h = s / 2;
  const tx = (px, py) => {
    // rotate (px,py) around (0,0), then translate to (ox,oy) or (x,y)
    const rx = px * cos - py * sin;
    const ry = px * sin + py * cos;
    if (ox || oy) return [rx + ox, ry + oy];
    return [rx + x, ry + y];
  };
  switch (shape) {
    case 'circle':
      // Approximate circle with a bezier to avoid ctx.arc (Path2D has arc, but we
      // need rotation-aware — for circles rotation is irrelevant so just use arc).
      p.moveTo(x + h, y);
      p.arc(x, y, h, 0, Math.PI * 2);
      return;
    case 'square': {
      const [a, b] = tx(-h, -h), [c, d] = tx(h, -h), [e, f] = tx(h, h), [g, k] = tx(-h, h);
      p.moveTo(a, b); p.lineTo(c, d); p.lineTo(e, f); p.lineTo(g, k); p.closePath();
      return;
    }
    case 'triangle': {
      const [a, b] = tx(0, -s * 0.62);
      const [c, d] = tx(s * 0.58, s * 0.42);
      const [e, f] = tx(-s * 0.58, s * 0.42);
      p.moveTo(a, b); p.lineTo(c, d); p.lineTo(e, f); p.closePath();
      return;
    }
    case 'diamond': {
      const [a, b] = tx(0, -s * 0.65);
      const [c, d] = tx(s * 0.65, 0);
      const [e, f] = tx(0, s * 0.65);
      const [g, k] = tx(-s * 0.65, 0);
      p.moveTo(a, b); p.lineTo(c, d); p.lineTo(e, f); p.lineTo(g, k); p.closePath();
      return;
    }
    case 'star': {
      for (let i = 0; i < 10; i++) {
        const r = (i % 2 === 0) ? s * 0.72 : s * 0.30;
        const a = -Math.PI / 2 + i * Math.PI / 5;
        const px = Math.cos(a) * r, py = Math.sin(a) * r;
        const [X, Y] = tx(px, py);
        if (i === 0) p.moveTo(X, Y); else p.lineTo(X, Y);
      }
      p.closePath();
      return;
    }
    case 'plus': {
      const t = Math.max(1, s * 0.34);
      // Two rects. Path2D combines fine.
      let [a, b] = tx(-t / 2, -h); let [c, d] = tx(t / 2, -h); let [e, f] = tx(t / 2, h); let [g, k] = tx(-t / 2, h);
      p.moveTo(a, b); p.lineTo(c, d); p.lineTo(e, f); p.lineTo(g, k); p.closePath();
      [a, b] = tx(-h, -t / 2); [c, d] = tx(h, -t / 2); [e, f] = tx(h, t / 2); [g, k] = tx(-h, t / 2);
      p.moveTo(a, b); p.lineTo(c, d); p.lineTo(e, f); p.lineTo(g, k); p.closePath();
      return;
    }
    default: {
      const [a, b] = tx(-h, -h), [c, d] = tx(h, -h), [e, f] = tx(h, h), [g, k] = tx(-h, h);
      p.moveTo(a, b); p.lineTo(c, d); p.lineTo(e, f); p.lineTo(g, k); p.closePath();
    }
  }
}