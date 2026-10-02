/* =========================================================
   star-worker.js  (v8)
   - Relative coordinates (positions/sizes are 0..1 fractions)
   - Fixed-timestep sim, decoupled from render loop
   - Sprite-based rendering
   - DPR-aware, LRU sprite cache
   - Dense bubble masks
   - Floating / Pinned letters with active band + catch-up
========================================================= */
'use strict';

let canvas = null;
let ctx = null;
let W = 1, H = 1, DPR = 1, MIN_DIM = 1;
let scrollY = 0;
let docHeight = 1;

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

// Runtime state per letter, parallel to activeEffect.chars
// { mask, active, nextSpawnAt }
let lettersRuntime = [];

// Star pool
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

// Sprite cache
const MAX_SPRITES = 256;
const spriteCache = new Map();
const spriteLRU = [];

// Reusable measure canvas
let _measureCanvas = null;
let _measureCtx = null;

function resetPool() {
  for (let i = 0; i < MAX_POOL; i++) {
    pool[i] = { alive:false, x:0, y:0, isBase:false, birth:0, deathStart:0, nextTick:0,
                imgUrl:null, rotation:0, space:'floating' };
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
const MAX_CATCHUP_MS = 200;
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
      rebuildLettersRuntime();
      resetSim();
      break;

    case 'cfg':
      if (m.cfg) cfg = m.cfg;
      activeEffect = pickActiveEffect(cfg);
      rebuildLettersRuntime();
      break;

    case 'chars':
      if (activeEffect && activeEffect.type === 'bubble' && m.chars) {
        activeEffect.chars = m.chars;
        rebuildLettersRuntime();
      }
      break;

    case 'view-info':
      // scrollY and docHeight from main thread
      if (typeof m.scrollY === 'number') scrollY = m.scrollY;
      if (typeof m.docHeight === 'number' && m.docHeight > 0) {
        const oldDoc = docHeight;
        docHeight = m.docHeight;
        if (oldDoc !== docHeight) recomputePinnedMasks();
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
      rebuildLettersRuntime();
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
// Letters runtime + masks
// =========================================================
function rebuildLettersRuntime() {
  lettersRuntime = [];
  if (!activeEffect || activeEffect.type !== 'bubble' || !activeEffect.chars) return;
  const now = performance.now();
  for (let i = 0; i < activeEffect.chars.length; i++) {
    const c = activeEffect.chars[i];
    const mask = computeLetterMask(c);
    lettersRuntime.push({
      mask,
      active: false,
      nextSpawnAt: now + (c.spawnIntervalMs || 200)
    });
  }
  // Ensure activity is up to date (so new pinned letters can catch-up if in band)
  updateLetterActivity(now);
}

function recomputePinnedMasks() {
  if (!activeEffect || activeEffect.type !== 'bubble' || !activeEffect.chars) return;
  for (let i = 0; i < activeEffect.chars.length; i++) {
    const c = activeEffect.chars[i];
    if (c.mode === 'pinned') {
      lettersRuntime[i].mask = computeLetterMask(c);
    }
  }
}

function computeLetterMask(charCfg) {
  if (!charCfg.char) return null;
  const sizePx = Math.max(1, (charCfg.size || 0) * MIN_DIM);

  // Position in native space (viewport px for floating, document px for pinned)
  const posX = (charCfg.x || 0) * W;
  const posY = charCfg.mode === 'pinned'
    ? (charCfg.y || 0) * docHeight
    : (charCfg.y || 0) * H;

  // Measure glyph unrotated
  if (!_measureCanvas) {
    _measureCanvas = new OffscreenCanvas(64, 64);
    _measureCtx = _measureCanvas.getContext('2d');
  }
  _measureCtx.font = `900 ${sizePx}px 'Arial Black', Arial, sans-serif`;
  const m = _measureCtx.measureText(charCfg.char);
  const glyphW = Math.max(m.width || sizePx, sizePx * 0.4);
  let asc = (m.actualBoundingBoxAscent !== undefined) ? m.actualBoundingBoxAscent : sizePx * 0.8;
  let desc = (m.actualBoundingBoxDescent !== undefined) ? m.actualBoundingBoxDescent : sizePx * 0.2;
  const glyphH = Math.max(asc + desc, sizePx * 0.4);

  // Rotated AABB
  const rotRad = (charCfg.rotation || 0) * Math.PI / 180;
  const cos = Math.abs(Math.cos(rotRad));
  const sin = Math.abs(Math.sin(rotRad));
  const aabbW = Math.ceil(glyphW * cos + glyphH * sin) + 12;
  const aabbH = Math.ceil(glyphW * sin + glyphH * cos) + 12;
  const boxSize = Math.max(aabbW, aabbH, 8);

  // Draw rotated glyph into mask box
  const c = new OffscreenCanvas(boxSize, boxSize);
  const mctx = c.getContext('2d', { willReadFrequently: true });
  mctx.fillStyle = '#fff';
  mctx.textAlign = 'center';
  mctx.textBaseline = 'middle';
  mctx.translate(boxSize / 2, boxSize / 2);
  if (charCfg.rotation) mctx.rotate(rotRad);
  mctx.font = `900 ${sizePx}px 'Arial Black', Arial, sans-serif`;
  mctx.fillText(charCfg.char, 0, 0);

  const imgData = mctx.getImageData(0, 0, boxSize, boxSize);
  const src = imgData.data;
  const data = new Uint8Array(boxSize * boxSize);
  for (let i = 0; i < boxSize * boxSize; i++) {
    if (src[i * 4 + 3] > 128) data[i] = 1;
  }

  return {
    data, boxSize,
    x0: posX - boxSize / 2,
    y0: posY - boxSize / 2
  };
}

function isInMask(mask, x, y) {
  if (!mask) return false;
  const lx = x - mask.x0;
  const ly = y - mask.y0;
  if (lx < 0 || ly < 0 || lx >= mask.boxSize || ly >= mask.boxSize) return false;
  const ix = lx | 0;
  const iy = ly | 0;
  return mask.data[iy * mask.boxSize + ix] === 1;
}

function randomPointInMask(mask) {
  if (!mask) return null;
  const bs = mask.boxSize;
  for (let t = 0; t < 40; t++) {
    const ix = (Math.random() * bs) | 0;
    const iy = (Math.random() * bs) | 0;
    if (mask.data[iy * bs + ix] === 1) {
      return { x: mask.x0 + ix + Math.random(), y: mask.y0 + iy + Math.random() };
    }
  }
  // Fallback: pick a random '1' pixel
  const N = bs * bs;
  const start = (Math.random() * N) | 0;
  for (let i = 0; i < N; i++) {
    const idx = (start + i) % N;
    if (mask.data[idx] === 1) {
      const ix = idx % bs;
      const iy = (idx / bs) | 0;
      return { x: mask.x0 + ix + Math.random(), y: mask.y0 + iy + Math.random() };
    }
  }
  return null;
}

// Any floating letter mask contains (x, y) in viewport space?
function isInAnyFloatingMask(x, y) {
  for (let i = 0; i < lettersRuntime.length; i++) {
    const c = activeEffect.chars[i];
    if (!c || c.mode === 'pinned') continue;
    const rt = lettersRuntime[i];
    if (rt.mask && isInMask(rt.mask, x, y)) return true;
  }
  return false;
}

// Any pinned letter mask contains (docX, docY) in document space?
function isInAnyPinnedMask(docX, docY) {
  for (let i = 0; i < lettersRuntime.length; i++) {
    const c = activeEffect.chars[i];
    if (!c || c.mode !== 'pinned') continue;
    const rt = lettersRuntime[i];
    if (rt.mask && isInMask(rt.mask, docX, docY)) return true;
  }
  return false;
}

// =========================================================
// Spawn target selection
// =========================================================
function bubbleAboveThreshold() {
  if (!activeEffect || activeEffect.type !== 'bubble') return false;
  const threshold = Number(activeEffect.minStarsForBubble) || 0;
  return liveCount >= threshold;
}

function pickActiveLetters() {
  // returns list of indices of letters currently eligible for spawning
  const out = [];
  for (let i = 0; i < lettersRuntime.length; i++) {
    const c = activeEffect.chars[i];
    if (!c || !c.char) continue;
    if (c.mode === 'pinned') {
      if (lettersRuntime[i].active) out.push(i);
    } else {
      out.push(i); // floating always active
    }
  }
  return out;
}

// =========================================================
// Spawn — floating field
// =========================================================
function getFloatingSpawnPoint() {
  let x = 0, y = 0;
  if (activeEffect && activeEffect.type === 'bubble' && activeEffect.beforeThresholdMode === 'avoid') {
    for (let t = 0; t < 100; t++) {
      x = Math.random() * W;
      y = Math.random() * H;
      if (isInAnyFloatingMask(x, y)) continue;
      if (isInAnyPinnedMask(x, y + scrollY)) continue;
      return { x, y };
    }
  }
  x = Math.random() * W;
  y = Math.random() * H;
  return { x, y };
}

function spawnFloatingStar(isBase) {
  const i = allocSlot();
  if (i < 0) return;
  const s = pool[i];
  const type = isBase ? cfg.base : cfg.spawned;
  const now = performance.now();
  const pt = getFloatingSpawnPoint();
  s.alive = true;
  s.x = pt.x / W;
  s.y = pt.y / H;
  s.space = 'floating';
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

// =========================================================
// Spawn — pinned letter
// =========================================================
function spawnPinnedStar(letterIdx) {
  const rt = lettersRuntime[letterIdx];
  const c = activeEffect.chars[letterIdx];
  if (!rt || !c || !rt.mask) return;
  const pt = randomPointInMask(rt.mask);
  if (!pt) return;
  const i = allocSlot();
  if (i < 0) return;
  const s = pool[i];
  const type = cfg.spawned;
  const now = performance.now();
  s.alive = true;
  s.x = pt.x / W;             // x is fraction of W (viewport width == document width)
  s.y = pt.y / docHeight;     // y is fraction of docHeight
  s.space = 'pinned';
  s.isBase = false;
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
  liveSpawnedCount++;
}

// =========================================================
// Spawn — general entry point (base + repro)
// =========================================================
function spawnStar(isBase) {
  // Above threshold: redirect spawns into a random active letter
  if (bubbleAboveThreshold()) {
    const active = pickActiveLetters();
    if (active.length) {
      const idx = active[(Math.random() * active.length) | 0];
      const c = activeEffect.chars[idx];
      if (c.mode === 'pinned') {
        spawnPinnedStar(idx);
        return;
      }
      // Floating letter — spawn inside its mask in viewport space
      const rt = lettersRuntime[idx];
      const pt = randomPointInMask(rt.mask);
      if (pt) {
        const i = allocSlot();
        if (i < 0) return;
        const s = pool[i];
        const type = isBase ? cfg.base : cfg.spawned;
        const now = performance.now();
        s.alive = true;
        s.x = pt.x / W;
        s.y = pt.y / H;
        s.space = 'floating';
        s.isBase = isBase;
        s.birth = now;
        s.deathStart = now + type.lifespan * 1000;
        s.nextTick = now + type.tickMs;
        s.rotation = type.randomRotation ? Math.random() * 360 : 0;
        if (activeEffect && activeEffect.type === 'images' && imagePool.length) {
          const threshold = Number(activeEffect.minStarsForImages) || 0;
          s.imgUrl = (liveCount >= threshold) ? pickNextImage() : null;
        } else s.imgUrl = null;
        addLive(i);
        liveCount++;
        if (isBase) liveBaseCount++; else liveSpawnedCount++;
        return;
      }
      // fall through to field spawn if mask had no ink
    }
  }
  spawnFloatingStar(isBase);
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
// Active band logic for pinned letters
// =========================================================
function updateLetterActivity(now) {
  if (!activeEffect || activeEffect.type !== 'bubble') return;
  const buffer = activeEffect.scrollBuffer ?? 1;
  const bandTop = scrollY - buffer * H;
  const bandBottom = scrollY + (1 + buffer) * H;
  const burst = activeEffect.catchUpBurst ?? 50;
  for (let i = 0; i < lettersRuntime.length; i++) {
    const c = activeEffect.chars[i];
    if (!c || c.mode !== 'pinned') { lettersRuntime[i].active = false; continue; }
    const docY = (c.y || 0) * docHeight;
    const wasActive = lettersRuntime[i].active;
    const nowActive = (docY >= bandTop) && (docY <= bandBottom);
    lettersRuntime[i].active = nowActive;
    if (!wasActive && nowActive) {
      // Catch-up burst
      const budget = Math.max(0, cfg.global.maxStars - liveCount);
      const n = Math.min(burst, budget);
      for (let j = 0; j < n; j++) spawnPinnedStar(i);
    }
  }
}

// =========================================================
// Sim step — no rendering
// =========================================================
function stepSim(now) {
  // Update pinned letter activity (may trigger catch-up bursts)
  updateLetterActivity(now);

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

  // Pinned letters spawn on their own clock
  if (activeEffect && activeEffect.type === 'bubble') {
    for (let i = 0; i < lettersRuntime.length; i++) {
      const c = activeEffect.chars[i];
      if (!c || c.mode !== 'pinned' || !lettersRuntime[i].active) continue;
      if (liveCount >= cfg.global.maxStars) continue;
      if (now >= lettersRuntime[i].nextSpawnAt) {
        spawnPinnedStar(i);
        lettersRuntime[i].nextSpawnAt = now + (c.spawnIntervalMs || 200);
      }
    }
  }

  // Tick stars
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

  if (cfg.global.triggerEnabled && liveCount >= cfg.global.maxStars) {
    const c = (activeEffect && activeEffect.flashColor) ? activeEffect.flashColor : '#ffffff';
    postMsg({ type: 'flash', color: c });
    resetSim();
  }

  if (now - lastCountMsgAt > COUNT_MSG_INTERVAL) {
    lastCountMsgAt = now;
    postMsg({ type: 'count', total: liveCount, base: liveBaseCount, spawned: liveSpawnedCount });
  }
}

// =========================================================
// Master loop
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
function clearSpriteCache() { spriteCache.clear(); spriteLRU.length = 0; }

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
  const h = bucket / 2;
  const cx = h, cy = h;
  sctx.beginPath();
  switch (shape) {
    case 'circle': sctx.arc(cx, cy, h, 0, Math.PI * 2); sctx.fill(); break;
    case 'square': sctx.fillRect(cx - h, cy - h, bucket, bucket); break;
    case 'triangle':
      sctx.moveTo(cx, cy - bucket * 0.62);
      sctx.lineTo(cx + bucket * 0.58, cy + bucket * 0.42);
      sctx.lineTo(cx - bucket * 0.58, cy + bucket * 0.42);
      sctx.closePath(); sctx.fill(); break;
    case 'diamond':
      sctx.moveTo(cx, cy - bucket * 0.65);
      sctx.lineTo(cx + bucket * 0.65, cy);
      sctx.lineTo(cx, cy + bucket * 0.65);
      sctx.lineTo(cx - bucket * 0.65, cy);
      sctx.closePath(); sctx.fill(); break;
    case 'star':
      for (let i = 0; i < 10; i++) {
        const r = (i % 2 === 0) ? bucket * 0.72 : bucket * 0.30;
        const a = -Math.PI / 2 + i * Math.PI / 5;
        const sxp = cx + Math.cos(a) * r;
        const syp = cy + Math.sin(a) * r;
        if (i === 0) sctx.moveTo(sxp, syp); else sctx.lineTo(sxp, syp);
      }
      sctx.closePath(); sctx.fill(); break;
    case 'plus': {
      const t = Math.max(1, bucket * 0.34);
      sctx.fillRect(cx - t / 2, cy - h, t, bucket);
      sctx.fillRect(cx - h, cy - t / 2, bucket, t);
      break;
    }
    default: sctx.fillRect(cx - h, cy - h, bucket, bucket);
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
// Render
// =========================================================
const CULL_PAD = 32;

function renderFrame(now) {
  ctx.clearRect(0, 0, W, H);

  // Bubble outline guide
  if (activeEffect && activeEffect.type === 'bubble' && activeEffect.showOutline && (activeEffect.outlineOpacity ?? 0.5) > 0 && activeEffect.chars) {
    ctx.strokeStyle = activeEffect.outlineColor;
    ctx.globalAlpha = Math.min(1, Math.max(0, activeEffect.outlineOpacity ?? 0.5));
    ctx.lineWidth = Math.max(1, (activeEffect.outlineWidth || 0) * MIN_DIM);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const c of activeEffect.chars) {
      if (!c.char) continue;
      let sy;
      if (c.mode === 'pinned') sy = (c.y || 0) * docHeight - scrollY;
      else sy = (c.y || 0) * H;
      if (sy < -400 || sy > H + 400) continue;
      const sx = (c.x || 0) * W;
      ctx.save();
      ctx.translate(sx, sy);
      if (c.rotation) ctx.rotate(c.rotation * Math.PI / 180);
      ctx.font = `900 ${Math.max(1, (c.size || 0) * MIN_DIM)}px 'Arial Black', Arial, sans-serif`;
      ctx.strokeText(c.char, 0, 0);
      ctx.restore();
    }
  }

  // Stars
  for (let k = 0; k < liveTail; k++) {
    const i = liveIdx[k];
    const s = pool[i];
    if (!s.alive) continue;

    // Screen position
    let sx, sy;
    if (s.space === 'pinned') {
      sx = s.x * W;
      sy = s.y * docHeight - scrollY;
    } else {
      sx = s.x * W;
      sy = s.y * H;
    }

    if (sx < -CULL_PAD || sx > W + CULL_PAD || sy < -CULL_PAD || sy > H + CULL_PAD) continue;

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
          ctx.translate(sx, sy);
          ctx.rotate(s.rotation * Math.PI / 180);
          ctx.drawImage(bmp, -dw / 2, -dh / 2, dw, dh);
          ctx.restore();
        } else {
          ctx.drawImage(bmp, sx - dw / 2, sy - dh / 2, dw, dh);
        }
        continue;
      }
    }

    const bucket = sizeBucket(sizePx);
    const sprite = getSprite(type.shape, type.color, bucket);
    ctx.globalAlpha = Math.min(1, alpha);
    if (s.rotation) {
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(s.rotation * Math.PI / 180);
      ctx.drawImage(sprite.canvas, -bucket / 2, -bucket / 2, bucket, bucket);
      ctx.restore();
    } else {
      ctx.drawImage(sprite.canvas, sx - bucket / 2, sy - bucket / 2, bucket, bucket);
    }
  }

  ctx.globalAlpha = 1;
}
