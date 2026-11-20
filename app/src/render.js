// The cover renderer. It paints a poster at an exact pixel size from a plain description, in two passes:
//
//   paintPoster(canvas, spec)  the photography: backdrop, panels at their crops, sun, gutters
//   colourGrade(canvas, spec)  the pixel pass over the photography only (worker when available)
//   finishPoster(canvas, spec) the ink: scrim, lettering, credit marks, film grain, vignette
//
// Lettering is drawn after the grade, so the type is never smeared by grain or dragged through the duotone. The
// preview and the export run the same three steps at different resolutions, so the preview is honest.
//
// A description is:
//   { w, h, grid, palette, panels: [{ image, cx, cy, zoom, tone }...],
//     lines: ['FIRST', 'SECOND'], subtitle, credits, showSun, showBand, tracking, inline, grain }

import { PALETTES, panelRects, captionBox, bandRect, margin } from './layout.js';
import { gradePixels, drawPosterLight, drawScrim, drawPanelEdge, drawHalftone } from './grade.js';
import { layoutCaption, drawCaption, drawBand, drawMono } from './letter.js';

function colours(p) {
  return { paper: '#f4efe6', accent: p.accent, key: p.key };
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Paints one panel: cover-fit the photo at its crop, let it bleed slightly under the gutter, add its own rim light. */
function paintPanel(ctx, rect, panel, p, scale) {
  const { image } = panel;
  const bleed = Math.max(1, scale * 1.4);
  const r = { x: rect.x - bleed, y: rect.y - bleed, w: rect.w + bleed * 2, h: rect.h + bleed * 2 };

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  ctx.fillStyle = p.bg[2];
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

  if (image) {
    const iw = image.width || image.naturalWidth;
    const ih = image.height || image.naturalHeight;
    const zoom = panel.zoom || 1;
    const base = Math.max(r.w / iw, r.h / ih) * zoom;
    const dw = iw * base;
    const dh = ih * base;
    // Clamp here, not in the editor: the visible fraction of the photo depends on the panel's aspect and the
    // canvas size, so a crop that was legal at 1080 square can expose the photo's edge at 1920x1080. The
    // renderer is the one place that always knows the final geometry.
    const halfW = Math.min(0.5, r.w / dw / 2);
    const halfH = Math.min(0.5, r.h / dh / 2);
    // A panel with no framing point of its own gets a top-aligned crop. People photograph other people, and a
    // head lives in the top third of a frame; centring a square panel cut from a tall photo slices the face in
    // half, which is the single worst thing a multi-panel cover can do.
    const auto = panel.cx == null || panel.cy == null;
    const cx = auto ? 0.5 : Math.min(1 - halfW, Math.max(halfW, panel.cx));
    const cy = auto ? halfH : Math.min(1 - halfH, Math.max(halfH, panel.cy));
    const dx = r.x + r.w / 2 - dw * cx;
    const dy = r.y + r.h / 2 - dh * cy;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, dx, dy, dw, dh);

    // Per-panel tone nudge, so a repeated photo reads as separate frames rather than one sliced image.
    if (panel.tone) {
      ctx.globalCompositeOperation = panel.tone > 0 ? 'screen' : 'multiply';
      ctx.globalAlpha = Math.abs(panel.tone) * 0.3;
      ctx.fillStyle = panel.tone > 0 ? p.sun : p.shadow;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  } else {
    // Empty panel: a woven placeholder, so the poster never shows a hole.
    const g = ctx.createLinearGradient(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
    g.addColorStop(0, p.bg[1]);
    g.addColorStop(0.5, p.bg[0]);
    g.addColorStop(1, p.bg[2]);
    ctx.fillStyle = g;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = Math.max(1, scale);
    const step = Math.max(12, Math.round(Math.min(rect.w, rect.h) * 0.09));
    for (let i = -rect.h; i < rect.w; i += step) {
      ctx.beginPath();
      ctx.moveTo(rect.x + i, rect.y + rect.h);
      ctx.lineTo(rect.x + i + rect.h, rect.y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** The backdrop behind the collage: a dusk gradient, a pool of coloured light, and a printed dot field. */
function paintBackdrop(ctx, w, h, p, scale) {
  const g = ctx.createLinearGradient(0, 0, w * 0.35, h);
  g.addColorStop(0, p.bg[0]);
  g.addColorStop(0.5, p.bg[1]);
  g.addColorStop(1, p.bg[2]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  const u = Math.min(w, h);
  const glow = ctx.createRadialGradient(w * 0.74, h * 0.2, 0, w * 0.74, h * 0.2, u * 0.95);
  glow.addColorStop(0, p.sunGlow + '66');
  glow.addColorStop(0.45, p.leak + '1c');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  drawHalftone(ctx, 0, 0, w, h, '#ffffff', Math.max(4, Math.round(u * 0.012)), 0.03);
}

/** Pass one: everything photographic. */
export function paintPoster(canvas, spec) {
  const { w, h } = spec;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  const p = PALETTES[spec.palette] ?? PALETTES.sunset;
  const scale = Math.min(w, h) / 1080;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  paintBackdrop(ctx, w, h, p, scale);

  const rects = panelRects(spec.grid, w, h);
  const panels = spec.panels ?? [];
  rects.forEach((rect, i) => {
    paintPanel(ctx, rect, panels[i] ?? {}, p, scale);
  });

  if (spec.showSun !== false) {
    drawPosterLight(ctx, w, h, p, { sunX: spec.sunX ?? 0.74, sunY: spec.sunY ?? 0.226, rects });
  }

  // Re-cut the gutters after the light. The sun is painted across the whole poster, which would otherwise wash
  // over the seams and turn a collage back into one picture with lines on it.
  if (rects.length > 1) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    rects.forEach((r) => ctx.rect(r.x, r.y, r.w, r.h));
    ctx.clip('evenodd');
    paintBackdrop(ctx, w, h, p, scale);
    ctx.restore();
  }

  rects.forEach((r) => {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,240,220,0.12)';
    ctx.lineWidth = Math.max(1, scale);
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    ctx.restore();
    drawPanelEdge(ctx, r, p, scale);
  });

  return canvas;
}

/**
 * Grades the painted canvas. `onProgress` is called with 0..1. Chooses the worker path when available; the
 * synchronous path keeps the app working when the worker or structured cloning is missing.
 */
export async function colourGrade(canvas, spec, onProgress) {
  const p = PALETTES[spec.palette] ?? PALETTES.sunset;
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
  const img = ctx.getImageData(0, 0, w, h);
  const opts = {
    palette: p,
    contrast: spec.contrast ?? 1.2,
    saturation: spec.saturation ?? 1.24,
    vignette: spec.vignette ?? 0.42,
    grain: spec.grainPixels ?? 0.045,
    fringe: spec.fringe ?? 1,
    exposure: spec.exposure ?? 1,
    leak: spec.leak ?? 0.2,
    duotone: spec.duotone ?? 0.4,
    blackPoint: spec.blackPoint ?? 0.05,
    focusX: spec.focusX ?? 0.5,
    focusY: spec.focusY ?? 0.46,
  };

  if (typeof Worker !== 'undefined' && spec.useWorker !== false) {
    try {
      const worker = new Worker(new URL('./grade-worker.js', import.meta.url), { type: 'module' });
      const out = await new Promise((resolve, reject) => {
        // A worker that never answers (a headless run can freeze worker threads) must not stall the poster. The
        // watchdog resets on every progress tick, so a slow but live grade is never cut off.
        let timer;
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => reject(new Error('grade worker timed out')), 8000);
        };
        arm();
        worker.onmessage = (e) => {
          if (e.data.type === 'progress') {
            onProgress?.(e.data.value);
            arm();
          } else if (e.data.type === 'done') {
            clearTimeout(timer);
            resolve(e.data.data);
          } else if (e.data.type === 'error') {
            clearTimeout(timer);
            reject(new Error(e.data.message));
          }
        };
        worker.onerror = (e) => {
          clearTimeout(timer);
          reject(new Error(e.message || 'grade worker failed'));
        };
        const copy = new Uint8ClampedArray(img.data);
        worker.postMessage({ type: 'grade', data: copy, w, h, opts }, [copy.buffer]);
      });
      worker.terminate();
      const clamp = new Uint8ClampedArray(out);
      ctx.putImageData(new ImageData(clamp, w, h), 0, 0);
      return canvas;
    } catch {
      /* fall through to the synchronous pass */
    }
  }
  onProgress?.(0.4);
  gradePixels(img.data, w, h, opts);
  ctx.putImageData(img, 0, 0);
  onProgress?.(1);
  return canvas;
}

/** Film grain on a tiled noise field, multiplied over the ink so it never softens the letterforms' edges. */
function drawGrain(ctx, w, h, amount, seed) {
  if (amount <= 0) return;
  const step = 3;
  const gw = Math.ceil(w / step);
  const gh = Math.ceil(h / step);
  const tiny = document.createElement('canvas');
  tiny.width = gw;
  tiny.height = gh;
  const tctx = tiny.getContext('2d');
  const img = tctx.createImageData(gw, gh);
  const d = img.data;
  let s = seed | 0 || 99;
  for (let i = 0; i < d.length; i += 4) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    const v = 128 + (((s & 0xff) / 255) * 2 - 1) * 118;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 255;
  }
  tctx.putImageData(img, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = amount;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tiny, 0, 0, gw, gh, 0, 0, gw * step, gh * step);
  ctx.restore();
}

/** Pass two: the atmospheric ink — top plate, scrim, the title's backing plate, grain, vignette, trim rule. */
export function finishPoster(canvas, spec) {
  const { w, h } = spec;
  const ctx = canvas.getContext('2d', { alpha: false });
  const p = PALETTES[spec.palette] ?? PALETTES.sunset;
  const scale = Math.min(w, h) / 1080;
  const wide = w / h > 1.35;

  // Top plate: a whisper of shade for the credit line, which otherwise drowns in a bright sky.
  const top = ctx.createLinearGradient(0, 0, 0, h * 0.19);
  top.addColorStop(0, 'rgba(8,4,12,0.5)');
  top.addColorStop(0.55, 'rgba(8,4,12,0.2)');
  top.addColorStop(1, 'rgba(8,4,12,0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, w, h * 0.19);

  // Scrim under the lettering. It stops at the panel seam: shading the right-hand photographs would black out
  // the subject's face for the sake of type that never goes there.
  const seam = spec.grid === 'triptych' ? w * 0.615 : spec.grid === 'wall' ? w * 0.575 : w;
  drawScrim(ctx, w, h, p, {
    start: spec.grid === 'solo' ? 0.5 : wide ? 0.4 : 0.55,
    width: seam,
  });

  const box = captionBox(spec.grid, w, h);
  const lines = (spec.lines ?? []).map((l) => l ?? '');
  const laid = layoutCaption(ctx, lines, box, { tracking: spec.tracking ?? 0.01 });

  // A soft ink plate behind the wordmark, sized to the block that was actually measured. Without it a black
  // keyline lands on the poster's own crushed shadows and the letterform silhouette disappears; the plate gives
  // every corner of every letter the same background. It is clipped to the type's own column, because a plate
  // that spills over the seam turns one panel's face into a dark smudge.
  if (laid.lines.length) {
    const inkW = Math.min(box.w, laid.width ?? box.w);
    const cx = box.x + inkW / 2;
    const cy = box.y + box.h / 2;
    const rx = Math.max(inkW * 0.6, box.h * 0.7);
    const ry = Math.max(box.h * 0.72, rx * 0.34);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, seam, h);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.scale(1, ry / rx);
    const plate = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    plate.addColorStop(0, hexA(p.key, 0.46));
    plate.addColorStop(0.5, hexA(p.key, 0.24));
    plate.addColorStop(1, hexA(p.key, 0));
    ctx.fillStyle = plate;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawGrain(ctx, w, h, spec.grain ?? 0.1, 4241);

  // Vignette, painted before the lettering so the corners go properly dark without eating the type.
  const vg = ctx.createRadialGradient(w / 2, h * 0.44, Math.min(w, h) * 0.2, w / 2, h * 0.44, Math.max(w, h) * 0.78);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(0.55, 'rgba(0,0,0,0.2)');
  vg.addColorStop(1, 'rgba(0,0,0,0.7)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);

  // The poster's own ink rule, inset from the trim, on all four sides.
  const inset = Math.min(w, h) * 0.021;
  ctx.strokeStyle = 'rgba(244,239,230,0.15)';
  ctx.lineWidth = Math.max(1, scale);
  ctx.strokeRect(inset, inset, w - inset * 2, h - inset * 2);

  return canvas;
}

/**
 * Pass three: the ink itself. Credit marks, the wordmark and the subtitle strip are painted after the grade,
 * grain and vignette, so they stay pure and crisp — grading them would smear the type and drag it through the
 * duotone, which is exactly what makes a cover look printed-on rather than designed.
 */
export function inkPoster(canvas, spec) {
  const { w, h } = spec;
  const ctx = canvas.getContext('2d', { alpha: false });
  const p = PALETTES[spec.palette] ?? PALETTES.sunset;
  const scale = Math.min(w, h) / 1080;
  const box = captionBox(spec.grid, w, h);
  const lines = (spec.lines ?? []).map((l) => l ?? '');

  creditMarks(ctx, w, h, scale);

  const laid = layoutCaption(ctx, lines, box, { tracking: spec.tracking ?? 0.01 });
  if (laid.lines.length) {
    drawCaption(ctx, laid, box, p, {
      align: box.align,
      valign: 'bottom',
      inline: spec.inline !== false,
      outline: spec.outline ?? 0.055,
    });
  }

  const band = bandRect(spec.grid, w, h);
  const bandText = (spec.subtitle ?? '').trim() || (spec.credits ?? '').trim();
  if (spec.showBand !== false && bandText) drawBand(ctx, bandText, band, p);

  return canvas;
}

/** The poster's small print: studio mark top-left, certificate mark top-right. */
function creditMarks(ctx, w, h, scale) {
  const u = Math.min(w, h);
  const m = margin(w, h);
  const size = Math.max(9, Math.round(u * 0.0225));
  ctx.save();
  // A hair of shadow under the small print: it lands on whatever the photo happens to be there, and white on a
  // bright sky is otherwise unreadable.
  ctx.shadowColor = 'rgba(4,2,8,0.85)';
  ctx.shadowBlur = Math.max(2, u * 0.006);
  ctx.shadowOffsetY = Math.max(1, u * 0.0016);
  drawMono(ctx, 'A MAKEFUN PICTURE', m, m + size, size, 'rgba(255,250,240,0.97)', { tracking: 0.26 });
  drawMono(ctx, 'COVER No. 6', w - m, m + size, size, 'rgba(255,250,240,0.95)', {
    tracking: 0.26,
    align: 'right',
  });
  ctx.restore();
}

/** The whole poster, ungraded, three passes: the mid-drag preview path. */
export function renderCover(canvas, spec) {
  paintPoster(canvas, spec);
  finishPoster(canvas, spec);
  inkPoster(canvas, spec);
  return canvas;
}

/** The whole poster, graded: the settled preview and the export. */
export async function composeCover(spec, canvas, onProgress) {
  const target = canvas ?? document.createElement('canvas');
  target.width = spec.w;
  target.height = spec.h;
  paintPoster(target, spec);
  onProgress?.(0.04);
  await colourGrade(target, spec, (v) => onProgress?.(0.04 + v * 0.88));
  finishPoster(target, spec);
  inkPoster(target, spec);
  onProgress?.(1);
  return target;
}

/** Encodes a canvas to a real PNG blob at its exact size. */
export function toPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))), 'image/png');
  });
}
