// The editor: owns the document state, keeps a live preview in step with it, and wires the pointer, wheel, drag,
// keyboard and export handling. The preview and the export run through the same renderer, so what is on screen is
// what comes out of the PNG.
//
// Screenshot hooks: `?shot=cover` (the poster alone, full bleed), `?shot=editor` (the studio with a photo loaded),
// plus `photo`, `caption` (lines separated by |), `subtitle`, `grid`, `palette`, `size`. window.__shotReady is set
// once the poster has actually been painted, and window.__app exposes a small API for scripted checks.

import { PALETTES, PALETTE_IDS, SIZES, GRIDS, sizeById, panelRects, clampCentre } from './layout.js';
import { composeCover, renderCover, toPng, colourGrade, paintPoster, finishPoster, inkPoster } from './render.js';

const SAMPLES = ['pier', 'boulevard'];
const MAX_PIXELS = 2600; // photos are downsampled past this, so drags stay light and memory stays sane

/**
 * When one photo is asked to fill several panels, the frames get different crops and a different push in the
 * grade. Otherwise a "collage" reads as one picture with lines drawn on top of it, which is the failure mode of
 * every copycat cover maker.
 */
// Crop plans vary zoom and tone, never the framing point: a panel whose centre is undefined gets the automatic
// top-biased crop below. Yanks to cx/cy were what decapitated portraits — the frame is short enough on a square
// panel from a tall photo that centring cuts the head in half.
const CROP_PLAN = [
  { zoom: 1, tone: 0 },
  { zoom: 1.22, tone: 0.04 },
  { zoom: 1.5, tone: -0.05 },
  { zoom: 1.34, tone: 0.07 },
  { zoom: 1.12, tone: -0.03 },
  { zoom: 1.6, tone: 0.05 },
];

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- state */

const state = {
  photos: [], // { id, img, w, h, url, name }
  panels: [], // { photoId, cx, cy, zoom, tone }
  grid: 'solo',
  palette: 'sunset',
  sizeId: '1080x1080',
  caption: 'VICE\nCITY',
  subtitle: 'A story of two cities',
  tracking: -0.005,
  inline: true,
  selected: 0,
  dragging: false,
};

let nextId = 1;
let previewToken = 0;
let idleTimer = 0;
let fontReady = false;
let exporting = false;
let lastBlobUrl = null;

/** The panels a grid needs, each pointing at a real photo where one exists. */
function ensurePanels() {
  const need = (GRIDS.find((g) => g.id === state.grid) ?? GRIDS[0]).panels;
  const lead = state.photos[0]?.id ?? null;
  const grew = state.panels.length < need;
  while (state.panels.length < need) {
    const i = state.panels.length;
    const pick = state.photos[i] ?? state.photos[0] ?? null;
    const plan = CROP_PLAN[i % CROP_PLAN.length];
    state.panels.push({ photoId: pick?.id ?? lead, cx: null, cy: null, zoom: plan.zoom, tone: plan.tone });
  }
  if (state.panels.length > need) state.panels.length = need;
  state.panels.forEach((p, i) => {
    if (!state.photos.some((ph) => ph.id === p.photoId)) p.photoId = state.photos[Math.min(i, state.photos.length - 1)]?.id ?? null;
  });
  if (grew) varyRepeats();
  if (state.selected >= need) state.selected = 0;
}

/**
 * If several frames ended up on the same photo, give each of them the plan's own crop, so the wall looks
 * composed rather than stamped. Panels the user has already touched are left alone.
 */
function varyRepeats(force = false) {
  const count = new Map();
  state.panels.forEach((p) => count.set(p.photoId, (count.get(p.photoId) ?? 0) + 1));
  state.panels.forEach((p, i) => {
    if (!force && p.touched) return;
    if ((count.get(p.photoId) ?? 0) < 2) return;
    const plan = CROP_PLAN[i % CROP_PLAN.length];
    p.cx = null;
    p.cy = null;
    p.zoom = plan.zoom;
    p.tone = plan.tone;
  });
}


