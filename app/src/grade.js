// The colour grade. One pass over the finished collage gives it a single look instead of a patchwork of per-panel
// tints: a duotone ramp built from the palette (deep ink shadows, hot sunset highlights), split tone, an S-curve,
// a saturation lift, radial chromatic fringing, vignette and film grain. The pass is pure and takes a plain
// Uint8ClampedArray, so the same code runs on the main thread or inside the grading worker (grade-worker.js).

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const clampi = (v, n) => (v < 0 ? 0 : v >= n ? n - 1 : v | 0);

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixHex(a, b, t) {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return [ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t];
}

/** Cheap deterministic noise, so the same cover exports the same bytes every time. */
export function makeNoise(w, h, seed = 1337) {
  const out = new Float32Array(w * h);
  let s = seed | 0 || 1;
  for (let i = 0; i < out.length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = ((s & 0xffff) / 0xffff) * 2 - 1;
  }
  return out;
}

/** The palette's tone ramp: a 256-entry lookup from luma to the graded colour. */
export function buildRamp(p) {
  const stops = [
    [0.0, p.bg[2]],
    [0.16, p.shadow],
    [0.4, mixHex(p.shadow, p.leak, 0.35)],
    [0.62, p.highlight],
    [0.84, p.sun],
    [1.0, mixHex(p.sun, '#ffffff', 0.55)],
  ].map(([t, hex]) => ({ t, rgb: hexToRgb(hex) }));

  const ramp = new Float32Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const l = i / 255;
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let k = 0; k < stops.length - 1; k++) {
      if (l >= stops[k].t && l <= stops[k + 1].t) {
        a = stops[k];
        b = stops[k + 1];
        break;
      }
    }
    const span = b.t - a.t || 1;
    let t = (l - a.t) / span;
    t = t * t * (3 - 2 * t); // smoothstep, so the ramp has no visible kinks
    ramp[i * 3] = a.rgb[0] + (b.rgb[0] - a.rgb[0]) * t;
    ramp[i * 3 + 1] = a.rgb[1] + (b.rgb[1] - a.rgb[1]) * t;
    ramp[i * 3 + 2] = a.rgb[2] + (b.rgb[2] - a.rgb[2]) * t;
  }
  return ramp;
}

/**
 * Grades `data` in place.
 * opts: { palette, duotone, contrast, saturation, vignette, grain, fringe, exposure, leak, focusX, focusY,
 *         blackPoint, skyWash }
 */
