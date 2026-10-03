/* =========================================================
   star-worker.js  (v9)
   - Relative coordinates (positions/sizes are 0..1 fractions)
   - Fixed-timestep sim, decoupled from render loop
   - Sprite-based rendering, DPR-aware, LRU sprite cache
   - Dense bubble masks
   - Floating / Pinned letters with active band + catch-up
   - Image cues: pixel-art mosaics triggered by MP3 time
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

// ===== Cues =====
let mp3CurrentTime = -1;
let cues = [];              // active track's cue list (from main)
let cueRuntime = [];         // parallel runtime state per cue
let cueMode = false;         // true when any cue is active or fading
const pixageCache = new Map();      // key: url__res -> sampled grid
const pixageRawCache = new Map();   // url -> ImageBitmap
const pixagePending = new Map();    // key -> Promise

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

// Letters (bubble effect)
let lettersRuntime = [];

// Sprite cache
const MAX_SPRITES = 256;
const spriteCache = new Map();
const spriteLRU = [];

// Measure canvas
let _measureCanvas = null, _measureCtx = null;

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

// Timing
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

// ===== Messaging =====
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

    case 'cues':
      // Full cue list for the currently selected track.
      // Each cue: { id, imageUrl, startTime, endTime, x, y, fade, cellPx, fadeSpeed, targetResolution }
      cues = Array.isArray(m.cues) ? m.cues.slice() : [];
      rebuildCueRuntime();
      break;

    case 'mp3-time':
      if (typeof m.t === 'number') mp3CurrentTime = m.t;
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

/* =========================================================
   CUE RUNTIME
========================================================= */

function rebuildCueRuntime() {
  cueRuntime = [];
  for (const cue of cues) {
    const rt = {
      cue,
      pixage: null,
      loaded: false,
      cueActive: false,
      prevActive: false,
      revealAccumulator: 0,
      revealed: 0
    };
    cueRuntime.push(rt);
    ensurePixageLoaded(cue.imageUrl, cue.targetResolution || 128).then(p => {
      if (p) { rt.pixage = p; rt.loaded = true; }
    }).catch(() => {});
  }
}

