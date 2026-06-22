/* dither.js — plain-JS dither engine for LlamaRanch website.
 * Ported from docs/superpowers/design/brand-exploration.html (lines 733–916).
 * Handles canvas[data-glyph="photo"] elements: loads the image referenced by
 * data-src, renders a Bayer-dithered dot-matrix with a vertical sweep animation
 * and an optional data-fade direction mask.
 */
(function () {
  'use strict';

  const imgCache = {};
  let t0 = performance.now();
  let lastFrame = 0;
  let frame = 0;
  let rafId = null;
  let animated = [];
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── Image loading ── */
  function getImg(src) {
    let e = imgCache[src];
    if (!e) {
      e = { img: new Image(), ready: false };
      e.img.onload = function () {
        e.ready = true;
        // invalidate lum cache so canvas redraws
        document.querySelectorAll('canvas[data-glyph="photo"]').forEach(function (cv) {
          if ((cv.dataset.src || '') === src) { cv._lc = ''; }
        });
      };
      e.img.src = src;
      imgCache[src] = e;
    }
    return e;
  }

  /* ── Build luminance map ── */
  function buildLum(cols, rows, img, crop) {
    const oc = document.createElement('canvas');
    oc.width = cols; oc.height = rows;
    const o = oc.getContext('2d');
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (crop) {
      const c = crop.split(',').map(Number);
      o.drawImage(img, c[0] * iw, c[1] * ih, (c[2] - c[0]) * iw, (c[3] - c[1]) * ih, 0, 0, cols, rows);
    } else {
      o.drawImage(img, 0, 0, cols, rows);
    }
    const data = o.getImageData(0, 0, cols, rows).data;
    const lum = new Float32Array(cols * rows);
    for (let i = 0; i < cols * rows; i++) {
      const L = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
      lum[i] = Math.max(0, Math.min(1, (1 - L - 0.10) * 1.45));
    }
    return lum;
  }

  /* ── Draw one photo canvas ── */
  function drawPhoto(cv, t) {
    const src = cv.dataset.src || '';
    if (!src) return;
    const ie = getImg(src);
    if (!ie.ready) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;

    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cell = parseFloat(cv.dataset.cell || '4');
    const s = Math.max(1, cell - 1);
    const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
    const key = cols + 'x' + rows;

    if (cv._lc !== key) {
      cv._lum = buildLum(cols, rows, ie.img, cv.dataset.crop || null);
      cv._lc = key;
    }

    const lum = cv._lum;
    const fade = cv.dataset.fade;
    const bayer = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
    ctx.fillStyle = cv.dataset.color || '#1b1a13';

    const sweepY = (t * 0.05) % 1.25;

    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < cols; gx++) {
        let d = lum[gy * cols + gx];
        if (d <= 0) continue;

        d += 0.045 * Math.sin(t * 0.7 + gx * 0.06);
        const sd = Math.abs(gy / rows - sweepY);
        if (sd < 0.05) d += 0.14 * (1 - sd / 0.05);

        if (fade === 'left') {
          d *= Math.min(1, Math.max(0, (gx / cols - 0.42) / 0.34));
        } else if (fade === 'up') {
          d *= Math.min(1, Math.max(0, (gy / rows - 0.06) / 0.42));
        } else if (fade === 'vignette') {
          const dx = (gx / cols - 0.5) * 2, dy = (gy / rows - 0.5) * 2;
          d *= Math.max(0, 1 - (dx * dx + dy * dy) * 0.62);
        }

        if (d <= 0) continue;
        const th = (bayer[gy & 3][gx & 3] + 0.5) / 16;
        if (d > th) {
          ctx.fillRect(
            Math.round(gx * cell + cell / 2 - s / 2),
            Math.round(gy * cell + cell / 2 - s / 2),
            s, s
          );
        }
      }
    }
  }

  /* ── Collect all photo canvases ── */
  function collectAnimated() {
    animated = Array.prototype.slice.call(
      document.querySelectorAll('canvas[data-glyph="photo"]')
    );
  }

  /* ── Animation loop ── */
  function loop(now) {
    if (now - lastFrame > 1000 / 22) {
      lastFrame = now;
      const t = (now - t0) / 1000;
      frame = (frame + 1) | 0;
      if (frame % 26 === 0) collectAnimated();
      animated.forEach(function (cv) {
        // throttle photo to ~7 fps
        if (frame % 3 !== 0) return;
        drawPhoto(cv, t);
      });
    }
    rafId = requestAnimationFrame(loop);
  }

  /* ── Init ── */
  function init() {
    collectAnimated();
    if (reduceMotion) {
      animated.forEach(function (cv) { drawPhoto(cv, 0); });
    } else {
      // First draw immediately, then animate
      animated.forEach(function (cv) { drawPhoto(cv, 0); });
      // Small delay so layout is stable
      setTimeout(function () {
        collectAnimated();
        animated.forEach(function (cv) { drawPhoto(cv, 0); });
        t0 = performance.now();
        rafId = requestAnimationFrame(loop);
      }, 160);
    }
  }

  /* Handle resize: invalidate lum caches */
  window.addEventListener('resize', function () {
    animated.forEach(function (cv) { cv._lc = ''; });
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
