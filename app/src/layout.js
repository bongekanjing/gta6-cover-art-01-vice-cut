// Panel geometry and the palette registry. Everything is expressed in the target canvas's own pixels and as
// fractions of its short side, so a 1080 square, a 1080 x 1350 portrait and a 1920 x 1080 wide poster all get the
// same optical weight.

/** How each grid lays its panels out, in reading order. */
export const GRIDS = [
  { id: 'solo', name: 'Solo', panels: 1, note: 'one full-bleed frame' },
  { id: 'triptych', name: 'Triptych', panels: 3, note: 'hero left, pair stacked right' },
  { id: 'quad', name: 'Quad', panels: 4, note: 'even 2 x 2' },
  { id: 'wall', name: 'Poster wall', panels: 4, note: 'offset 2 x 2 mosaic' },
];

/** The gutter between panels, in pixels, for a canvas of `w` x `h`. */
export function gutter(w, h) {
  return Math.max(3, Math.round(Math.min(w, h) * 0.0135));
}

/**
 * The panel rectangles for a grid, in draw order. Only these rectangles are ever covered by photography; the gaps
 * between them are the poster's own ink.
 */
export function panelRects(grid, w, h) {
  const g = gutter(w, h);
  if (grid === 'triptych') {
    const split = w * 0.615;
    const leftW = split - g / 2;
    const rightX = split + g / 2;
    const rightW = w - rightX;
    const topH = (h - g) / 2;
    return [
      { x: 0, y: 0, w: leftW, h },
      { x: rightX, y: 0, w: rightW, h: topH },
      { x: rightX, y: topH + g, w: rightW, h: h - topH - g },
    ];
  }
  if (grid === 'quad') {
    const cw = (w - g) / 2;
    const ch = (h - g) / 2;
    return [
      { x: 0, y: 0, w: cw, h: ch },
      { x: cw + g, y: 0, w: w - cw - g, h: ch },
      { x: 0, y: ch + g, w: cw, h: h - ch - g },
      { x: cw + g, y: ch + g, w: w - cw - g, h: h - ch - g },
    ];
  }
  if (grid === 'wall') {
    const cx = w * 0.575;
    const cy = h * 0.455;
    const lw = cx - g / 2;
    const rx = cx + g / 2;
    const rw = w - rx;
    const th = cy - g / 2;
    const by = cy + g / 2;
    const bh = h - by;
    return [
      { x: 0, y: 0, w: lw, h: th },
      { x: rx, y: 0, w: rw, h: th },
      { x: 0, y: by, w: lw, h: bh },
      { x: rx, y: by, w: rw, h: bh },
    ];
  }
  return [{ x: 0, y: 0, w, h }];
}

/** The poster's single text margin, in pixels, for a canvas of `w` x `h`. Everything flush-left uses it. */
export function margin(w, h) {
  return Math.min(w, h) * 0.075;
}

/**
 * Where the caption lives, and how much room it has, for a grid and canvas. The block is anchored to the lower
 * left rather than floated dead centre: a centred lockup lands on the subject's torso, while a bottom-left stack
 * leaves the face and costume intact and gives the type a single, stable margin to hang from.
 */
export function captionBox(grid, w, h) {
  const m = margin(w, h);
  const wide = w / h > 1.35;
  // The type is cut to its own column. A headline that runs across a gutter stops reading as a caption and starts
  // reading as a mistake, and on a photo grid it lands on two faces at once.
  const seam =
    grid === 'triptych' ? w * 0.615 : grid === 'wall' ? w * 0.575 : grid === 'quad' ? w * 0.5 : w;
  const limit = Math.max(w * 0.28, Math.min(w - m * 2, seam - m * 1.5));
  if (wide) return { x: m, y: h * 0.32, w: limit, h: h * 0.44, align: 'left' };
  // Starting below the half-way line keeps the headline clear of the panel seam: a title whose cap line touches
  // the gutter reads as a panel caption that overflowed, not as the poster's title.
  return { x: m, y: h * 0.545, w: limit, h: h * 0.225, align: 'left' };
}

/**
 * The band that carries the subtitle, sitting under the caption block with a clear optical gap. Its width stops at
 * the panel seam so the plate never runs under the right-hand photography.
 */
export function bandRect(grid, w, h) {
  const u = Math.min(w, h);
  const m = margin(w, h);
  const wide = w / h > 1.35;
  const seam = grid === 'triptych' ? w * 0.615 : grid === 'wall' ? w * 0.575 : w;
  const limit = Math.min(w - m, seam - m);
  if (wide) return { x: m, y: h * 0.84, w: limit, h: u * 0.056 };
  return { x: m, y: h * 0.845, w: limit, h: u * 0.05 };
}