async function ensurePixageLoaded(imageUrl, targetRes) {
  const key = imageUrl + '__' + targetRes;
  if (pixageCache.has(key)) return pixageCache.get(key);
  if (pixagePending.has(key)) return pixagePending.get(key);
  const p = (async () => {
    let bmp = pixageRawCache.get(imageUrl);
    if (!bmp) {
      try {
        const res = await fetch(imageUrl, { cache: 'force-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        bmp = await createImageBitmap(blob);
        pixageRawCache.set(imageUrl, bmp);
      } catch (e) {
        postMsg({ type: 'pixage-status', url: imageUrl, loaded: false, error: e.message });
        pixagePending.delete(key);
        return null;
      }
    }
    const srcW = bmp.width, srcH = bmp.height;
    const longSide = Math.max(srcW, srcH);
    let outW, outH;
    if (longSide <= targetRes) { outW = srcW; outH = srcH; }
    else {
      const scale = targetRes / longSide;
      outW = Math.max(1, Math.round(srcW * scale));
      outH = Math.max(1, Math.round(srcH * scale));
    }
    const oc = new OffscreenCanvas(outW, outH);
    const octx = oc.getContext('2d', { willReadFrequently: true });
    octx.imageSmoothingEnabled = true;
    octx.drawImage(bmp, 0, 0, outW, outH);
    const imgData = octx.getImageData(0, 0, outW, outH);
    const d = imgData.data;
    const cellColours = new Array(outW * outH);
    const valid = [];
    for (let i = 0; i < outW * outH; i++) {
      const a = d[i * 4 + 3];
      if (a < 8) { cellColours[i] = null; }
      else {
        cellColours[i] = 'rgb(' + d[i*4] + ',' + d[i*4+1] + ',' + d[i*4+2] + ')';
        valid.push(i);
      }
    }
    // Shuffle valid cell order once (used as reveal order for fade)
    for (let i = valid.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = valid[i]; valid[i] = valid[j]; valid[j] = t;
    }
    const sampled = {
      w: outW, h: outH,
      cellColours,
      validCells: new Uint32Array(valid),
      totalCells: valid.length
    };
    pixageCache.set(key, sampled);
    pixagePending.delete(key);
    postMsg({ type: 'pixage-status', url: imageUrl, loaded: true, w: outW, h: outH });
    return sampled;
  })();
  pixagePending.set(key, p);
  return p;
}

function killAllStars() {
  for (let i = 0; i < MAX_POOL; i++) {
    if (pool[i].alive) { pool[i].alive = false; pool[i].imgUrl = null; poolFree[poolFreeTop++] = i; }
  }
  liveCount = 0; liveBaseCount = 0; liveSpawnedCount = 0;
  liveTail = 0;
}

function stepCues(now, dt) {
  let anyActiveOrFading = false;
  for (let i = 0; i < cueRuntime.length; i++) {
    const rt = cueRuntime[i];
    const cue = rt.cue;
    const isActive = (mp3CurrentTime >= cue.startTime) && (mp3CurrentTime < cue.endTime);

    if (isActive && !rt.prevActive) {
      // Cue just became active
      if (cue.fade === false) {
        // Snap: instant reveal, kill existing stars once
        killAllStars();
        rt.revealAccumulator = rt.pixage ? rt.pixage.totalCells : 0;
        rt.revealed = rt.pixage ? rt.pixage.totalCells : 0;
      } else {
        // Fade: start from 0
        rt.revealAccumulator = 0;
        rt.revealed = 0;
      }
    }

    if (cue.fade === false) {
      // Snap mode: reveal state is binary
      rt.revealed = isActive ? (rt.pixage ? rt.pixage.totalCells : 0) : 0;
      rt.revealAccumulator = rt.revealed;
    } else {
      const speed = Math.max(1, cue.fadeSpeed || 500);
      if (isActive) {
        if (rt.pixage) {
          rt.revealAccumulator += speed * dt;
          if (rt.revealAccumulator > rt.pixage.totalCells) rt.revealAccumulator = rt.pixage.totalCells;
          rt.revealed = Math.floor(rt.revealAccumulator);
        }
      } else {
        if (rt.revealAccumulator > 0) {
          rt.revealAccumulator -= speed * dt;
          if (rt.revealAccumulator < 0) rt.revealAccumulator = 0;
        }
        rt.revealed = Math.min(rt.pixage ? rt.pixage.totalCells : 0, Math.ceil(rt.revealAccumulator));
      }
    }

    rt.cueActive = isActive;
    rt.prevActive = isActive;
    if (isActive || rt.revealed > 0) anyActiveOrFading = true;
  }

  const wasCueMode = cueMode;
  cueMode = anyActiveOrFading;
  if (wasCueMode && !cueMode) {
    // Exiting cue mode: restart spawning cleanly
    baseSpawnArmed = false;
    nextBaseSpawnAt = now + (cfg.base.initialDelay || 0);
  }
}

/* =========================================================
   Letters runtime + masks (unchanged from v8)
========================================================= */
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
  updateLetterActivity(now);
}

function recomputePinnedMasks() {
  if (!activeEffect || activeEffect.type !== 'bubble' || !activeEffect.chars) return;
  for (let i = 0; i < activeEffect.chars.length; i++) {
    const c = activeEffect.chars[i];
    if (c.mode === 'pinned') lettersRuntime[i].mask = computeLetterMask(c);
  }
}

function computeLetterMask(charCfg) {
  if (!charCfg.char) return null;
  const sizePx = Math.max(1, (charCfg.size || 0) * MIN_DIM);
  const posX = (charCfg.x || 0) * W;
  const posY = charCfg.mode === 'pinned'
    ? (charCfg.y || 0) * docHeight
    : (charCfg.y || 0) * H;

  if (!_measureCanvas) {
    _measureCanvas = new OffscreenCanvas(64, 64);
    _measureCtx = _measureCanvas.getContext('2d');
  }
  _measureCtx.font = `900 ${sizePx}px 'Arial Black', Arial, sans-serif`;
  const m = _measureCtx.measureText(charCfg.char);
  const glyphW = Math.max(m.width || sizePx, sizePx * 0.4);
  const asc = (m.actualBoundingBoxAscent !== undefined) ? m.actualBoundingBoxAscent : sizePx * 0.8;
  const desc = (m.actualBoundingBoxDescent !== undefined) ? m.actualBoundingBoxDescent : sizePx * 0.2;
  const glyphH = Math.max(asc + desc, sizePx * 0.4);

  const rotRad = (charCfg.rotation || 0) * Math.PI / 180;
  const cos = Math.abs(Math.cos(rotRad));
  const sin = Math.abs(Math.sin(rotRad));
  const aabbW = Math.ceil(glyphW * cos + glyphH * sin) + 12;
  const aabbH = Math.ceil(glyphW * sin + glyphH * cos) + 12;
  const boxSize = Math.max(aabbW, aabbH, 8);

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
  return { data, boxSize, x0: posX - boxSize / 2, y0: posY - boxSize / 2 };
}

function isInMask(mask, x, y) {
  if (!mask) return false;
  const lx = x - mask.x0, ly = y - mask.y0;
  if (lx < 0 || ly < 0 || lx >= mask.boxSize || ly >= mask.boxSize) return false;
  return mask.data[(ly | 0) * mask.boxSize + (lx | 0)] === 1;
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

function isInAnyFloatingMask(x, y) {
  for (let i = 0; i < lettersRuntime.length; i++) {
    const c = activeEffect.chars[i];
    if (!c || c.mode === 'pinned') continue;
    const rt = lettersRuntime[i];
    if (rt.mask && isInMask(rt.mask, x, y)) return true;
  }
  return false;
}

function isInAnyPinnedMask(docX, docY) {
  for (let i = 0; i < lettersRuntime.length; i++) {
    const c = activeEffect.chars[i];
    if (!c || c.mode !== 'pinned') continue;
    const rt = lettersRuntime[i];
    if (rt.mask && isInMask(rt.mask, docX, docY)) return true;
  }
  return false;
}

function bubbleAboveThreshold() {
  if (!activeEffect || activeEffect.type !== 'bubble') return false;
  const threshold = Number(activeEffect.minStarsForBubble) || 0;
  return liveCount >= threshold;
}

function pickActiveLetters() {
  const out = [];
  for (let i = 0; i < lettersRuntime.length; i++) {
    const c = activeEffect.chars[i];
    if (!c || !c.char) continue;
    if (c.mode === 'pinned') { if (lettersRuntime[i].active) out.push(i); }
    else out.push(i);
  }
  return out;
}

/* =========================================================
   Spawn paths
========================================================= */
function getFloatingSpawnPoint() {
  if (activeEffect && activeEffect.type === 'bubble' && activeEffect.beforeThresholdMode === 'avoid') {
    for (let t = 0; t < 100; t++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      if (isInAnyFloatingMask(x, y)) continue;
      if (isInAnyPinnedMask(x, y + scrollY)) continue;
      return { x, y };
    }
  }
  return { x: Math.random() * W, y: Math.random() * H };
}

function spawnFloatingStar(isBase) {
  const i = allocSlot();
  if (i < 0) return;
  const s = pool[i];
  const type = isBase ? cfg.base : cfg.spawned;
  const now = performance.now();
  const pt = getFloatingSpawnPoint();
  s.alive = true;
  s.x = pt.x / W; s.y = pt.y / H;
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
}

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
  s.x = pt.x / W;
  s.y = pt.y / docHeight;
  s.space = 'pinned';
  s.isBase = false;
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
  liveSpawnedCount++;
}

function spawnStar(isBase) {
  if (cueMode) return;
  if (bubbleAboveThreshold()) {
    const active = pickActiveLetters();
    if (active.length) {
      const idx = active[(Math.random() * active.length) | 0];
      const c = activeEffect.chars[idx];
      if (c.mode === 'pinned') { spawnPinnedStar(idx); return; }
      const rt = lettersRuntime[idx];
      const pt = randomPointInMask(rt.mask);
      if (pt) {
        const i = allocSlot();
        if (i < 0) return;
        const s = pool[i];
        const type = isBase ? cfg.base : cfg.spawned;
        const now = performance.now();
        s.alive = true;
        s.x = pt.x / W; s.y = pt.y / H;
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
    if (!wasActive && nowActive && !cueMode) {
      const budget = Math.max(0, cfg.global.maxStars - liveCount);
      const n = Math.min(burst, budget);
      for (let j = 0; j < n; j++) spawnPinnedStar(i);
    }
  }
}

/* =========================================================
   Sim step
========================================================= */
function stepSim(now, dt) {
  // Cue processing first — may flip cueMode
  stepCues(now, dt);

  // Update letter activity (may spawn catch-up bursts, skipped while cueMode)
  updateLetterActivity(now);

  // Base spawn gate (disabled during cueMode)
  if (!cueMode) {
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
  }

  // Pinned letter spawner (disabled during cueMode)
  if (!cueMode && activeEffect && activeEffect.type === 'bubble') {
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

  // Tick stars (aging, death). Reproduction disabled during cueMode.
  const tickEnd = liveTail;
  for (let k = 0; k < tickEnd; k++) {
    const i = liveIdx[k];
    const s = pool[i];
    if (!s.alive) continue;
    const type = s.isBase ? cfg.base : cfg.spawned;
    if (now >= s.deathStart + type.fadeOut * 1000) { killStar(i); continue; }
    if (!cueMode && now < s.deathStart && now >= s.nextTick) {
      s.nextTick = now + type.tickMs;
      if (cfg.spawned.enabled && liveCount < cfg.global.maxStars) {
        if (Math.random() * 100 < type.reproChance) spawnStar(false);
      }
    } else if (cueMode && now < s.deathStart && now >= s.nextTick) {
      // advance tick timer even when frozen, so we don't burst-reproduce on unfreeze
      s.nextTick = now + type.tickMs;
    }
  }

  // Compact live list
  let w = 0;
  for (let k = 0; k < liveTail; k++) {
    const i = liveIdx[k];
    if (pool[i].alive) liveIdx[w++] = i;
  }
  liveTail = w;

  // N-trigger (paused during cueMode)
  if (!cueMode && cfg.global.triggerEnabled && liveCount >= cfg.global.maxStars) {
    const c = (activeEffect && activeEffect.flashColor) ? activeEffect.flashColor : '#ffffff';
    postMsg({ type: 'flash', color: c });
    resetSim();
  }

  if (now - lastCountMsgAt > COUNT_MSG_INTERVAL) {
    lastCountMsgAt = now;
    postMsg({ type: 'count', total: liveCount, base: liveBaseCount, spawned: liveSpawnedCount });
  }
}

/* =========================================================
   Master loop
========================================================= */
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
    stepSim(now, SIM_STEP_MS / 1000);
    steps++;
  }

  renderFrame(now);
  raf(masterLoop);
}

/* =========================================================
   Sprite cache
========================================================= */
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
  const h = bucket / 2, cx = h, cy = h;
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

/* =========================================================
   Render
========================================================= */
const CULL_PAD = 32;

function renderFrame(now) {
  ctx.clearRect(0, 0, W, H);

  if (cueMode) {
    renderCues(now);
    return;
  }

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
          ctx.save(); ctx.translate(sx, sy); ctx.rotate(s.rotation * Math.PI / 180);
          ctx.drawImage(bmp, -dw / 2, -dh / 2, dw, dh); ctx.restore();
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
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(s.rotation * Math.PI / 180);
      ctx.drawImage(sprite.canvas, -bucket / 2, -bucket / 2, bucket, bucket); ctx.restore();
    } else {
      ctx.drawImage(sprite.canvas, sx - bucket / 2, sy - bucket / 2, bucket, bucket);
    }
  }

  ctx.globalAlpha = 1;
}

