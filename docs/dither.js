/* LlamaRanch website dither engine.
   Bayer-ordered dithering of procedural density fields (scope / wall / band /
   scan) and the footer photograph, plus animated [data-counter] numbers.
   Scans canvas[data-glyph]; no framework, no deps. Vanilla port of the
   imported design's component. */
(function () {
  "use strict";
  var t0 = performance.now();
  var imgCache = {};
  var animated = [];
  var last = 0, frame = 0, raf = 0;
  var BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

  function isAnimated(k) { return k === "scope" || k === "scan" || k === "photo"; }

  function collectAnimated() {
    animated = [].slice.call(document.querySelectorAll("canvas[data-glyph]"))
      .filter(function (cv) { return isAnimated(cv.dataset.glyph); });
  }
  function renderStatic() {
    document.querySelectorAll("canvas[data-glyph]").forEach(function (cv) {
      if (!isAnimated(cv.dataset.glyph)) { draw(cv, 0); cv.dataset.s = "1"; }
    });
  }
  function sweep() {
    collectAnimated();
    document.querySelectorAll("canvas[data-glyph]").forEach(function (cv) {
      if (!isAnimated(cv.dataset.glyph) && cv.dataset.s !== "1") { draw(cv, 0); cv.dataset.s = "1"; }
    });
  }
  function loop(now) {
    if (now - last > 1000 / 20) {
      last = now;
      var t = (now - t0) / 1000;
      if ((frame = (frame || 0) + 1) % 26 === 0) sweep();
      animated.forEach(function (cv) {
        if (cv.dataset.glyph === "photo" && frame % 3 !== 0) return;
        try { draw(cv, t); } catch (e) { /* skip this canvas this frame */ }
      });
      tickCounters(t);
    }
    raf = requestAnimationFrame(loop);
  }
  function tickCounters(t) {
    document.querySelectorAll("[data-counter]").forEach(function (el, i) {
      var base = parseFloat(el.dataset.counter);
      if (!base) return;
      var ph = i * 1.7;
      var v = base + 3 * Math.sin(t * 1.6 + ph) + 1.6 * Math.sin(t * 4.3 + ph);
      el.textContent = Math.max(0, Math.round(v));
    });
  }

  function getImg(src) {
    var e = imgCache[src];
    if (!e) {
      e = { img: new Image(), ready: false };
      e.img.onload = function () {
        e.ready = true;
        document.querySelectorAll('canvas[data-glyph="photo"]').forEach(function (c) {
          if ((c.dataset.src || "assets/cover.jpg") === src) c._lc = "";
        });
      };
      e.img.src = src;
      imgCache[src] = e;
    }
    return e;
  }
  function buildLum(cols, rows, img, crop) {
    var oc = document.createElement("canvas"); oc.width = cols; oc.height = rows;
    var o = oc.getContext("2d");
    var iw = img.naturalWidth, ih = img.naturalHeight;
    if (crop) { var c = crop.split(",").map(Number); o.drawImage(img, c[0] * iw, c[1] * ih, c[2] * iw, c[3] * ih, 0, 0, cols, rows); }
    else o.drawImage(img, 0, 0, cols, rows);
    var data = o.getImageData(0, 0, cols, rows).data;
    var lum = new Float32Array(cols * rows);
    for (var i = 0; i < cols * rows; i++) {
      var L = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
      lum[i] = Math.max(0, Math.min(1, (1 - L - 0.08) * 1.5));
    }
    return lum;
  }
  function drawPhoto(cv, t) {
    var src = cv.dataset.src || "assets/cover.jpg";
    var ie = getImg(src);
    if (!ie.ready) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    var ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    var cell = parseFloat(cv.dataset.cell || "3.4"); var s = Math.max(1, cell - 1);
    var cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
    var key = cols + "x" + rows;
    if (cv._lc !== key) { cv._lum = buildLum(cols, rows, ie.img, cv.dataset.crop); cv._lc = key; }
    var lum = cv._lum; var fade = cv.dataset.fade;
    ctx.fillStyle = cv.dataset.color || "#26262e";
    var sweepY = (t * 0.05) % 1.25;
    for (var gy = 0; gy < rows; gy++) {
      for (var gx = 0; gx < cols; gx++) {
        var d = lum[gy * cols + gx];
        if (d <= 0) continue;
        d += 0.04 * Math.sin(t * 0.7 + gx * 0.06);
        var sd = Math.abs(gy / rows - sweepY); if (sd < 0.05) d += 0.12 * (1 - sd / 0.05);
        if (fade === "up") d *= Math.min(1, Math.max(0, (gy / rows - 0.06) / 0.42));
        if (d <= 0) continue;
        var th = (BAYER[gy & 3][gx & 3] + 0.5) / 16;
        if (d > th) ctx.fillRect(Math.round(gx * cell + cell / 2 - s / 2), Math.round(gy * cell + cell / 2 - s / 2), s, s);
      }
    }
  }

  function hash(x, y, s) { var n = Math.sin(x * 127.1 + y * 311.7 + s * 53.123) * 43758.5453; return n - Math.floor(n); }
  function vnoise(x, y, s) {
    var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
  }
  function fbm(x, y, s) { var t = 0, amp = 0.5, f = 1; for (var i = 0; i < 4; i++) { t += amp * vnoise(x * f, y * f, s + i * 7.7); f *= 2; amp *= 0.5; } return t; }

  function densityFn(kind, seed, aspect, tt) {
    if (kind === "scope") {
      return function (nx, ny) {
        var y0 = 0.40 * Math.sin(nx * 3.0 + seed + tt * 1.8) + 0.17 * Math.sin(nx * 7.3 + seed * 2 + tt * 3.1) + 0.11 * Math.sin(nx * 15.1 + seed + tt * 1.2);
        return Math.min(1, Math.exp(-Math.pow((ny - y0) / 0.12, 2)) * 0.96);
      };
    }
    if (kind === "wall") {
      return function (nx, ny) {
        var n = fbm(nx * 1.6 * aspect + seed, ny * 1.6 + seed);
        var grad = (ny + 1) / 2;
        return Math.min(0.95, 0.06 + 0.56 * Math.pow(n, 1.6) + grad * 0.24);
      };
    }
    if (kind === "band") {
      return function (nx, ny) {
        var n = fbm(nx * 3.4 * aspect + seed, ny * 1.2 + seed);
        return Math.min(0.88, 0.12 + 0.64 * Math.pow(n, 1.45));
      };
    }
    return function (nx, ny) {
      var lines = 0.5 + 0.5 * Math.sin((ny + tt * 0.5) * Math.PI * 5 + seed);
      var n = fbm(nx * 3 * aspect + seed - tt * 0.14, ny * 3);
      var edge = 1 - Math.min(1, Math.abs(nx) * 1.05);
      return Math.min(0.8, lines * (0.35 + 0.7 * n) * edge);
    };
  }

  function draw(cv, t) {
    if (cv.dataset.glyph === "photo") return drawPhoto(cv, t);
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    var ctx = cv.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    var seed = parseFloat(cv.dataset.seed || "1");
    var cell = parseFloat(cv.dataset.cell || "3");
    var color = cv.dataset.color || "#aeaeb8";
    var s = Math.max(1, cell - 1);
    var dens = densityFn(cv.dataset.glyph, seed, Math.max(1, w / h), t || 0);
    ctx.fillStyle = color;
    var cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
    for (var gy = 0; gy < rows; gy++) {
      for (var gx = 0; gx < cols; gx++) {
        var px = gx * cell + cell / 2, py = gy * cell + cell / 2;
        var nx = (px / w) * 2 - 1, ny = (py / h) * 2 - 1;
        var d = dens(nx, ny);
        if (d <= 0) continue;
        var th = (BAYER[gy & 3][gx & 3] + 0.5) / 16;
        if (d > th) ctx.fillRect(Math.round(px - s / 2), Math.round(py - s / 2), s, s);
      }
    }
  }

  function init() {
    t0 = performance.now();
    renderStatic();
    collectAnimated();
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { animated.forEach(function (cv) { draw(cv, 0); }); tickCounters(0); }
    else { last = 0; raf = requestAnimationFrame(loop); }
    window.addEventListener("resize", function () { renderStatic(); collectAnimated(); });
    setTimeout(function () { renderStatic(); collectAnimated(); }, 180);
  }

  /* Copy-to-clipboard for the install command ([data-copy]). */
  function wireCopy() {
    document.querySelectorAll("[data-copy]").forEach(function (el) {
      el.style.cursor = "pointer";
      el.addEventListener("click", function () {
        navigator.clipboard.writeText(el.getAttribute("data-copy")).then(function () {
          var label = el.querySelector("[data-copy-label]");
          if (!label) return;
          var prev = label.textContent;
          label.textContent = "copied";
          setTimeout(function () { label.textContent = prev; }, 1200);
        }).catch(function () {});
      });
    });
  }

  function boot() { init(); wireCopy(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
