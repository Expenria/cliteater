/* =========================================================
   star-worker.js  (v6)
   - Relative coordinates (all positions/sizes are 0..1 fractions)
   - Fixed-timestep sim, decoupled from render loop
   - Sprite-based rendering (pre-rendered shape bitmaps, drawImage)
   - DPR-aware, cache-safe, LRU-bounded sprite cache
========================================================= */
'use strict';

let canvas = null;
let ctx = null;
let W = 1, H = 1, DPR = 1, MIN_DIM = 1;

// Coordinate convention: everything stored as fractions.
// x: 0..1 of W    y: 0..1 of H    size: 0..1 of MIN_DIM
let cfg = {
  global:  { maxStars: 500, triggerEnabled: false },
  base:    { enabled: true, initialDelay: 800, spawnInterval: 400, reproChance: 3, tickMs: 500,
             lifespan: 5, color: '#ffffff', shape: 'square', size: 0.004, fadeIn: 0.4, fadeOut: 0.5,
             flashOut: true, randomRotation: false },
  spawned: { enabled: true, reproChance: 5, tickMs: 200, lifespan: 3, color: '#a5b4fc', shape: 'square',
             size: 0.004, fadeIn: 0.4, fadeOut: 0.5, flashOut: true, randomRotation: false },
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
const imagePool = [];
let unusedPool = [];

let bubbleMask = null;

// -------- Sprite cache --------
const MAX_SPRITES = 256;
const spriteCache = new Map();   // key -> { canvas, size }
const spriteLRU = [];            // array of keys, oldest first

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

// -------- Timing --------
let rafActive = false;
let lastFrameAt = 0;
let simAccumulator = 0;
let lastCountMsgAt = 0;
const SIM_STEP_MS = 1000 / 60;
const MAX_CATCHUP_MS = 200;      // clamp to avoid spiral of death
const COUNT_MSG_INTERVAL = 100;

const raf = (typeof requestAnimationFrame !== 'undefined')
  ? requestAnimationFrame
  : (cb) => setTimeout(() => cb(performance.now()), 16);

// -------- Messaging --------
self.onmessage = function (ev) {
  const m = ev.data || {};
  switch (m.type) {
    case 'canvas':
      canvas = m.canvas;
      W = m.w; H = m.h; DPR = m.dpr || 1;
      MIN_DIM = Math.min(W, H);
      canvas.width = Math.max(1, Math.floor(W * DPR));
      canvas.height = Math.max(1, Math.floor(H * DPR));
      ctx = canvas.getContext('2d');
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      clearSpriteCache();
      postMsg({ type: 'canvas-ready', W, H, DPR, cw: canvas.width, ch: canvas.height });
      if (!rafActive) {
        rafActive = true;
        lastFrameAt = performance.now();
        raf(masterLoop);
      }
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
        activeEffect.defaultSize = m.defaultSize || 0.086;
        loadImagePool(m.urls || []);
      }
      break;

    case 'reset':
      resetSim();
      break;

    case 'resize': {
      const oldDpr = DPR;
      W = m.w; H = m.h; DPR = m.dpr || 1;
      MIN_DIM = Math.min(W, H);
      canvas.width = Math.max(1, Math.floor(W * DPR));
      canvas.height = Math.max(1, Math.floor(H * DPR));
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      if (oldDpr !== DPR) clearSpriteCache();
      if (activeEffect && activeEffect.type === 'bubble') recomputeBubbleMask();
      break;
    }

    case 'shutdown':
      rafActive = false;
      break;
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

// =========================================================
// Bubble mask
// =========================================================
let maskCanvas = null, maskCtx = null;

function recomputeBubbleMask() {
  if (!activeEffect || activeEffect.type !== 'bubble' || !activeEffect.chars || !activeEffect.chars.length) {
    bubbleMask = null; return;
  }
  const scale = 0.5;
  const cw = Math.max(1, Math.floor(W * scale));
  const ch = Math.max(1, Math.floor(H * scale));
  if (!maskCanvas) {
    maskCanvas = new OffscreenCanvas(cw, ch);
    maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
  } else {
    maskCanvas.width = cw;
    maskCanvas.height = ch;
    maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
  }
  maskCtx.clearRect(0, 0, cw, ch);
  maskCtx.fillStyle = '#fff';
  maskCtx.textAlign = 'center';
  maskCtx.textBaseline = 'middle';
  for (const c of activeEffect.chars) {
    if (!c.char) continue;
    // coords are fractions → convert to CSS px for drawing on the scaled mask
    const cx = c.x * W;
    const cy = c.y * H;
    const csize = c.size * MIN_DIM;
    maskCtx.save();
    maskCtx.translate(cx * scale, cy * scale);
    if (c.rotation) maskCtx.rotate(c.rotation * Math.PI / 180);
    maskCtx.font = `900 ${Math.max(1, csize * scale)}px 'Arial Black', Arial, sans-serif`;
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

// =========================================================
// Image pool
// =========================================================
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
    } catch (e) { /* skip */ }
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

// =========================================================
// Spawn / kill
// =========================================================
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

// =========================================================
// Sim step — no rendering
// =========================================================
function stepSim(now) {
  // Base spawn gate
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

  // Tick stars — snapshot liveTail so newborns don't tick this step
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

  // Compact live list
  let w = 0;
  for (let k = 0; k < liveTail; k++) {
    const i = liveIdx[k];
    if (pool[i].alive) liveIdx[w++] = i;
  }
  liveTail = w;

  // N-trigger
  if (cfg.global.triggerEnabled && liveCount >= cfg.global.maxStars) {
    const c = (activeEffect && activeEffect.flashColor) ? activeEffect.flashColor : '#ffffff';
    postMsg({ type: 'flash', color: c });
    resetSim();
  }

  // Count message (throttled)
  if (now - lastCountMsgAt > COUNT_MSG_INTERVAL) {
    lastCountMsgAt = now;
    postMsg({ type: 'count', total: liveCount, base: liveBaseCount, spawned: liveSpawnedCount });
  }
}

// =========================================================
// Master loop — fixed-step sim, per-frame render
// =========================================================
function masterLoop() {
  if (!rafActive || !ctx) return;
  const now = performance.now();
  let elapsed = now - lastFrameAt;
  lastFrameAt = now;
  if (elapsed > MAX_CATCHUP_MS) elapsed = MAX_CATCHUP_MS;
  simAccumulator += elapsed;

  let steps = 0;
  while (simAccumulator >= SIM_STEP_MS && steps < 20) {
    simAccumulator -= SIM_STEP_MS;
    stepSim(now);
    steps++;
  }

  renderFrame(now);
  raf(masterLoop);
}

// =========================================================
// Sprite cache
// =========================================================
function clearSpriteCache() {
  spriteCache.clear();
  spriteLRU.length = 0;
}

function sizeBucket(sizePx) {
  if (sizePx < 4) return Math.max(1, Math.ceil(sizePx));
  return Math.max(4, Math.round(sizePx / 2) * 2);
}

function getSprite(shape, color, bucket) {
  const key = shape + '|' + color + '|' + bucket;
  let sprite = spriteCache.get(key);
  if (sprite) return sprite;

  const px = Math.max(2, Math.ceil(bucket * DPR));
  const c = new OffscreenCanvas(px, px);
  const sctx = c.getContext('2d');
  sctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  sctx.fillStyle = color;
  sctx.strokeStyle = color;

  // Draw the shape centered at bucket/2, bucket/2 in CSS px
  const h = bucket / 2;
  const cx = h, cy = h;
  sctx.beginPath();
  switch (shape) {
    case 'circle':
      sctx.arc(cx, cy, h, 0, Math.PI * 2);
      sctx.fill();
      break;
    case 'square':
      sctx.fillRect(cx - h, cy - h, bucket, bucket);
      break;
    case 'triangle':
      sctx.moveTo(cx, cy - bucket * 0.62);
      sctx.lineTo(cx + bucket * 0.58, cy + bucket * 0.42);
      sctx.lineTo(cx - bucket * 0.58, cy + bucket * 0.42);
      sctx.closePath();
      sctx.fill();
      break;
    case 'diamond':
      sctx.moveTo(cx, cy - bucket * 0.65);
      sctx.lineTo(cx + bucket * 0.65, cy);
      sctx.lineTo(cx, cy + bucket * 0.65);
      sctx.lineTo(cx - bucket * 0.65, cy);
      sctx.closePath();
      sctx.fill();
      break;
    case 'star':
      for (let i = 0; i < 10; i++) {
        const r = (i % 2 === 0) ? bucket * 0.72 : bucket * 0.30;
        const a = -Math.PI / 2 + i * Math.PI / 5;
        const sxp = cx + Math.cos(a) * r;
        const syp = cy + Math.sin(a) * r;
        if (i === 0) sctx.moveTo(sxp, syp); else sctx.lineTo(sxp, syp);
      }
      sctx.closePath();
      sctx.fill();
      break;
    case 'plus': {
      const t = Math.max(1, bucket * 0.34);
      sctx.fillRect(cx - t / 2, cy - h, t, bucket);
      sctx.fillRect(cx - h, cy - t / 2, bucket, t);
      break;
    }
    default:
      sctx.fillRect(cx - h, cy - h, bucket, bucket);
  }

  sprite = { canvas: c, size: bucket };
  spriteCache.set(key, sprite);
  spriteLRU.push(key);
  while (spriteLRU.length > MAX_SPRITES) {
    const old = spriteLRU.shift();
    spriteCache.delete(old);
  }
  return sprite;
}

// =========================================================
// Render — no state changes
// =========================================================
const CULL_PAD = 32;

function renderFrame(now) {
  ctx.clearRect(0, 0, W, H);

  // Bubble outline guide
  if (activeEffect && activeEffect.type === 'bubble' && activeEffect.showOutline && (activeEffect.outlineOpacity ?? 0.5) > 0 && activeEffect.chars) {
    ctx.save();
    ctx.strokeStyle = activeEffect.outlineColor;
    ctx.globalAlpha = Math.min(1, Math.max(0, activeEffect.outlineOpacity ?? 0.5));
    ctx.lineWidth = Math.max(1, (activeEffect.outlineWidth || 0) * MIN_DIM);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of activeEffect.chars) {
      if (!c.char) continue;
      ctx.save();
      ctx.translate(c.x * W, c.y * H);
      if (c.rotation) ctx.rotate(c.rotation * Math.PI / 180);
      ctx.font = `900 ${Math.max(1, c.size * MIN_DIM)}px 'Arial Black', Arial, sans-serif`;
      ctx.strokeText(c.char, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  for (let k = 0; k < liveTail; k++) {
    const i = liveIdx[k];
    const s = pool[i];
    if (!s.alive) continue;
    if (s.x < -CULL_PAD || s.x > W + CULL_PAD || s.y < -CULL_PAD || s.y > H + CULL_PAD) continue;

    const type = s.isBase ? cfg.base : cfg.spawned;
    const fi = Math.max(1, type.fadeIn * 1000);
    const fo = Math.max(1, type.fadeOut * 1000);
    const baseSizePx = Math.max(0.5, type.size * MIN_DIM);
    let alpha = 1, sizePx = baseSizePx;

    if (now < s.birth + fi) alpha = (now - s.birth) / fi;
    else if (now >= s.deathStart) {
      const t = (now - s.deathStart) / fo;
      if (type.flashOut) { alpha = (1 - t) * (1 - t); sizePx = baseSizePx * (1 + t * 2.5); }
      else alpha = 1 - t;
    }
    if (alpha <= 0) continue;

    // Image star
    if (s.imgUrl) {
      const bmp = imageCache.get(s.imgUrl);
      if (bmp) {
        const sizePxImg = Math.max(4, (((activeEffect.exceptions && activeEffect.exceptions[s.imgUrl]) || activeEffect.defaultSize) || 0.086) * MIN_DIM);
        const aspect = bmp.width / bmp.height;
        let dw, dh;
        if (aspect > 1) { dw = sizePxImg; dh = sizePxImg / aspect; } else { dw = sizePxImg * aspect; dh = sizePxImg; }
        ctx.globalAlpha = Math.min(1, alpha);
        if (s.rotation) {
          ctx.save();
          ctx.translate(s.x, s.y);
          ctx.rotate(s.rotation * Math.PI / 180);
          ctx.drawImage(bmp, -dw / 2, -dh / 2, dw, dh);
          ctx.restore();
        } else {
          ctx.drawImage(bmp, s.x - dw / 2, s.y - dh / 2, dw, dh);
        }
        continue;
      }
      // fall through if bitmap missing
    }

    // Shape star — sprite
    const bucket = sizeBucket(sizePx);
    const sprite = getSprite(type.shape, type.color, bucket);
    ctx.globalAlpha = Math.min(1, alpha);
    if (s.rotation) {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rotation * Math.PI / 180);
      ctx.drawImage(sprite.canvas, -bucket / 2, -bucket / 2, bucket, bucket);
      ctx.restore();
    } else {
      ctx.drawImage(sprite.canvas, s.x - bucket / 2, s.y - bucket / 2, bucket, bucket);
    }
  }

  ctx.globalAlpha = 1;
}
