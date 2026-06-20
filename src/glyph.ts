// Per-model "alive" glyph — a small, deterministic constellation of breathing
// dots, unique to each model id. Inspired by medical-os's particle mark, but at
// icon scale we autogenerate a unique mirrored shape per model (a fixed glyph
// sampled into dots reads as noise this small). One shared rAF drives every
// glyph, so a long list stays cheap; reduced-motion paints a single frame.

type Pt = { hx: number; hy: number; r: number; ph: number; sp: number; hue: number; light: number };
type Glyph = { ctx: CanvasRenderingContext2D; pts: Pt[]; s: number };

const SIZE = 30;
let registry: Glyph[] = [];
let raf = 0;
let t = 0;
const reduce =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
};

// Small, fast seeded PRNG (mulberry32) so each model's shape is stable.
const mulberry32 = (a: number) => () => {
  a = (a + 0x6d2b79f5) | 0;
  let x = Math.imul(a ^ (a >>> 15), 1 | a);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

function drawGlyph(g: Glyph) {
  const { ctx, pts, s } = g;
  ctx.clearRect(0, 0, s, s);
  for (const p of pts) {
    const x = p.hx * s + Math.cos(p.ph + t * p.sp) * 1.1;
    const y = p.hy * s + Math.sin(p.ph * 1.3 + t * p.sp) * 1.1;
    ctx.beginPath();
    ctx.arc(x, y, p.r, 0, 6.283);
    ctx.fillStyle = `hsl(${p.hue} 72% ${p.light}%)`;
    ctx.shadowBlur = 3;
    ctx.shadowColor = `hsl(${p.hue} 85% 62%)`;
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

function tick() {
  t += 0.016;
  for (const g of registry) drawGlyph(g);
  raf = registry.length ? requestAnimationFrame(tick) : 0;
}

/** Drop all glyphs — call before re-rendering the model list. */
export function resetGlyphs() {
  registry = [];
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
}

/** Attach a breathing, seeded glyph for `id` to a canvas. */
export function addGlyph(canvas: HTMLCanvasElement, id: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = SIZE * dpr;
  canvas.height = SIZE * dpr;
  ctx.scale(dpr, dpr);

  const rng = mulberry32(hash(id));
  const h1 = Math.floor(rng() * 360);
  const h2 = (h1 + 50 + Math.floor(rng() * 200)) % 360;
  const half = 6 + Math.floor(rng() * 4);
  const pts: Pt[] = [];
  for (let i = 0; i < half; i++) {
    const hx = 0.5 + rng() * 0.4; // right half — mirrored to the left for symmetry
    const hy = 0.14 + rng() * 0.72;
    const r = 0.8 + rng() * 1.5;
    const ph = rng() * 6.28;
    const sp = 0.5 + rng() * 1.1;
    const accent = rng() < 0.3;
    const hue = accent ? h2 : h1;
    const light = 56 + Math.floor(rng() * 18);
    pts.push({ hx, hy, r, ph, sp, hue, light });
    pts.push({ hx: 1 - hx, hy, r, ph: ph + 1.6, sp, hue, light });
  }

  const g: Glyph = { ctx, pts, s: SIZE };
  registry.push(g);
  if (reduce) {
    drawGlyph(g);
    return;
  }
  if (!raf) raf = requestAnimationFrame(tick);
}