/**
 * Palettes: a backdrop, the light that bleeds over the collage, a split tone for shadows and highlights, and the
 * colours the lettering is cut from.
 */
export const PALETTES = {
  sunset: {
    id: 'sunset',
    name: 'Sunset',
    bg: ['#2b0a34', '#7a1240', '#150610'],
    sun: '#ffd287',
    sunGlow: '#ff7a3c',
    leak: '#ff2f6d',
    shadow: '#101a3a',
    highlight: '#ffa23c',
    splitAmount: 0.55,
    rim: '#ffd9a0',
    accent: '#ffbf5e',
    key: '#120713',
    title: { top: '#fffaf0', mid: '#ffe6b8', bottom: '#ffab45', glow: '#ff3d6e' },
  },
  neon: {
    id: 'neon',
    name: 'Neon',
    bg: ['#12042c', '#43106b', '#06020f'],
    sun: '#ff8fd0',
    sunGlow: '#b93cff',
    leak: '#25f4ff',
    shadow: '#08183f',
    highlight: '#ff4fb0',
    splitAmount: 0.62,
    rim: '#a8f6ff',
    accent: '#37f0ff',
    key: '#07030f',
    title: { top: '#ffffff', mid: '#d9f7ff', bottom: '#39d8ff', glow: '#ff2bd6' },
  },
  vice: {
    id: 'vice',
    name: 'Vice',
    bg: ['#0b1c33', '#0f4a63', '#040a14'],
    sun: '#ffd9b0',
    sunGlow: '#ff8a5c',
    leak: '#ff2d95',
    shadow: '#04213a',
    highlight: '#ffb37a',
    splitAmount: 0.5,
    rim: '#ffe2c4',
    accent: '#ff6fae',
    key: '#050b14',
    title: { top: '#ffffff', mid: '#ffe0ea', bottom: '#ff5fa2', glow: '#22e3ff' },
  },
  amber: {
    id: 'amber',
    name: 'Amber',
    bg: ['#241003', '#6d3208', '#0d0502'],
    sun: '#ffcf78',
    sunGlow: '#ff8a18',
    leak: '#ff5a1f',
    shadow: '#2a1206',
    highlight: '#ffbe55',
    splitAmount: 0.45,
    rim: '#ffe6bd',
    accent: '#ffb03a',
    key: '#0d0602',
    title: { top: '#fffdf5', mid: '#ffe3a8', bottom: '#e8892a', glow: '#ff4a12' },
  },
  steel: {
    id: 'steel',
    name: 'Steel',
    bg: ['#0d1016', '#2a3442', '#05070b'],
    sun: '#dfe9f5',
    sunGlow: '#8fb6d8',
    leak: '#ff3b30',
    shadow: '#080d15',
    highlight: '#c9d8e8',
    splitAmount: 0.28,
    rim: '#e8f2ff',
    accent: '#ff3b30',
    key: '#05070a',
    title: { top: '#ffffff', mid: '#e8eef6', bottom: '#a8b8c9', glow: '#ff3b30' },
  },
};

export const PALETTE_IDS = Object.keys(PALETTES);

/** Export presets. */
export const SIZES = [
  { id: '1080x1080', w: 1080, h: 1080, name: 'Square', note: '1 : 1' },
  { id: '1080x1350', w: 1080, h: 1350, name: 'Portrait', note: '4 : 5' },
  { id: '1920x1080', w: 1920, h: 1080, name: 'Wide', note: '16 : 9' },
];

export function sizeById(id) {
  return SIZES.find((s) => s.id === id) ?? SIZES[0];
}

/** Clamps a panel's crop centre so the frame can never show the empty edge of the photo. */
export function clampCentre(panel, rect, photo) {
  const base = Math.max(rect.w / photo.w, rect.h / photo.h) * (panel.zoom || 1);
  const dw = photo.w * base;
  const dh = photo.h * base;
  const halfW = Math.min(0.5, rect.w / dw / 2);
  const halfH = Math.min(0.5, rect.h / dh / 2);
  const lo = Math.min(0.5, halfW);
  const hi = Math.max(0.5, 1 - halfW);
  const loY = Math.min(0.5, halfH);
  const hiY = Math.max(0.5, 1 - halfH);
  panel.cx = Math.min(hi, Math.max(lo, panel.cx ?? 0.5));
  // Leaving y undefined keeps the automatic top-biased framing; only a real gesture pins it.
  if (panel.cy != null) panel.cy = Math.min(hiY, Math.max(loY, panel.cy));
  return panel;
}