function photoFor(panel) {
  return state.photos.find((p) => p.id === panel.photoId) ?? null;
}

/** The render description for the current document at a given pixel size. */
function specAt(w, h) {
  return {
    w,
    h,
    grid: state.grid,
    palette: state.palette,
    panels: state.panels.map((p) => {
      const ph = photoFor(p);
      return { image: ph?.img ?? null, cx: p.cx, cy: p.cy, zoom: p.zoom, tone: p.tone };
    }),
    lines: captionLines(),
    subtitle: state.subtitle,
    credits: 'AN ORIGINAL POSTER',
    tracking: state.tracking,
    inline: state.inline,
    grain: 0.09,
    showSun: true,
    showBand: true,
  };
}

function captionLines() {
  return state.caption
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((l) => l.toUpperCase());
}

/* ---------------------------------------------------------------- photos */

function downscale(bitmap) {
  const w = bitmap.width;
  const h = bitmap.height;
  const big = Math.max(w, h);
  if (big <= MAX_PIXELS) return { img: bitmap, w, h };
  const k = MAX_PIXELS / big;
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, cw, ch);
  return { img: c, w: cw, h: ch };
}

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return downscale(bmp);
    } catch {
      /* Safari and some formats: fall through to an <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    return { ...downscale(img), url };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not read ${url}`));
    img.src = url;
  });
}

async function addFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith('image/'));
  if (!list.length) {
    toast('Those are not image files', true);
    return;
  }
  let added = 0;
  for (const file of list) {
    try {
      const { img, w, h, url } = await decode(file);
      const id = nextId++;
      state.photos.push({ id, img, w, h, url: url ?? '', name: file.name || `photo-${id}` });
      added++;
    } catch {
      toast(`${file.name || 'That file'} could not be decoded`, true);
    }
  }
  if (!added) return;
  // A fresh photo takes the selected panel; a first photo takes them all; extra photos spread across the wall.
  if (state.photos.length === added) {
    ensurePanels();
    state.panels.forEach((p, i) => {
      const pick = state.photos[i] ?? state.photos[0];
      p.photoId = pick.id;
    });
  } else {
    const sel = state.panels[state.selected];
    if (sel) sel.photoId = state.photos[state.photos.length - 1].id;
    ensurePanels();
  }
  renderThumbs();
  updateNote();
  invalidate();
  setStatus(`${state.photos.length} photo${state.photos.length > 1 ? 's' : ''} ready`);
}

function removePhoto(i) {
  const gone = state.photos[i];
  state.photos.splice(i, 1);
  const lead = state.photos[0]?.id ?? null;
  state.panels.forEach((p) => {
    if (p.photoId === gone.id) p.photoId = lead;
  });
  renderThumbs();
  updateNote();
  invalidate();
}

function updateNote() {
  renderThumbs();
}

async function loadSample(which = SAMPLES[Math.floor(Math.random() * SAMPLES.length)]) {
  const name = Array.isArray(which) ? which[0] : which;
  try {
    const img = await loadImage(`./samples/${name}.jpg`);
    state.photos.push({ id: nextId++, img, w: img.naturalWidth, h: img.naturalHeight, url: `./samples/${name}.jpg`, name });
    ensurePanels();
    state.panels.forEach((p, i) => {
      p.photoId = (state.photos[i] ?? state.photos[0]).id;
    });
    renderThumbs();
    updateNote();
    invalidate();
    setStatus('Sample loaded — pick a grid and type a caption');
  } catch {
    toast('Sample photo missing', true);
  }
}

/* ---------------------------------------------------------------- preview */

let previewCanvas;
let previewWrap;

/** Preview resolution: long side near 900px, which is plenty on screen and cheap to grade. */
function previewDims(size) {
  const long = 900;
  const k = long / Math.max(size.w, size.h);
  return { w: Math.max(2, Math.round(size.w * k)), h: Math.max(2, Math.round(size.h * k)) };
}

/**
 * Redraws the preview. `fast` skips the pixel grade (used mid-drag, where only the paint pass can keep up); the
 * settled frame is always the fully graded one.
 */
async function paint({ fast = false } = {}) {
  const token = ++previewToken;
  const size = sizeById(state.sizeId);
  const dims = previewDims(size);
  const spec = specAt(dims.w, dims.h);
  paintPoster(previewCanvas, spec);
  if (!fast) {
    await colourGrade(previewCanvas, spec, null);
    if (token !== previewToken) return; // a newer frame won
  }
  finishPoster(previewCanvas, spec);
  inkPoster(previewCanvas, spec);
  paintHits(size);
  window.__painted = (window.__painted ?? 0) + 1;
}

function schedulePaint(fast = false) {
  clearTimeout(idleTimer);
  if (fast) {
    paint({ fast: true });
    idleTimer = setTimeout(() => paint(), 170);
  } else {
    idleTimer = setTimeout(() => paint(), 12);
  }
}

function invalidate() {
  schedulePaint(false);
}

/** The click targets that sit over the poster: one absolutely positioned box per panel. */
function paintHits(size) {
  const layer = $('hitlayer');
  if (!layer) return;
  const rects = panelRects(state.grid, size.w, size.h);
  const existing = layer.children.length === rects.length;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    let el = layer.children[i];
    if (!existing || !el) {
      el = document.createElement('div');
      el.className = 'hit';
      el.dataset.panel = String(i);
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = `P${i + 1}`;
      el.appendChild(tag);
      layer.appendChild(el);
    }
    el.style.left = `${(r.x / size.w) * 100}%`;
    el.style.top = `${(r.y / size.h) * 100}%`;
    el.style.width = `${(r.w / size.w) * 100}%`;
    el.style.height = `${(r.h / size.h) * 100}%`;
    el.classList.toggle('selected', i === state.selected);
  }
  while (layer.children.length > rects.length) layer.lastChild.remove();
}

