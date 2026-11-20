// Caption typography: heavy condensed display lines, auto-fitted to the box in both directions, balanced word
// wrapping, a deep ink outline, a vertical bevel fill, an optional inline rule and a subtitle band. The block is
// measured before it is drawn, so a caption can never overflow or clip the canvas whatever is typed.

const DISPLAY = 'Anton';
const CONDENSED = '"Barlow Condensed"';
const LEAD = 0.94;

function setFont(ctx, size, family, weight, track) {
  ctx.font = `${weight} ${size}px ${family}`;
  try {
    ctx.letterSpacing = `${(track * size).toFixed(2)}px`;
  } catch {
    /* older engines: tracking is a nicety, not the layout */
  }
}

function measure(ctx, text, size, family, weight, track) {
  setFont(ctx, size, family, weight, track);
  const m = ctx.measureText(text);
  return {
    w: m.width,
    asc: m.actualBoundingBoxAscent || size * 0.72,
    desc: m.actualBoundingBoxDescent || 0,
    // Distance from the alignment point back to the first pixel of ink. Display faces carry side bearings that
    // differ per glyph, so without this a flush-left stack looks riddled with drift.
    bearing: m.actualBoundingBoxLeft || 0,
  };
}

/** Splits `words` into `n` lines that keep the widest line as narrow as the words allow. */
function balance(words, n, width) {
  const total = words.join(' ');
  if (n <= 1 || words.length <= 1) return [total];
  const best = { width: Infinity, lines: [total] };
  const k = Math.min(n, words.length);
  const walk = (start, left, acc) => {
    if (left === 1) {
      const lines = [...acc, words.slice(start).join(' ')];
      const widest = Math.max(...lines.map((l) => width(l)));
      if (widest < best.width) {
        best.width = widest;
        best.lines = lines;
      }
      return;
    }
    for (let i = start + 1; i <= words.length - left + 1; i++) {
      walk(i, left - 1, [...acc, words.slice(start, i).join(' ')]);
    }
  };
  walk(0, k, []);
  return best.lines;
}

/**
 * Works out the lines and one uniform display size for the caption block, so it fits `box` in width and height.
 * Returns the lines, the size, and the ink metrics the draw pass will use.
 */
export function layoutCaption(ctx, userLines, box, opts = {}) {
  const track = opts.tracking ?? -0.005;
  const weight = 700;
  const lines = userLines.map((l) => l.trim()).filter(Boolean).slice(0, 4);
  if (!lines.length) return { lines: [], size: 0 };

  const widest = (size, ls) => Math.max(...ls.map((l) => measure(ctx, l, size, DISPLAY, weight, track).w));
  const fits = (size, ls) => widest(size, ls) <= box.w && (ls.length - 1) * size * LEAD + size * 0.78 <= box.h;

  // A single long line reads better broken into two or three balanced lines than shrunk to a whisper.
  let chosen = lines;
  if (lines.length === 1) {
    const words = lines[0].split(/\s+/);
    if (words.length > 1) {
      const cap = box.h * 0.46;
      const one = measure(ctx, lines[0], cap, DISPLAY, weight, track).w;
      for (const n of [2, 3]) {
        if (n > words.length) break;
        const cand = balance(words, n, (l) => measure(ctx, l, cap, DISPLAY, weight, track).w);
        const two = widest(cap, cand);
        if (two < one * 0.86 && fits(cand.length === 1 ? cap : cap * 0.92, cand)) {
          chosen = cand;
          break;
        }
      }
    }
  }

  // Largest size that satisfies both the width and the height of the box.
  let lo = 6;
  let hi = box.h * 1.6;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid, chosen)) lo = mid;
    else hi = mid;
  }
  let size = Math.max(6, lo);

  // Hard floor: never draw past the box, even if the floor size itself is too wide (extreme case: one long word).
  const hardW = widest(size, chosen);
  if (hardW > box.w) size *= box.w / hardW;
  const blockH = (chosen.length - 1) * size * LEAD + size * 0.78;
  if (blockH > box.h) size *= box.h / blockH;

  return { lines: chosen, size, track, weight, lead: LEAD, width: widest(size, chosen), height: blockH };
}

/**
 * The caption fill. Mostly flat — a poster's lettering has to hold a solid silhouette — with a short sheen at the
 * foot of the caps so the letters still feel like printed ink rather than a vector fill.
 */
function bevelGradient(ctx, x, y, h, title) {
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, title.top);
  g.addColorStop(0.68, title.top);
  g.addColorStop(0.88, title.mid);
  g.addColorStop(1, title.bottom);
  return g;
}

/**
 * Draws the caption block centred in `box`, with `align` deciding whether lines share a centre or a left edge.
 * The face is a heavy condensed display cut, filled **solid** and wrapped in a thick ink keyline plus a hard
 * offset shadow: at thumbnail size a gradient fill collapses and only the keyline survives, so the keyline is
 * what actually sells the letterform silhouette.
 * Returns the ink rectangle it occupied.
 */