function renderCues(now) {
  // Cue grid stars — squares at 80% of cell size, using sampled colour.
  // Draw order = startTime order (earlier behind later).
  const sorted = cueRuntime.slice().sort((a, b) => (a.cue.startTime - b.cue.startTime));
  for (const rt of sorted) {
    if (rt.revealed <= 0 || !rt.pixage) continue;
    const cue = rt.cue;
    const pixage = rt.pixage;
    const cellPx = Math.max(2, cue.cellPx || 20);
    const fillRatio = 0.8;
    const drawSize = cellPx * fillRatio;
    const halfSize = drawSize / 2;
    const x0 = (cue.x || 0.5) * W - (pixage.w * cellPx) / 2;
    const y0 = (cue.y || 0.5) * H - (pixage.h * cellPx) / 2;
    const count = Math.min(rt.revealed, pixage.totalCells);
    const order = pixage.validCells;
    const colours = pixage.cellColours;
    for (let i = 0; i < count; i++) {
      const idx = order[i];
      const col = idx % pixage.w;
      const row = (idx / pixage.w) | 0;
      const sx = x0 + col * cellPx + cellPx / 2;
      const sy = y0 + row * cellPx + cellPx / 2;
      if (sx < -cellPx || sx > W + cellPx || sy < -cellPx || sy > H + cellPx) continue;
      ctx.fillStyle = colours[idx];
      ctx.fillRect(sx - halfSize, sy - halfSize, drawSize, drawSize);
    }
  }
}

/* =========================================================
   Image pool (image-star effect)
========================================================= */
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
    } catch (e) {}
  }
  if (!imagePool.length) postMsg({ type: 'image-status', loaded: 0, error: 'Could not load any images.' });
  else postMsg({ type: 'image-status', loaded: imagePool.length, error: null });
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