/* ---------------------------------------------------------------- gesture handling */

function panelRectCss(wrap, index) {
  const size = sizeById(state.sizeId);
  const r = panelRects(state.grid, size.w, size.h)[index];
  const k = wrap.clientWidth / size.w;
  return { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k, k };
}

/** The framing point a panel actually renders at, resolving the automatic top-biased crop. */
function centreOf(panel, rect, ph) {
  const base = Math.max(rect.w / ph.w, rect.h / ph.h) * (panel.zoom || 1);
  const dw = ph.w * base;
  const dh = ph.h * base;
  const halfW = Math.min(0.5, rect.w / dw / 2);
  const halfH = Math.min(0.5, rect.h / dh / 2);
  if (panel.cx == null || panel.cy == null) return { cx: 0.5, cy: halfH, dw, dh };
  return {
    cx: Math.min(1 - halfW, Math.max(halfW, panel.cx)),
    cy: Math.min(1 - halfH, Math.max(halfH, panel.cy)),
    dw,
    dh,
  };
}

/** Moves a panel's crop by a screen-space delta, in export pixels. */
function panPanel(index, dxCss, dyCss, wrap) {
  const size = sizeById(state.sizeId);
  const rect = panelRects(state.grid, size.w, size.h)[index];
  const panel = state.panels[index];
  const ph = photoFor(panel);
  if (!ph) return;
  const k = wrap.clientWidth / size.w;
  const { cx, cy, dw, dh } = centreOf(panel, rect, ph);
  panel.cx = cx - dxCss / k / dw;
  panel.cy = cy - dyCss / k / dh;
  panel.touched = true;
  clampCentre(panel, rect, ph);
}