export function gradePixels(data, w, h, opts = {}) {
  const p = opts.palette;
  const contrast = opts.contrast ?? 1.2;
  const sat = opts.saturation ?? 1.26;
  const vig = opts.vignette ?? 0.5;
  const grain = opts.grain ?? 0.05;
  const fringe = opts.fringe ?? 1;
  const exposure = opts.exposure ?? 1.0;
  const duo = opts.duotone ?? 0.52;
  const leakAmount = opts.leak ?? 0.2;
  const bp = opts.blackPoint ?? 0.045;

  const ramp = buildRamp(p);
  const [lr, lg, lb] = hexToRgb(p.leak);
  const [sr, sg, sb] = hexToRgb(p.shadow);
  const [hr, hg, hb] = hexToRgb(p.highlight);

  const src = fringe > 0 ? new Uint8ClampedArray(data) : null;
  const noise = grain > 0 ? makeNoise(w, h, 7919) : null;

  const cx = w * (opts.focusX ?? 0.5);
  const cy = h * (opts.focusY ?? 0.46);
  const invR = 1 / Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
  const maxShift = 2.4 * fringe;

  for (let y = 0; y < h; y++) {
    const dy = (y - cy) * invR;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = (row + x) << 2;
      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];

      // Radial chromatic fringing: red bends outward and blue inward, like a cheap wide lens.
      let dx = 0;
      let d = 0;
      if (src) {
        dx = (x - cx) * invR;
        d = Math.sqrt(dx * dx + dy * dy);
        if (d > 0.55) {
          const k = (d - 0.55) / 0.45;
          const sh = maxShift * k * k;
          if (sh >= 0.6) {
            const ox = dx * sh;
            const oy = dy * sh;
            r = src[(clampi(y + oy, h) * w + clampi(x + ox, w)) << 2];
            b = src[(clampi(y - oy, h) * w + clampi(x - ox, w)) << 2];
          }
        }
      }

      // ---- film curve on luma: crush the black point, roll the highlights, so nothing looks milky
      let luma = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
      luma = (luma - bp) / (1 - bp);
      luma = luma < 0 ? 0 : luma > 1 ? 1 : luma;
      luma = luma * luma * (3 - 2 * luma) * 0.55 + luma * 0.45; // gentle S
      const k = luma * 255;
      const denom = r * 0.2126 + g * 0.7152 + b * 0.0722;
      const scale = denom > 1 ? k / denom : 1;
      r *= scale;
      g *= scale;
      b *= scale;

      // ---- duotone: the palette's ramp over the photo, weighted so detail survives
      if (duo > 0) {
        const li = Math.min(255, Math.max(0, k | 0)) * 3;
        r += (ramp[li] - r) * duo;
        g += (ramp[li + 1] - g) * duo;
        b += (ramp[li + 2] - b) * duo;
      }

      // ---- split tone: cool the shadows, warm the highlights (keeps skin alive)
      const t = k / 255;
      const sw = (1 - t) * 0.34;
      const hw = t * 0.3;
      r += (sr - r) * sw * 0.5 + (hr - r) * hw * 0.5;
      g += (sg - g) * sw * 0.5 + (hg - g) * hw * 0.5;
      b += (sb - b) * sw * 0.5 + (hb - b) * hw * 0.5;

      // ---- hue-selective saturation: keep skin, push the sky, mute the mud
      const l2 = r * 0.2126 + g * 0.7152 + b * 0.0722;
      const warm = Math.min(1, Math.max(0, (r - b) / 90));
      const localSat = sat * (1 - warm * 0.22) + warm * 0.22 * sat * 1.12;
      r = l2 + (r - l2) * localSat;
      g = l2 + (g - l2) * localSat;
      b = l2 + (b - l2) * localSat;

      // ---- contrast about mid grey, then exposure
      r = 128 + (r - 128) * contrast;
      g = 128 + (g - 128) * contrast;
      b = 128 + (b - 128) * contrast;
      if (exposure !== 1) {
        r *= exposure;
        g *= exposure;
        b *= exposure;
      }

      // ---- peripheral fall-off: the frame edges cool and lose saturation, so the lit centre of the picture
      // (the subject) separates from the background instead of sitting on the same plane as it.
      const edge = Math.min(1, Math.max(0, (d - 0.5) / 0.75));
      if (edge > 0) {
        const cool = edge * edge * 0.3;
        r += (sr - r) * cool;
        g += (sg - g) * cool;
        b += (sb - b) * cool;
      }

      // ---- vignette, then a warm light leak bleeding in from one corner
      if (!src) {
        dx = (x - cx) * invR;
        d = Math.sqrt(dx * dx + dy * dy);
      }
      const v = 1 - vig * Math.pow(Math.min(1, Math.max(0, (d - 0.18) / 0.98)), 1.45);
      r *= v;
      g *= v;
      b *= v;

      if (leakAmount > 0) {
        const leakW = leakAmount * Math.max(0, 1 - Math.abs(d - 0.92) * 2.6) * Math.max(0, dx * 0.9 + 0.35);
        if (leakW > 0) {
          r += lr * leakW * 0.42;
          g += lg * leakW * 0.42;
          b += lb * leakW * 0.42;
        }
      }

      // ---- grain, strongest in the midtones, held back in the shadows so blacks stay clean
      if (noise) {
        const mid = 1 - Math.abs(k / 255 - 0.5) * 1.6;
        const amt = grain * 255 * Math.max(0.12, mid);
        const gv = noise[row + x] * amt;
        r += gv * 1.05;
        g += gv;
        b += gv * 0.9;
      }

      data[i] = clamp255(r);
      data[i + 1] = clamp255(g);
      data[i + 2] = clamp255(b);
    }
  }
  return data;
}