export function drawCaption(ctx, laid, box, palette, opts = {}) {
  const { lines, size, track, weight } = laid;
  if (!lines.length) return null;
  const align = opts.align ?? 'center';
  const ink = palette.key;
  const outline = (opts.outline ?? 0.055) * size;
  const inline = !!opts.inline;
  const family = DISPLAY;

  const metrics = lines.map((l) => measure(ctx, l, size, family, weight, track));
  const gap = size * 0.08;
  const total = metrics.reduce((s, m) => s + m.asc + m.desc, 0) + gap * (lines.length - 1);
  const top = opts.valign === 'bottom' ? box.y + box.h - total : box.y + (box.h - total) / 2;
  let y = top;
  // Flush-left in ink, not in metrics: pull each line back by its own side bearing so the first painted pixel of
  // every line lands exactly on the margin the credits and the subtitle band use.
  const anchorX = align === 'left' ? box.x + (metrics[0]?.bearing ?? 0) : box.x + box.w / 2;

  ctx.save();
  ctx.textAlign = align === 'left' ? 'left' : 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  // One gradient across the whole block, not one per line: a per-line ramp dips each word to a different depth and
  // the stack stops reading as a single lockup.
  const fill = bevelGradient(ctx, 0, top, Math.max(total, size), palette.title);

  lines.forEach((line, i) => {
    const m = metrics[i];
    const baseline = y + m.asc;
    setFont(ctx, size, family, weight, track);
    // Each line is drawn from its own ink edge, so a two-line stack is truly flush.
    const x = align === 'left' ? box.x + m.bearing : anchorX;

    // A hard offset shadow in the poster's own ink, so the letters lift off a busy photo without a soft glow.
    ctx.save();
    ctx.fillStyle = 'rgba(6, 2, 10, 0.5)';
    ctx.fillText(line, x + size * 0.045, baseline + size * 0.055);
    ctx.fillStyle = 'rgba(6, 2, 10, 0.32)';
    ctx.fillText(line, x + size * 0.022, baseline + size * 0.028);
    ctx.restore();

    // Ink keyline. This is the silhouette: thick, even, and drawn twice so the join is never ragged.
    if (outline > 0.5) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = outline * 2;
      ctx.strokeText(line, x, baseline);
      ctx.lineWidth = outline * 2.6;
      ctx.strokeText(line, x, baseline);
      ctx.lineWidth = outline * 2;
      ctx.strokeText(line, x, baseline);
    }

    // Solid fill from the shared block gradient, with the sheen only at the very foot of the caps.
    ctx.fillStyle = fill;
    ctx.fillText(line, x, baseline);

    // Optional inline rule, a hair of light inside the stroke.
    if (inline) {
      const g2 = ctx.createLinearGradient(0, baseline - m.asc, 0, baseline);
      g2.addColorStop(0, 'rgba(255,255,255,0.7)');
      g2.addColorStop(1, 'rgba(255,255,255,0.08)');
      ctx.strokeStyle = g2;
      ctx.lineWidth = Math.max(1, size * 0.009);
      ctx.strokeText(line, x, baseline);
    }
    y = baseline + m.desc + gap;
  });

  ctx.restore();
  return { x: box.x, y: top, w: box.w, h: total };
}

/** A subtitle strip: an ink plate that fades out to the right, an accent tick, and condensed letterspaced caps. */
export function drawBand(ctx, text, rect, palette, opts = {}) {
  const label = text.trim().toUpperCase();
  ctx.save();

  // The plate bleeds off the left trim and dissolves, so it reads as part of the poster's ink rather than a bar
  // pasted on top of the photo.
  const plate = ctx.createLinearGradient(rect.x, rect.y, rect.x + rect.w * 1.15, rect.y);
  plate.addColorStop(0, 'rgba(6, 3, 9, 0.94)');
  plate.addColorStop(0.72, 'rgba(6, 3, 9, 0.86)');
  plate.addColorStop(1, 'rgba(6, 3, 9, 0)');
  ctx.fillStyle = plate;
  ctx.fillRect(rect.x - rect.h * 2, rect.y, rect.w + rect.h * 2, rect.h);

  // The accent tick sits on the same left margin as the title and the corner marks; the label starts after it, so
  // the whole lower-left block shares one optical edge instead of drifting a few pixels per element.
  const tickW = Math.max(3, rect.h * 0.11);
  ctx.fillStyle = palette.accent;
  ctx.fillRect(rect.x, rect.y + rect.h * 0.1, tickW, rect.h * 0.8);
  const textX = rect.x + tickW + rect.h * 0.34;

  if (label) {
    let size = rect.h * 0.5;
    setFont(ctx, size, CONDENSED, 700, 0.2);
    const max = rect.w - (textX - rect.x) - rect.h * 0.2;
    let w = ctx.measureText(label).width;
    while (w > max && size > rect.h * 0.24) {
      size *= 0.94;
      setFont(ctx, size, CONDENSED, 700, 0.2);
      w = ctx.measureText(label).width;
    }
    ctx.fillStyle = '#fbf7f2';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(label, textX, rect.y + rect.h * 0.52);
  }
  ctx.restore();
}

/** Small letterspaced line used for the poster's credits and corner marks. */
export function drawMono(ctx, text, x, y, size, colour, opts = {}) {
  const track = opts.tracking ?? 0.22;
  ctx.save();
  setFont(ctx, size, CONDENSED, 600, track);
  ctx.fillStyle = colour;
  ctx.textAlign = opts.align ?? 'left';
  ctx.textBaseline = 'alphabetic';
  // Canvas applies the tracking after the last glyph too, so a right-aligned line sits a full track short of its
  // margin. Pull it back by exactly that amount so both corner marks share the poster's trim.
  const slack = opts.align === 'right' ? track * size : 0;
  ctx.fillText(text.toUpperCase(), x + slack, y);
  ctx.restore();
}