/** Zooms a panel about a point given in the panel's local CSS space. */
function zoomPanel(index, factor, localX, localY, wrap) {
  const size = sizeById(state.sizeId);
  const rect = panelRects(state.grid, size.w, size.h)[index];
  const panel = state.panels[index];
  const ph = photoFor(panel);
  if (!ph) return;
  const k = wrap.clientWidth / size.w;
  const rw = rect.w * k;
  const rh = rect.h * k;
  const start = centreOf(panel, rect, ph);
  const dx = rw / 2 - start.dw * k * start.cx;
  const dy = rh / 2 - start.dh * k * start.cy;
  const px = (localX - dx) / (start.dw * k); // photo-space point under the cursor
  const py = (localY - dy) / (start.dh * k);

  const before = panel.zoom || 1;
  panel.zoom = Math.min(6, Math.max(1, before * factor));

  const base2 = Math.max(rect.w / ph.w, rect.h / ph.h) * panel.zoom;
  const dw2 = ph.w * base2 * k;
  const dh2 = ph.h * base2 * k;
  panel.cx = (rw / 2 - (localX - px * dw2)) / dw2;
  panel.cy = (rh / 2 - (localY - py * dh2)) / dh2;
  panel.touched = true;
  clampCentre(panel, rect, ph);
  showZoom(panel.zoom);
}

function showZoom(z) {
  const hud = $('zoomhud');
  const val = $('zoomval');
  if (!hud || !val) return;
  hud.hidden = false;
  val.textContent = `${Math.round(z * 100)}%`;
  clearTimeout(showZoom.t);
  showZoom.t = setTimeout(() => {
    hud.hidden = true;
  }, 1100);
}

function bindGestures() {
  const layer = $('hitlayer');
  const pointers = new Map();
  let drag = null;
  let pinch = null;

  layer.addEventListener('pointerdown', (e) => {
    const hit = e.target.closest('.hit');
    if (!hit) return;
    const index = Number(hit.dataset.panel);
    state.selected = index;
    paintHits(sizeById(state.sizeId));
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    hit.setPointerCapture(e.pointerId);
    if (pointers.size === 1) {
      drag = { index, x: e.clientX, y: e.clientY, moved: 0 };
      state.dragging = false;
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { index, dist: Math.hypot(a.x - b.x, a.y - b.y) };
      drag = null;
    }
    e.preventDefault();
  });

  layer.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.dist > 0) {
        const rect = layer.getBoundingClientRect();
        const mx = (a.x + b.x) / 2 - rect.left;
        const my = (a.y + b.y) / 2 - rect.top;
        zoomPanel(pinch.index, dist / pinch.dist, mx, my, layer);
        pinch.dist = dist;
        schedulePaint(true);
      }
      return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (drag.moved > 2) state.dragging = true;
    panPanel(drag.index, dx, dy, layer);
    drag.x = e.clientX;
    drag.y = e.clientY;
    schedulePaint(true);
  });

  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      drag = null;
      state.dragging = false;
      schedulePaint(false);
    }
  };
  layer.addEventListener('pointerup', end);
  layer.addEventListener('pointercancel', end);
  layer.addEventListener('lostpointercapture', end);

  layer.addEventListener(
    'wheel',
    (e) => {
      const hit = e.target.closest('.hit');
      if (!hit) return;
      e.preventDefault();
      const index = Number(hit.dataset.panel);
      const rect = layer.getBoundingClientRect();
      const pr = panelRectCss(layer, index);
      const factor = Math.exp(-e.deltaY * 0.0016);
      zoomPanel(index, factor, e.clientX - rect.left - pr.x, e.clientY - rect.top - pr.y, layer);
      state.selected = index;
      paintHits(sizeById(state.sizeId));
      schedulePaint(true);
    },
    { passive: false },
  );

  layer.addEventListener('dblclick', (e) => {
    const hit = e.target.closest('.hit');
    if (!hit) return;
    const index = Number(hit.dataset.panel);
    if (e.shiftKey) {
      const p = state.panels[index];
      p.cx = 0.5;
      p.cy = 0.5;
      p.zoom = 1;
    } else {
      swapPanels(index, (index + 1) % state.panels.length);
    }
    schedulePaint(false);
  });

  // Drag a thumbnail onto a panel to place that photo there.
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('text/plain')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  layer.addEventListener('drop', (e) => {
    const hit = e.target.closest('.hit');
    const id = Number(e.dataTransfer?.getData('text/plain'));
    if (!hit || !id) return;
    e.preventDefault();
    assignPhoto(Number(hit.dataset.panel), id);
  });
}