function hexA(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** The sun: a wide bloom over the whole poster, and a banded retro disc that only lands on the backdrop. */
export function drawPosterLight(ctx, w, h, p, opts = {}) {
  const u = Math.min(w, h);
  const sx = w * (opts.sunX ?? 0.74);
  const sy = h * (opts.sunY ?? 0.226);
  const rad = u * (opts.sunSize ?? 0.1);

  ctx.save();
  ctx.globalCompositeOperation = 'screen';

  const bloom = ctx.createRadialGradient(sx, sy, rad * 0.1, sx, sy, u * 0.78);
  bloom.addColorStop(0, hexA(p.sunGlow, 0.62));
  bloom.addColorStop(0.2, hexA(p.sunGlow, 0.3));
  bloom.addColorStop(0.52, hexA(p.leak, 0.1));
  bloom.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = bloom;
  ctx.fillRect(0, 0, w, h);

  // A hard disc printed on top of someone's photograph reads as a blown blob, not a sun. The disc is punched out
  // of the panels so it can only ever land on the backdrop between them.
  const rects = opts.rects;
  if (rects && rects.length) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    rects.forEach((r) => ctx.rect(r.x, r.y, r.w, r.h));
    ctx.clip('evenodd');
  }

  const disc = document.createElement('canvas');
  const side = Math.ceil(rad * 2);
  disc.width = side;
  disc.height = side;
  const dctx = disc.getContext('2d');
  const dd = dctx.createRadialGradient(rad, rad, 0, rad, rad, rad);
  dd.addColorStop(0, hexA('#fff8e8', 1));
  dd.addColorStop(0.52, hexA(p.sun, 0.9));
  dd.addColorStop(0.85, hexA(p.sunGlow, 0.45));
  dd.addColorStop(1, 'rgba(0,0,0,0)');
  dctx.fillStyle = dd;
  dctx.fillRect(0, 0, side, side);

  // Classic retro sun: the disc is cut by growing horizontal bands, punched out of its own layer.
  dctx.globalCompositeOperation = 'destination-out';
  const bands = 5;
  for (let i = 0; i < bands; i++) {
    const t = i / (bands - 1);
    const bh = rad * (0.03 + t * 0.07);
    const by = rad * (1.24 + t * 0.42);
    dctx.fillStyle = `rgba(0,0,0,${0.62 + t * 0.3})`;
    dctx.fillRect(0, by, side, bh);
  }
  ctx.drawImage(disc, sx - rad, sy - rad);

  // A horizontal streak across the sun.
  const streak = ctx.createLinearGradient(0, sy, w, sy);
  streak.addColorStop(0, 'rgba(0,0,0,0)');
  streak.addColorStop(0.5, hexA(p.sun, 0.14));
  streak.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = streak;
  ctx.fillRect(0, sy - u * 0.01, w, u * 0.02);

  if (rects && rects.length) ctx.restore();

  // Horizon band: light pooling where the lettering will sit.
  const horizon = ctx.createLinearGradient(0, h * 0.38, 0, h);
  horizon.addColorStop(0, 'rgba(0,0,0,0)');
  horizon.addColorStop(0.5, hexA(p.sunGlow, 0.12));
  horizon.addColorStop(0.8, hexA(p.leak, 0.22));
  horizon.addColorStop(1, hexA(p.shadow, 0.34));
  ctx.fillStyle = horizon;
  ctx.fillRect(0, h * 0.38, w, h * 0.62);
  ctx.restore();
}

/**
 * Darkens the foot of the poster so the caption always has something to sit on. The shade is confined to the
 * column the type lives in and feathers out at its edge — a full-width bar would drop a black stripe across the
 * face of whoever is in the right-hand panels, which is exactly what a collage can't afford.
 */
export function drawScrim(ctx, w, h, p, opts = {}) {
  const start = opts.start ?? 0.52;
  const width = Math.min(w, opts.width ?? w);
  const feather = Math.min(width * 0.55, Math.min(w, h) * 0.28);
  const y = h * start;
  const height = h - y;
  if (width <= 0 || height <= 0) return;

  const layer = document.createElement('canvas');
  layer.width = Math.max(1, Math.ceil(width));
  layer.height = Math.max(1, Math.ceil(height));
  const lctx = layer.getContext('2d');

  const g = lctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.42, hexA(p.key, 0.4));
  g.addColorStop(0.74, hexA(p.key, 0.76));
  g.addColorStop(1, hexA(p.key, 0.95));
  lctx.fillStyle = g;
  lctx.fillRect(0, 0, layer.width, layer.height);

  if (width < w - 1) {
    lctx.globalCompositeOperation = 'destination-out';
    const fg = lctx.createLinearGradient(width - feather, 0, width, 0);
    fg.addColorStop(0, 'rgba(0,0,0,0)');
    fg.addColorStop(1, 'rgba(0,0,0,1)');
    lctx.fillStyle = fg;
    lctx.fillRect(0, 0, layer.width, layer.height);
  }

  ctx.save();
  ctx.drawImage(layer, 0, y);
  ctx.restore();
}

/** A 1px rim of light on the top-left of a panel: the poster's cut-paper edge. */
export function drawPanelEdge(ctx, rect, p, scale) {
  ctx.save();
  const px = Math.max(1, Math.round(scale * 1.4));
  const g = ctx.createLinearGradient(rect.x, rect.y, rect.x + rect.w * 0.6, rect.y + rect.h * 0.7);
  g.addColorStop(0, hexA(p.rim, 0.42));
  g.addColorStop(0.45, hexA(p.rim, 0.08));
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.strokeStyle = g;
  ctx.lineWidth = px;
  ctx.strokeRect(rect.x + px / 2, rect.y + px / 2, rect.w - px, rect.h - px);
  ctx.restore();
}

/** Halftone dot field, used sparingly in the empty gutter of the backdrop. */
export function drawHalftone(ctx, x, y, w, h, colour, spacing, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = colour;
  const r = spacing * 0.27;
  for (let yy = y; yy < y + h; yy += spacing) {
    for (let xx = x; xx < x + w; xx += spacing) {
      ctx.beginPath();
      ctx.arc(xx, yy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}
