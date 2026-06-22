// Dither material engine — Bayer-ordered dithering of procedural density
// functions and photographs, driven by a single shared rAF at ~22 fps.
// Scans canvas[data-glyph] and [data-counter] in the document; no framework,
// no npm deps. Port of the DCLogic component in brand-exploration.html.

type ImgEntry = { img: HTMLImageElement; ready: boolean };
type ImgCache = Record<string, ImgEntry>;

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

// Augment HTMLCanvasElement with the transient per-canvas fields used at runtime.
interface DitherCanvas extends HTMLCanvasElement {
  _lum?: Float32Array;
  _lc?: string;
}

export class Dither {
  private t0 = 0;
  private imgCache: ImgCache = {};
  private animated: DitherCanvas[] = [];
  private counters: Element[] = [];
  private reduce = false;
  private _last = 0;
  private _frame = 0;
  private _raf = 0;
  private _t = 0;
  private _r: (() => void) | null = null;

  mount(): void {
    this.t0 = performance.now();
    this.imgCache = {};
    this.renderStatic();
    this._t = window.setTimeout(() => {
      this.renderStatic();
      this.collectAnimated();
      if (this.reduce) {
        this.animated.forEach((cv) => this.draw(cv, 0));
      }
    }, 160);
    this._r = () => {
      this.renderStatic();
      this.collectAnimated();
    };
    window.addEventListener("resize", this._r);
    this.collectAnimated();
    this.reduce =
      !!(window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (this.reduce) {
      this.animated.forEach((cv) => this.draw(cv, 0));
      this.tickCounters(0);
    } else {
      this._last = 0;
      this._raf = requestAnimationFrame((n) => this.loop(n));
    }
  }

  unmount(): void {
    clearTimeout(this._t);
    cancelAnimationFrame(this._raf);
    if (this._r) window.removeEventListener("resize", this._r);
  }

  /** Re-scan and draw all data-glyph canvases. Call after dynamic DOM updates. */
  refresh(): void {
    this.renderStatic();
    this.collectAnimated();
    this.animated.forEach((cv) => this.draw(cv, 0));
  }

  private isAnimated(kind: string | undefined): boolean {
    return (
      kind === "scope" ||
      kind === "meter" ||
      kind === "scan" ||
      kind === "photo"
    );
  }

  private collectAnimated(): void {
    this.animated = [
      ...(document.querySelectorAll(
        "canvas[data-glyph]"
      ) as NodeListOf<DitherCanvas>),
    ].filter((cv) => this.isAnimated(cv.dataset.glyph));
    this.counters = [...document.querySelectorAll("[data-counter]")];
  }

  private renderStatic(): void {
    (
      document.querySelectorAll(
        "canvas[data-glyph]"
      ) as NodeListOf<DitherCanvas>
    ).forEach((cv) => {
      if (!this.isAnimated(cv.dataset.glyph)) {
        this.draw(cv, 0);
        cv.dataset.s = "1";
      }
    });
  }

  private sweep(): void {
    this.collectAnimated();
    (
      document.querySelectorAll(
        "canvas[data-glyph]"
      ) as NodeListOf<DitherCanvas>
    ).forEach((cv) => {
      if (!this.isAnimated(cv.dataset.glyph) && cv.dataset.s !== "1") {
        this.draw(cv, 0);
        cv.dataset.s = "1";
      }
    });
  }

  private loop(now: number): void {
    if (now - this._last > 1000 / 22) {
      this._last = now;
      const t = (now - this.t0) / 1000;
      if ((this._frame = (this._frame || 0) + 1) % 26 === 0) this.sweep();
      (this.animated || []).forEach((cv) => {
        try {
          if (cv.dataset.glyph === "photo" && this._frame % 3 !== 0) return;
          this.draw(cv, t);
        } catch {
          // skip this canvas this frame
        }
      });
      this.tickCounters(t);
    }
    this._raf = requestAnimationFrame((n) => this.loop(n));
  }

  private tickCounters(t: number): void {
    this.counters.forEach((el, i) => {
      const base = parseFloat(
        (el as HTMLElement).dataset.counter ?? "0"
      );
      const ph = i * 1.7;
      const v =
        base +
        3 * Math.sin(t * 1.6 + ph) +
        1.6 * Math.sin(t * 4.3 + ph);
      el.textContent = String(Math.max(0, Math.round(v)));
    });
  }

  private getImg(src: string): ImgEntry {
    let e = this.imgCache[src];
    if (!e) {
      e = { img: new Image(), ready: false };
      e.img.onload = () => {
        e.ready = true;
        (
          document.querySelectorAll(
            'canvas[data-glyph="photo"]'
          ) as NodeListOf<DitherCanvas>
        ).forEach((c) => {
          if ((c.dataset.src || "assets/ranch.jpg") === src) c._lc = "";
        });
      };
      e.img.src = src;
      this.imgCache[src] = e;
    }
    return e;
  }

  private buildLum(
    cols: number,
    rows: number,
    img: HTMLImageElement,
    crop: string | undefined
  ): Float32Array {
    const oc = document.createElement("canvas");
    oc.width = cols;
    oc.height = rows;
    const o = oc.getContext("2d");
    if (!o) return new Float32Array(cols * rows);
    const iw = img.naturalWidth,
      ih = img.naturalHeight;
    if (crop) {
      const c = crop.split(",").map(Number);
      o.drawImage(
        img,
        c[0] * iw,
        c[1] * ih,
        c[2] * iw,
        c[3] * ih,
        0,
        0,
        cols,
        rows
      );
    } else {
      o.drawImage(img, 0, 0, cols, rows);
    }
    const data = o.getImageData(0, 0, cols, rows).data;
    const lum = new Float32Array(cols * rows);
    for (let i = 0; i < cols * rows; i++) {
      const L =
        (0.299 * data[i * 4] +
          0.587 * data[i * 4 + 1] +
          0.114 * data[i * 4 + 2]) /
        255;
      lum[i] = Math.max(0, Math.min(1, (1 - L - 0.1) * 1.45));
    }
    return lum;
  }

  private drawPhoto(cv: DitherCanvas, t: number): void {
    const src = cv.dataset.src || "assets/ranch.jpg";
    const ie = this.getImg(src);
    if (!ie.ready) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth,
      h = cv.clientHeight;
    if (!w || !h) return;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext("2d") as CanvasRenderingContext2D;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const cell = parseFloat(cv.dataset.cell || "4");
    const s = Math.max(1, cell - 1);
    const cols = Math.ceil(w / cell),
      rows = Math.ceil(h / cell);
    const key = cols + "x" + rows;
    if (cv._lc !== key) {
      cv._lum = this.buildLum(cols, rows, ie.img, cv.dataset.crop);
      cv._lc = key;
    }
    const lum = cv._lum as Float32Array;
    const fade = cv.dataset.fade;
    ctx.fillStyle = cv.dataset.color || "#1b1a13";
    const sweepY = (t * 0.05) % 1.25;
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        let d = lum[gy * cols + gx];
        if (d <= 0) continue;
        d += 0.045 * Math.sin(t * 0.7 + gx * 0.06);
        const sd = Math.abs(gy / rows - sweepY);
        if (sd < 0.05) d += 0.14 * (1 - sd / 0.05);
        if (fade === "left")
          d *= Math.min(1, Math.max(0, (gx / cols - 0.42) / 0.34));
        else if (fade === "up")
          d *= Math.min(1, Math.max(0, (gy / rows - 0.06) / 0.42));
        else if (fade === "vignette") {
          const dx = (gx / cols - 0.5) * 2,
            dy = (gy / rows - 0.5) * 2;
          d *= Math.max(0, 1 - (dx * dx + dy * dy) * 0.62);
        }
        if (d <= 0) continue;
        const th = (BAYER[gy & 3][gx & 3] + 0.5) / 16;
        if (d > th)
          ctx.fillRect(
            Math.round(gx * cell + cell / 2 - s / 2),
            Math.round(gy * cell + cell / 2 - s / 2),
            s,
            s
          );
      }
    }
  }

  private hash(x: number, y: number, s: number): number {
    const n =
      Math.sin(x * 127.1 + y * 311.7 + s * 53.123) * 43758.5453;
    return n - Math.floor(n);
  }

  private vnoise(x: number, y: number, s: number): number {
    const xi = Math.floor(x),
      yi = Math.floor(y),
      xf = x - xi,
      yf = y - yi;
    const u = xf * xf * (3 - 2 * xf),
      v = yf * yf * (3 - 2 * yf);
    const a = this.hash(xi, yi, s),
      b = this.hash(xi + 1, yi, s),
      c = this.hash(xi, yi + 1, s),
      d = this.hash(xi + 1, yi + 1, s);
    return (
      a * (1 - u) * (1 - v) +
      b * u * (1 - v) +
      c * (1 - u) * v +
      d * u * v
    );
  }

  private fbm(x: number, y: number, s: number): number {
    let total = 0,
      amp = 0.5,
      f = 1;
    for (let i = 0; i < 4; i++) {
      total += amp * this.vnoise(x * f, y * f, s + i * 7.7);
      f *= 2;
      amp *= 0.5;
    }
    return total;
  }

  private densityFn(
    kind: string | undefined,
    seed: number,
    aspect: number,
    opts: { level?: number; t?: number } | null
  ): (nx: number, ny: number) => number {
    const fbm = (x: number, y: number) => this.fbm(x, y, seed);
    const level = opts && opts.level != null ? opts.level : 0.6;
    const tt = (opts && opts.t) || 0;

    if (kind === "scope") {
      return (nx: number, ny: number) => {
        const y0 =
          0.4 * Math.sin(nx * 3.0 + seed + tt * 1.8) +
          0.17 * Math.sin(nx * 7.3 + seed * 2 + tt * 3.1) +
          0.11 * Math.sin(nx * 15.1 + seed + tt * 1.2);
        return Math.min(
          1,
          Math.exp(-Math.pow((ny - y0) / 0.12, 2)) * 0.96
        );
      };
    }

    if (kind === "meter") {
      const lvl = Math.max(
        0,
        Math.min(
          1,
          level +
            (level > 0.5 ? 0.06 : 0.03) * Math.sin(tt * 4 + seed * 3) +
            (level > 0.5 ? 0.03 : 0.015) * Math.sin(tt * 9 + seed)
        )
      );
      return (nx: number, ny: number) => {
        const hb = (1 - ny) / 2;
        const seg = 0.5 + 0.5 * Math.sin(ny * Math.PI * 13);
        const n = fbm(nx * 4 + seed, ny * 7);
        if (hb < lvl) return Math.min(1, (0.5 + 0.55 * seg) * (0.6 + 0.5 * n));
        return 0.04 * n;
      };
    }

    if (kind === "wall") {
      return (nx: number, ny: number) => {
        const n = fbm(nx * 1.6 * aspect + seed, ny * 1.6 + seed);
        const grad = (ny + 1) / 2;
        return Math.min(0.92, 0.04 + 0.5 * Math.pow(n, 1.7) + grad * 0.22);
      };
    }

    if (kind === "band") {
      return (nx: number, ny: number) => {
        const n = fbm(nx * 3.4 * aspect + seed, ny * 1.2 + seed);
        return Math.min(0.85, 0.1 + 0.6 * Math.pow(n, 1.5));
      };
    }

    // scan — horizontal signal lines, fading at edges (the "alive" material)
    return (nx: number, ny: number) => {
      const lines =
        0.5 + 0.5 * Math.sin((ny + tt * 0.5) * Math.PI * 5 + seed);
      const n = fbm(nx * 3 * aspect + seed - tt * 0.14, ny * 3);
      const edge = 1 - Math.min(1, Math.abs(nx) * 1.05);
      return Math.min(0.8, lines * (0.35 + 0.7 * n) * edge);
    };
  }

  private draw(cv: DitherCanvas, t: number): void {
    if (cv.dataset.glyph === "photo") return this.drawPhoto(cv, t);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth,
      h = cv.clientHeight;
    if (!w || !h) return;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext("2d") as CanvasRenderingContext2D;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const seed = parseFloat(cv.dataset.seed || "1");
    const cell = parseFloat(cv.dataset.cell || "3");
    const color = cv.dataset.color || "#15140f";
    const s = Math.max(1, cell - 1);
    const dens = this.densityFn(
      cv.dataset.glyph,
      seed,
      Math.max(1, w / h),
      { level: parseFloat(cv.dataset.level || "0.6"), t: t || 0 }
    );
    ctx.fillStyle = color;
    const cols = Math.ceil(w / cell),
      rows = Math.ceil(h / cell);
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        const px = gx * cell + cell / 2,
          py = gy * cell + cell / 2;
        const nx = (px / w) * 2 - 1,
          ny = (py / h) * 2 - 1;
        const d = dens(nx, ny);
        if (d <= 0) continue;
        const th = (BAYER[gy & 3][gx & 3] + 0.5) / 16;
        if (d > th)
          ctx.fillRect(
            Math.round(px - s / 2),
            Math.round(py - s / 2),
            s,
            s
          );
      }
    }
  }
}

/** Construct a Dither instance, mount it, and return it for later unmounting. */
export function mountDither(): Dither {
  const d = new Dither();
  d.mount();
  return d;
}