function swapPanels(a, b) {
  if (a === b) return;
  const A = state.panels[a];
  const B = state.panels[b];
  if (!A || !B) return;
  const t = { photoId: A.photoId, cx: A.cx, cy: A.cy, zoom: A.zoom };
  A.photoId = B.photoId;
  A.cx = B.cx;
  A.cy = B.cy;
  A.zoom = B.zoom;
  B.photoId = t.photoId;
  B.cx = t.cx;
  B.cy = t.cy;
  B.zoom = t.zoom;
  renderThumbs();
}

function assignPhoto(index, id) {
  const panel = state.panels[index];
  if (!panel) return;
  panel.photoId = id;
  panel.cx = 0.5;
  panel.cy = 0.5;
  panel.zoom = 1;
  state.selected = index;
  renderThumbs();
  schedulePaint(false);
}

/* ---------------------------------------------------------------- controls */

function renderGridPicker() {
  const host = $('gridpick');
  host.innerHTML = '';
  for (const g of GRIDS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.role = 'radio';
    b.setAttribute('aria-checked', String(g.id === state.grid));
    b.className = g.id === state.grid ? 'on' : '';
    b.title = g.note;
    b.innerHTML = `<span class="diag" style="${diagStyle(g.id)}">${diagCells(g.id)}</span>${g.name}`;
    b.addEventListener('click', () => {
      state.grid = g.id;
      ensurePanels();
      renderGridPicker();
      renderThumbs();
      paintHits(sizeById(state.sizeId));
      invalidate();
    });
    host.appendChild(b);
  }
}

function diagStyle(id) {
  if (id === 'triptych') return 'grid-template-columns:1.55fr 1fr;grid-template-rows:1fr 1fr';
  if (id === 'quad') return 'grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr';
  if (id === 'wall') return 'grid-template-columns:.95fr 1.25fr;grid-template-rows:1.2fr 1fr';
  return 'grid-template-columns:1fr;grid-template-rows:1fr';
}

function diagCells(id) {
  const n = id === 'solo' ? 1 : id === 'triptych' ? 3 : 4;
  let html = '';
  if (id === 'triptych') html = '<i class="cell" style="grid-row:1/3"></i><i class="cell"></i><i class="cell"></i>';
  else html = '<i class="cell"></i>'.repeat(n);
  return html;
}

function renderSwatches() {
  const host = $('swatches');
  host.innerHTML = '';
  for (const id of PALETTE_IDS) {
    const p = PALETTES[id];
    const b = document.createElement('button');
    b.type = 'button';
    b.role = 'radio';
    b.className = `swatch${id === state.palette ? ' on' : ''}`;
    b.style.background = `linear-gradient(150deg, ${p.highlight}, ${p.leak} 45%, ${p.bg[0]})`;
    b.innerHTML = `<b>${p.name}</b>`;
    b.setAttribute('aria-checked', String(id === state.palette));
    b.title = p.name;
    b.addEventListener('click', () => {
      state.palette = id;
      renderSwatches();
      invalidate();
    });
    host.appendChild(b);
  }
}

function renderSizes() {
  const host = $('sizes');
  host.innerHTML = '';
  for (const s of SIZES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.role = 'radio';
    b.className = s.id === state.sizeId ? 'on' : '';
    b.setAttribute('aria-checked', String(s.id === state.sizeId));
    b.innerHTML = `<b>${s.name}</b>${s.note}`;
    b.addEventListener('click', () => {
      state.sizeId = s.id;
      renderSizes();
      applyRatio();
      paintHits(sizeById(state.sizeId));
      invalidate();
    });
    host.appendChild(b);
  }
}

function applyRatio() {
  const size = sizeById(state.sizeId);
  const ratio = size.w === size.h ? 'square' : size.w > size.h ? 'wide' : 'portrait';
  previewWrap.dataset.ratio = ratio;
  const label = `${size.w} × ${size.h}`;
  $('dims').textContent = `${label} · ${size.w === size.h ? '1:1' : size.w > size.h ? '16:9' : '4:5'}`;
  $('export-note').textContent = label;
  $('btn-export').textContent = 'Export PNG';
}

function renderThumbs() {
  const host = $('thumbs');
  host.innerHTML = '';
  const sel = state.panels[state.selected];
  state.photos.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `thumb${sel && sel.photoId === p.id ? ' active' : ''}`;
    b.title = `${p.name} — click to place in panel ${state.selected + 1}, drag onto a panel`;
    b.draggable = true;
    b.style.backgroundImage = `url(${p.url || ''})`;
    b.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(p.id));
      e.dataTransfer.effectAllowed = 'copy';
    });
    b.addEventListener('click', () => assignPhoto(state.selected, p.id));
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      removePhoto(i);
    });
    b.appendChild(x);
    host.appendChild(b);
  });
  const panelCount = state.panels.length;
  const used = new Set(state.panels.map((p) => p.photoId)).size;
  $('photo-note').textContent = state.photos.length
    ? `${state.photos.length} photo${state.photos.length > 1 ? 's' : ''} · ${used} in use across ${panelCount} panel${panelCount > 1 ? 's' : ''}. Click a panel, then a thumbnail, to place a photo.`
    : 'Drop a photo, use the sample, or paste from the clipboard. Everything is read locally in your browser.';
}

function setStatus(text, hot = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('hot', hot);
}

let toastTimer = 0;
function toast(text, err = false) {
  const el = $('toast');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  el.classList.toggle('err', err);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

/* ---------------------------------------------------------------- export */

async function exportPng() {
  if (exporting) return;
  if (!state.photos.length) {
    toast('Add a photo first', true);
    return;
  }
  exporting = true;
  const size = sizeById(state.sizeId);
  const btn = $('btn-export-2');
  btn.classList.add('busy');
  setStatus('Rendering…', true);
  const t0 = performance.now();
  try {
    const canvas = document.createElement('canvas');
    const spec = specAt(size.w, size.h);
    await composeCover(spec, canvas, (v) => {
      setStatus(`Grading ${Math.round(v * 100)}%`, true);
    });
    setStatus('Encoding PNG…', true);
    const blob = await toPng(canvas);
    const name = `vice-cut-${size.w}x${size.h}.png`;
    if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
    lastBlobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = lastBlobUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    const ms = Math.round(performance.now() - t0);
    setStatus(`Saved ${name} · ${(blob.size / 1024).toFixed(0)} KB · ${ms} ms`);
    toast(`${name} — ${size.w} × ${size.h} · ${ms} ms`);
    window.__lastExport = { w: canvas.width, h: canvas.height, bytes: blob.size, ms, type: blob.type };
  } catch (error) {
    setStatus('Export failed', true);
    toast(String(error.message || error), true);
    window.__lastExport = { error: String(error.message || error) };
  } finally {
    exporting = false;
    btn.classList.remove('busy');
  }
}

/* ---------------------------------------------------------------- keyboard */

function bindKeys() {
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    const n = state.panels.length;
    if (/^[1-4]$/.test(e.key)) {
      state.selected = Math.min(n - 1, Number(e.key) - 1);
      paintHits(sizeById(state.sizeId));
      e.preventDefault();
      return;
    }
    if (e.key === 'Tab') {
      state.selected = (state.selected + (e.shiftKey ? n - 1 : 1)) % n;
      paintHits(sizeById(state.sizeId));
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const step = e.shiftKey ? 24 : 6;
      const dx = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0;
      const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
      panPanel(state.selected, dx, dy, $('hitlayer'));
      schedulePaint(false);
      e.preventDefault();
      return;
    }
    if (e.key === '+' || e.key === '=') {
      zoomPanel(state.selected, 1.08, 0, 0, $('hitlayer'));
      schedulePaint(false);
      e.preventDefault();
      return;
    }
    if (e.key === '-' || e.key === '_') {
      zoomPanel(state.selected, 1 / 1.08, 0, 0, $('hitlayer'));
      schedulePaint(false);
      e.preventDefault();
      return;
    }
    if (e.key === 'e' || (e.key === 'E' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      exportPng();
      return;
    }
    if (e.key === 'g') {
      const i = GRIDS.findIndex((g) => g.id === state.grid);
      state.grid = GRIDS[(i + 1) % GRIDS.length].id;
      ensurePanels();
      renderGridPicker();
      renderThumbs();
      paintHits(sizeById(state.sizeId));
      invalidate();
      e.preventDefault();
      return;
    }
    if (e.key === 'p') {
      const i = PALETTE_IDS.indexOf(state.palette);
      state.palette = PALETTE_IDS[(i + 1) % PALETTE_IDS.length];
      renderSwatches();
      invalidate();
      e.preventDefault();
      return;
    }
    if (e.key === 'x') {
      swapPanels(state.selected, (state.selected + 1) % n);
      schedulePaint(false);
      e.preventDefault();
      return;
    }
    if (e.key === 'r') {
      const p = state.panels[state.selected];
      if (p) {
        p.cx = 0.5;
        p.cy = 0.5;
        p.zoom = 1;
        schedulePaint(false);
      }
      e.preventDefault();
    }
  });
}

/* ---------------------------------------------------------------- boot */

async function boot() {
  previewCanvas = $('preview');
  previewWrap = document.querySelector('.poster-wrap');

  const drop = $('drop');
  const file = $('file');
  drop.addEventListener('click', () => file.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      file.click();
    }
  });
  file.addEventListener('change', () => {
    addFiles(file.files);
    file.value = '';
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, () => drop.classList.remove('over')),
  );
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) {
      e.preventDefault();
      addFiles(e.dataTransfer.files);
    }
  });
  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) addFiles(files);
  });

  $('btn-sample').addEventListener('click', () => loadSample());
  $('btn-reset').addEventListener('click', () => {
    state.panels.forEach((p) => {
      p.cx = 0.5;
      p.cy = 0.5;
      p.zoom = 1;
    });
    invalidate();
    toast('Crops centred');
  });
  $('btn-export').addEventListener('click', exportPng);
  $('btn-export-2').addEventListener('click', exportPng);
  $('btn-random').addEventListener('click', () => {
    const others = PALETTE_IDS.filter((p) => p !== state.palette);
    state.palette = others[Math.floor(Math.random() * others.length)];
    const gs = GRIDS.filter((g) => g.id !== state.grid);
    state.grid = gs[Math.floor(Math.random() * gs.length)].id;
    state.tracking = [-0.02, -0.005, 0.01, 0.025][Math.floor(Math.random() * 4)];
    $('tracking').value = String(state.tracking * 100);
    $('tracking-out').textContent = (state.tracking * 100).toFixed(1);
    ensurePanels();
    renderGridPicker();
    renderSwatches();
    renderThumbs();
    paintHits(sizeById(state.sizeId));
    invalidate();
  });

  const caption = $('caption');
  caption.value = state.caption;
  caption.addEventListener('input', () => {
    state.caption = caption.value;
    invalidate();
  });
  const subtitle = $('subtitle');
  subtitle.value = state.subtitle;
  subtitle.addEventListener('input', () => {
    state.subtitle = subtitle.value;
    invalidate();
  });
  const tracking = $('tracking');
  tracking.value = String(state.tracking * 100);
  $('tracking-out').textContent = (state.tracking * 100).toFixed(1);
  tracking.addEventListener('input', () => {
    state.tracking = Number(tracking.value) / 100;
    $('tracking-out').textContent = (state.tracking * 100).toFixed(1);
    invalidate();
  });
  $('inline').addEventListener('change', (e) => {
    state.inline = e.target.checked;
    invalidate();
  });

  renderGridPicker();
  renderSwatches();
  renderSizes();
  applyRatio();
  ensurePanels();
  renderThumbs();
  bindGestures();
  bindKeys();

  // Screenshot scenes.
  const q = new URLSearchParams(location.search);
  const shot = q.get('shot');
  if (q.get('grid')) state.grid = GRIDS.some((g) => g.id === q.get('grid')) ? q.get('grid') : state.grid;
  if (q.get('palette')) state.palette = PALETTES[q.get('palette')] ? q.get('palette') : state.palette;
  if (q.get('size') && SIZES.some((s) => s.id === q.get('size'))) state.sizeId = q.get('size');
  if (q.get('caption')) state.caption = q.get('caption').replace(/\|/g, '\n');
  if (q.get('subtitle') !== null && q.get('subtitle') !== undefined) state.subtitle = q.get('subtitle');

  if (shot) {
    if (shot === 'cover') document.body.classList.add('shot-cover');
    else if (shot === 'plain') document.body.classList.add('shot-plain');
    $('caption').value = state.caption;
    $('subtitle').value = state.subtitle;
    const photos = (q.get('photo') ?? 'pier').split(',').filter(Boolean);
    await Promise.all(
      photos.map(async (name) => {
        try {
          const img = await loadImage(`./samples/${name}.jpg`);
          state.photos.push({ id: nextId++, img, w: img.naturalWidth, h: img.naturalHeight, url: `./samples/${name}.jpg`, name });
        } catch {
          /* a bad name just leaves the panel empty */
        }
      }),
    );
    ensurePanels();
    state.panels.forEach((p, i) => {
      const pick = state.photos[i] ?? state.photos[0];
      if (pick) p.photoId = pick.id;
    });
    // One photo across several panels gets the varied crop plan, so the wall reads as a collage.
    const spread = q.get('spread') !== '0';
    if (spread) varyRepeats(true);
    const fill = q.get('fill');
    if (fill) {
      const [x, y, z] = fill.split(',').map(Number);
      state.panels.forEach((p) => {
        if (Number.isFinite(x)) p.cx = x;
        if (Number.isFinite(y)) p.cy = y;
        if (Number.isFinite(z)) p.zoom = z;
      });
    }
    renderGridPicker();
    renderSwatches();
    renderSizes();
    applyRatio();
    renderThumbs();
    if (shot === 'cover') {
      // The poster fills the window; the canvas keeps its true export pixels and is scaled by CSS.
      const size = sizeById(state.sizeId);
      previewWrap.style.width = '100vw';
      previewWrap.style.height = '100vh';
      previewCanvas.width = size.w;
      previewCanvas.height = size.h;
      const spec = { ...specAt(size.w, size.h), useWorker: false };
      paintPoster(previewCanvas, spec);
      await colourGrade(previewCanvas, spec, null);
      finishPoster(previewCanvas, spec);
      inkPoster(previewCanvas, spec);
      paintHits(size);
    } else {
      await paint();
    }
    window.__shotReady = false;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        window.__shotReady = true;
        document.documentElement.dataset.ready = '1';
      }),
    );
    return;
  }

  // Nothing loaded yet: paint an empty poster so the stage is never blank, then invite a photo.
  await paint();
  window.__app = {
    loadSample,
    addFiles,
    exportPng,
    state,
    specAt,
    renderAt: async (w, h) => {
      const c = document.createElement('canvas');
      await composeCover(specAt(w, h), c, null);
      return c;
    },
  };
}

function ready() {
  // The display face has to be in before the first measurement, or the caption lays out in a fallback and jumps.
  const fonts = document.fonts;
  const loads = [
    fonts.load('400 100px Anton'),
    fonts.load('600 20px "Barlow Condensed"'),
    fonts.load('700 20px "Barlow Condensed"'),
  ];
  Promise.allSettled(loads).then(() => {
    fontReady = true;
    boot().catch((e) => {
      console.error(e && e.stack ? e.stack : e);
      setStatus('Startup failed', true);
    });
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
else ready();
