import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { check } from "@tauri-apps/plugin-updater";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { applyTheme, type Theme } from "./brand/theme";
import "./styles.css";
import { mountDither, Dither } from "./dither";
import llamaMark from "./assets/llama.svg";
import { tagOS, fitWindow } from "./platform";
import { prettyName } from "./pretty";
import { escapeHtml } from "./paths.ts";

tagOS();

type ModelView = {
  id: string; name: string; group: string; size_bytes: number;
  vision: boolean; placement: string; status: string;
  local: boolean; need_download: boolean;
};
type CatalogView = {
  id: string; name: string; description: string; group: string;
  approx_gb: number; installed: boolean;
};
type RouterStatus = { status: string; endpoint: string };

const $ = (id: string) => document.getElementById(id)!;
const gb = (n: number) => (n / 1e9).toFixed(1) + " GB";
const LOADED = (s: string) => s === "loaded" || s === "sleeping";
const BUSY = (s: string) => s === "loading" || s === "downloading";

type ModelOverride = {
  ctx_size?: number | null; temp?: number | null; top_p?: number | null; top_k?: number | null;
  min_p?: number | null; repeat_penalty?: number | null; presence_penalty?: number | null; frequency_penalty?: number | null;
};
type ModelInfo = { native_ctx: number; file_bytes: number; kv_per_token: number; override: ModelOverride };
type ModelFit = {
  verdict: string; // fast | tight | slow | wont_fit
  eval_ctx: number; needed_bytes: number;
  fast_budget: number; usable_ceiling: number; total_ram: number;
  gpu_label: string; fast_ctx: number; usable_ctx: number;
  needs_smaller_quant: boolean; native_ctx: number;
};
type RelCase = { id: string; passed: boolean; detail: string };
type RelReport = { model: string; passed: number; total: number; score: number; verdict: string; cases: RelCase[] };
type Quant = { label: string; bpw: number };
type QuantMetrics = { kld: number; top1_agreement: number; ppl_ratio: number };
type QuantEntry = {
  quant: Quant; model_id: string; metrics: QuantMetrics;
  sharpness: number; band: string; is_reference: boolean;
};
type QuantReport = {
  base: string; reference: string; entries: QuantEntry[];
  sweet_spot: string | null; measured_unix: number; calibration_version: number;
};

const CTX_TIERS = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
const tierLabel = (n: number) => (n % 1024 === 0 ? `${n / 1024}k` : String(n));

// Turn a backend fit estimate into a one-line verdict for the model config panel:
// a state class (ok/warn/error), the headline, the numbers, and what to do next.
function fitVerdict(f: ModelFit): { word: string; cls: string; detail: string; advice: string } {
  const have = f.gpu_label === "CPU" ? f.total_ram : f.fast_budget;
  const detail = `needs ~${gb(f.needed_bytes)} · ${f.gpu_label} ~${gb(have)}`;
  switch (f.verdict) {
    case "fast":
      return { word: "Fits fast", cls: "ok", detail,
        advice: `full ${tierLabel(f.native_ctx)} context runs fast` };
    case "tight":
      return { word: "Tight fit", cls: "warn", detail,
        advice: f.fast_ctx > 0
          ? `drop to ${tierLabel(f.fast_ctx)} to run fast`
          : `fits up to ${tierLabel(f.usable_ctx)}, but close to the limit` };
    case "slow":
      return { word: "Runs slow", cls: "warn", detail,
        advice: f.fast_ctx > 0
          ? `drop to ${tierLabel(f.fast_ctx)} to run fast`
          : `no GPU here, runs on CPU at this size` };
    default: // wont_fit
      return { word: "Won't fit", cls: "error", detail,
        advice: f.needs_smaller_quant
          ? `too big for this machine, try a smaller quant`
          : `too big at this context, try ${tierLabel(f.usable_ctx)} or less` };
  }
}

// Tool-reliability verdict → status class, and the rendered result block.
function relCls(verdict: string): string {
  return verdict === "dependable" ? "ok" : verdict === "flaky" ? "warn" : "error";
}
function renderRel(r: RelReport): string {
  const dots = r.cases
    .map((c) => {
      const tip = escapeHtml(`${c.id}: ${c.detail}`);
      return `<span class="cfg-rel__dot cfg-rel__dot--${c.passed ? "ok" : "bad"}" title="${tip}"></span>`;
    })
    .join("");
  return (
    `<div class="cfg-fit__head">` +
      `<span class="cfg-fit__led cfg-fit__led--${relCls(r.verdict)}"></span>` +
      `<span class="cfg-fit__word">Tools: ${r.verdict}</span>` +
      `<span class="cfg-fit__detail">${r.passed}/${r.total} cases</span>` +
    `</div>` +
    `<div class="cfg-rel__dots">${dots}</div>`
  );
}

// Model quality: a quant's band → status class (crisp/solid/reference are calm,
// soft warns, rough errors), and the rendered grade list for the config panel.
function bandCls(band: string): string {
  return band === "rough" ? "error" : band === "soft" ? "warn" : "ok";
}
function renderQuality(r: QuantReport): string {
  if (!r.entries.length) return `<div class="cfg-note">No sizes to measure.</div>`;
  // A single installed size is its own reference: nothing to measure loss against.
  if (r.entries.length === 1) {
    return `<div class="cfg-note">Only ${escapeHtml(r.entries[0].quant.label)} installed. Add a higher size to measure what you'd lose.</div>`;
  }
  const rows = r.entries
    .map((e) => {
      const note = e.is_reference ? "reference" : escapeHtml(e.band);
      const sweet =
        r.sweet_spot && e.quant.label === r.sweet_spot
          ? `<span class="cfg-qual__star">sweet spot</span>`
          : "";
      return (
        `<div class="cfg-qual__row">` +
          `<span class="cfg-fit__led cfg-fit__led--${bandCls(e.band)}"></span>` +
          `<span class="cfg-qual__label">${escapeHtml(e.quant.label)}</span>` +
          `<span class="cfg-qual__pct">${e.is_reference ? "ref" : e.sharpness + "%"}</span>` +
          `<span class="cfg-qual__note">${note}</span>` +
          sweet +
        `</div>`
      );
    })
    .join("");
  return (
    `<div class="cfg-qual__ref">vs ${escapeHtml(r.reference)}, the heaviest you have</div>` +
    `<div class="cfg-qual__rows">${rows}</div>`
  );
}

// which model's expander is open (survives re-renders so polling won't collapse it)
let openCfg: string | null = null;

let models: ModelView[] = [];
let catalog: CatalogView[] = [];
let router: RouterStatus = { status: "starting", endpoint: "" };
let view: "installed" | "discover" = "installed";
const dl = new Map<string, { done: number; total: number }>();
let pollTimer: number | undefined;

// Module-level dither instance - set in init() before first render.
let dither: Dither;

/** Sync the hairline band canvas data-color to the resolved CSS var. */
function updateHairlineColor() {
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = document.documentElement.dataset.theme;
  const isDark = theme === "dark" || (theme !== "light" && dark);
  const color = isDark ? "#3a382f" : "#c4c0b4";
  document.querySelectorAll<HTMLCanvasElement>('canvas[data-glyph="band"][data-hairline]').forEach((cv) => {
    cv.dataset.color = color;
  });
  dither?.refresh();
}

// Color the endpoint pill's status dot: ink when running, muted while starting,
// red on error. The pulse is CSS.
function setHeader() {
  const led = document.getElementById("status-led");
  if (!led) return;
  led.className = "ms-endpoint__dot";
  if (router.status.startsWith("error")) led.classList.add("ms-endpoint__dot--error");
  else if (router.status !== "running") led.classList.add("ms-endpoint__dot--starting");
  else led.classList.add("ms-endpoint__dot--on");
}

// ── Model selector (the design's hero + list) ──────────────────────────────

/** A short sub-line for the hero: size, vision, placement. (gb() carries the unit.) */
function heroSub(m: ModelView): string {
  const parts: string[] = [];
  if (m.size_bytes > 0) parts.push(gb(m.size_bytes));
  if (m.vision) parts.push("vision");
  if (m.placement) parts.push("on your " + m.placement.toUpperCase());
  return parts.join(" · ") || "ready to ride";
}

/** A short sub-line for a list row. (gb() already includes " GB".) */
function rowSub(m: ModelView): string {
  if (m.need_download) {
    return "Cloud · " + (m.size_bytes > 0 ? gb(m.size_bytes) + " to fetch" : "fetch to run");
  }
  const parts: string[] = [];
  if (m.size_bytes > 0) parts.push(gb(m.size_bytes));
  if (m.vision) parts.push("vision");
  else if (m.placement) parts.push("fits");
  return parts.join(" · ");
}

/** Open the chat window (the hero "Open chat" action). */
async function openChatWindow() {
  try {
    const w = await WebviewWindow.getByLabel("chat");
    if (w) { await w.show(); await (w as any).unminimize?.(); await w.setFocus(); }
  } catch { showError("Could not open the chat window."); }
}

/** Best-effort fill of the hero's context stat from real model info.
    (tok/sec stays a dash until live server metrics are wired.) */
async function fillHeroStats(m: ModelView) {
  try {
    const info = await invoke<ModelInfo>("model_info", { modelId: m.id });
    const ctx = info.override.ctx_size ?? info.native_ctx ?? 0;
    const el = document.getElementById("hero-ctx");
    if (el && ctx > 0) el.textContent = ctx % 1024 === 0 ? `${ctx / 1024}K` : String(ctx);
  } catch { /* leave the dash */ }
}

// Feather "settings" gear — the configure affordance on the hero and rows.
const GEAR =
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

/** Toggle the inline config expander for a downloaded model. */
function toggleCfg(id: string) {
  openCfg = openCfg === id ? null : id;
  render();
}

/** True when the resolved theme is dark (explicit data-theme or system). */
function isDarkTheme(): boolean {
  const t = document.documentElement.dataset.theme;
  return t === "dark" || (t !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

/** Build a bare .ms-row (dot + name + sub); the caller appends the action(s). */
function makeRow(dotClass: string, name: string, sub: string, dim = false): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "ms-row";
  const dot = document.createElement("span");
  dot.className = "ms-row__dot " + dotClass;
  row.appendChild(dot);
  const body = document.createElement("div");
  body.className = "ms-row__body";
  const nm = document.createElement("div");
  nm.className = "ms-row__name" + (dim ? " ms-row__name--cloud" : "");
  nm.textContent = name;
  const sb = document.createElement("div");
  sb.className = "ms-row__sub";
  sb.textContent = sub;
  body.append(nm, sb);
  row.appendChild(body);
  return row;
}

/** The inline config panel placeholder (hydrateCfg fills #cfg-open). */
function cfgExpander(): HTMLDivElement {
  const ph = document.createElement("div");
  ph.className = "cfg-expander";
  ph.id = "cfg-open";
  ph.innerHTML = `<div class="cfg-note">Loading…</div>`;
  return ph;
}

function renderSelector() {
  const heroHost = document.getElementById("hero");
  const listHost = $("models");
  const label = document.getElementById("list-label");
  if (!heroHost) return;

  const serving = models.find((m) => LOADED(m.status));
  const loading = models.find((m) => BUSY(m.status));
  const hero = serving || loading;

  // ── HERO ──
  heroHost.innerHTML = "";
  if (serving) {
    const name = prettyName(serving.name || serving.id);
    heroHost.innerHTML =
      `<div class="ms-hero__label">Serving now</div>` +
      `<div class="ms-hero__name">${escapeHtml(name)}</div>` +
      `<div class="ms-hero__sub">${escapeHtml(heroSub(serving))}</div>` +
      `<div class="ms-hero__scope"><canvas data-glyph="scope" data-seed="3" data-cell="2.2" data-color="${isDarkTheme() ? "#f4f4f5" : "#0d0d0f"}" style="width:100%;height:100%;display:block;"></canvas></div>` +
      `<div class="ms-stats">` +
        `<div class="ms-stat"><div class="ms-stat__v" id="hero-tps">&mdash;</div><div class="ms-stat__l">tok / sec</div></div>` +
        `<div class="ms-stat"><div class="ms-stat__v" id="hero-ctx">&mdash;</div><div class="ms-stat__l">context</div></div>` +
        `<div class="ms-stat"><div class="ms-stat__v">${serving.size_bytes > 0 ? (serving.size_bytes / 1e9).toFixed(1) : "&mdash;"}<span class="ms-stat__u">GB</span></div><div class="ms-stat__l">memory</div></div>` +
      `</div>` +
      `<div class="ms-hero__actions">` +
        `<button class="ms-btn ms-btn--primary" id="hero-stop">Stop serving</button>` +
        `<button class="ms-btn" id="hero-chat">Open chat</button>` +
        `<button class="ms-btn ms-btn--icon${openCfg === serving.id ? " ms-btn--icon-on" : ""}" id="hero-cfg" title="Configure" aria-label="Configure">${GEAR}</button>` +
      `</div>`;
    heroHost.querySelector("#hero-stop")?.addEventListener("click", async () => {
      try { await invoke("unload_model", { modelId: serving.id }); } catch (e) { showError(String(e)); }
      await refresh(); startPolling();
    });
    heroHost.querySelector("#hero-chat")?.addEventListener("click", () => openChatWindow());
    heroHost.querySelector("#hero-cfg")?.addEventListener("click", () => toggleCfg(serving.id));
    void fillHeroStats(serving);
  } else if (loading) {
    const name = prettyName(loading.name || loading.id);
    heroHost.innerHTML =
      `<div class="ms-hero__label">Saddling up</div>` +
      `<div class="ms-hero__name">${escapeHtml(name)}</div>` +
      `<div class="ms-hero__sub">Loading into memory…</div>` +
      `<div class="ms-hero__bar"><div class="ms-hero__bar-fill"></div></div>` +
      `<div class="ms-hero__barlabel">fitting layers to your hardware</div>`;
  } else {
    heroHost.innerHTML =
      `<div class="ms-hero__quiet">The ranch is quiet.</div>` +
      `<div class="ms-hero__quietsub">Load a model below to start serving. Nothing leaves the valley.</div>`;
  }

  if (label) label.textContent = hero ? "Switch to" : "Models";

  // ── LIST (everything that is not the hero) ──
  listHost.innerHTML = "";
  const rest = models
    .filter((m) => m !== hero)
    .sort((a, b) => prettyName(a.id).localeCompare(prettyName(b.id)));

  if (rest.length === 0) {
    listHost.innerHTML = `<div class="ms-empty">${
      router.status === "running" ? "No other models. Discover more below." : "Starting the router…"
    }</div>`;
  }

  rest.forEach((m) => {
    const cloud = m.need_download;
    const loaded = LOADED(m.status);
    const dotClass = loaded ? "ms-row__dot--on" : cloud ? "ms-row__dot--cloud" : "ms-row__dot--idle";
    const row = makeRow(dotClass, prettyName(m.name || m.id), rowSub(m), cloud);

    // Clicking a downloaded model's name opens its config panel inline.
    if (!cloud) {
      const bodyEl = row.querySelector<HTMLElement>(".ms-row__body");
      if (bodyEl) { bodyEl.style.cursor = "pointer"; bodyEl.onclick = () => toggleCfg(m.id); }
    }

    // Configure gear (downloaded models only) — hover-revealed, opens inline.
    if (!cloud) {
      const cfgBtn = document.createElement("button");
      cfgBtn.className = "ms-row__cfg" + (openCfg === m.id ? " ms-row__cfg--on" : "");
      cfgBtn.title = "Configure";
      cfgBtn.setAttribute("aria-label", "Configure " + prettyName(m.name || m.id));
      cfgBtn.innerHTML = GEAR;
      cfgBtn.onclick = (e) => { e.stopPropagation(); toggleCfg(m.id); };
      row.appendChild(cfgBtn);
    }

    const btn = document.createElement("button");
    btn.className = loaded || cloud ? "ms-row__get" : "ms-row__load";
    btn.textContent = loaded ? "Stop" : cloud ? "Get" : "Load";
    btn.onclick = async () => {
      if (loaded) {
        try { await invoke("unload_model", { modelId: m.id }); } catch (e) { showError(String(e)); }
        await refresh(); startPolling(); return;
      }
      if (cloud) { view = "discover"; render(); return; }
      try { await invoke("load_model", { modelId: m.id }); } catch (e) { showError(String(e)); }
      await refresh(); startPolling();
    };
    row.appendChild(btn);

    listHost.appendChild(row);
    // Config panel opens directly beneath the row it belongs to.
    if (openCfg === m.id) listHost.appendChild(cfgExpander());
  });

  // The serving model's gear lives on the hero, so anchor its panel at the top.
  if (openCfg && hero && openCfg === hero.id && !listHost.querySelector("#cfg-open")) {
    listHost.insertBefore(cfgExpander(), listHost.firstChild);
  }

  // No dither.refresh() here — render() (our only caller) refreshes after us.
}

function renderDiscover() {
  // Discover has no serving hero — clear it so the list owns the card.
  const heroHost = document.getElementById("hero");
  if (heroHost) heroHost.innerHTML = "";
  const host = $("models");
  host.innerHTML = "";

  if (catalog.length === 0) {
    host.innerHTML = `<div class="ms-empty">Nothing new to discover right now.</div>`;
    dither?.refresh();
    return;
  }

  catalog.forEach((e) => {
    const prog = dl.get(e.id);
    const pct = prog && prog.total ? Math.round((prog.done / prog.total) * 100) : 0;
    const dotClass = e.installed ? "ms-row__dot--on" : prog ? "ms-row__dot--dl" : "ms-row__dot--cloud";
    const sub = `${e.approx_gb.toFixed(1)} GB · ${e.description || e.group}`;
    const row = makeRow(dotClass, e.name, sub, !e.installed);

    if (e.installed) {
      const done = document.createElement("span");
      done.className = "ms-row__get";
      done.textContent = "Installed";
      row.appendChild(done);
    } else if (prog) {
      const pctEl = document.createElement("span");
      pctEl.className = "ms-row__pct";
      pctEl.textContent = prog.total ? `${pct}%` : "…";
      row.appendChild(pctEl);
      const cancel = document.createElement("button");
      cancel.className = "ms-row__get";
      cancel.textContent = "Cancel";
      cancel.onclick = () => invoke("cancel_download", { id: e.id });
      row.appendChild(cancel);
    } else {
      const getBtn = document.createElement("button");
      getBtn.className = "ms-row__load";
      getBtn.textContent = "Get";
      getBtn.onclick = async () => {
        dl.set(e.id, { done: 0, total: 0 });
        renderDiscover();
        try {
          await invoke("download_model", { id: e.id });
        } catch (err) {
          dl.delete(e.id);
          showError(String(err));
          renderDiscover();
        }
      };
      row.appendChild(getBtn);
    }

    host.appendChild(row);

    // Solid progress bar beneath a downloading row (the design's discover bar).
    if (prog) {
      const track = document.createElement("div");
      track.className = "ms-prog";
      const fill = document.createElement("div");
      fill.className = "ms-prog__fill";
      fill.style.width = prog.total ? `${pct}%` : "6%";
      track.appendChild(fill);
      host.appendChild(track);
    }
  });

  dither?.refresh();
}

async function hydrateCfg(id: string) {
  const host = document.getElementById("cfg-open");
  if (!host) return;
  const info = await invoke<ModelInfo>("model_info", { modelId: id });
  if (document.getElementById("cfg-open") !== host) return;
  const ov: ModelOverride = { ...info.override };
  const m = models.find((x) => x.id === id);
  const name = m ? prettyName(m.name || m.id) : id;
  const grow = () => fitWindow(430, 760);
  host.innerHTML = "";

  // Small helper: a titled section with breathing room.
  const section = (label?: string): HTMLDivElement => {
    const s = document.createElement("div");
    s.className = "cfg-sec";
    if (label) {
      const l = document.createElement("div");
      l.className = "cfg-sec__label";
      l.textContent = label;
      s.appendChild(l);
    }
    host.appendChild(s);
    return s;
  };
  const stillOpen = () => document.getElementById("cfg-open") === host;

  // ── Header: the model's name ──
  const header = document.createElement("div");
  header.className = "cfg-head";
  header.innerHTML = `<span class="cfg-head__name">${escapeHtml(name)}</span>`;
  host.appendChild(header);

  // ── Fit: does it fit, and how fast, at the chosen context (re-checked on change) ──
  const fit = document.createElement("div");
  fit.className = "cfg-fit";
  host.appendChild(fit);
  const renderFit = async (ctx: number | null) => {
    let f: ModelFit;
    try {
      f = await invoke<ModelFit>("fit_estimate", { modelId: id, ctxSize: ctx });
    } catch {
      fit.innerHTML = "";
      return;
    }
    if (!stillOpen()) return;
    const v = fitVerdict(f);
    fit.innerHTML =
      `<div class="cfg-fit__head">` +
        `<span class="cfg-fit__led cfg-fit__led--${v.cls}"></span>` +
        `<span class="cfg-fit__word">${v.word}</span>` +
        `<span class="cfg-fit__detail">${escapeHtml(v.detail)}</span>` +
      `</div>` +
      `<div class="cfg-fit__advice">${escapeHtml(v.advice)}</div>`;
    grow();
  };
  renderFit(ov.ctx_size ?? null);

  // ── Quality: the grade for this size against the heaviest you have installed ──
  const qSec = section("Quality");
  const qual = document.createElement("div");
  qual.className = "cfg-qual";
  qSec.appendChild(qual);
  const qualBtn = document.createElement("button");
  qualBtn.className = "ubtn ubtn--bordered cfg-action";
  qualBtn.textContent = "Measure quality";
  qSec.appendChild(qualBtn);
  const showQual = (r: QuantReport) => {
    if (!stillOpen()) return;
    qual.innerHTML = renderQuality(r);
    qualBtn.textContent = "Re-measure";
    grow();
  };
  qualBtn.onclick = async () => {
    qualBtn.disabled = true;
    const prev = qualBtn.textContent;
    qualBtn.textContent = "Measuring…";
    try {
      showQual(await invoke<QuantReport>("measure_quality", { modelId: id }));
    } catch (e) {
      if (stillOpen()) qual.innerHTML = `<div class="cfg-note">Couldn't measure: ${escapeHtml(String(e))}</div>`;
    } finally {
      qualBtn.disabled = false;
      if (qualBtn.textContent === "Measuring…") qualBtn.textContent = prev || "Measure quality";
    }
    grow();
  };
  // Show a cached grade instantly if the night shift already measured this family.
  invoke<QuantReport | null>("quality_report", { modelId: id })
    .then((r) => { if (r) showQual(r); })
    .catch(() => {});

  // ── Context: the one prominent control ──
  const max = info.native_ctx || 262144;
  const mem = (ctx: number) =>
    info.kv_per_token > 0 ? gb(info.file_bytes + ctx * info.kv_per_token) : "n/a";
  const cSec = section(info.native_ctx ? `Context length · up to ${tierLabel(info.native_ctx)}` : "Context length");
  const pills = document.createElement("div");
  pills.className = "cfg-pills";
  const mk = (text: string, val: number | null, sub: string) => {
    const b = document.createElement("button");
    b.className = "cfg-pill" + ((ov.ctx_size ?? null) === val ? " cfg-pill--on" : "");
    b.innerHTML = `${text}<span class="cfg-pill__sub">${sub}</span>`;
    b.onclick = () => {
      ov.ctx_size = val;
      pills.querySelectorAll(".cfg-pill").forEach((el) => el.classList.remove("cfg-pill--on"));
      b.classList.add("cfg-pill--on");
      renderFit(val);
    };
    return b;
  };
  pills.appendChild(mk("Auto", null, "fit"));
  for (const t of CTX_TIERS.filter((t) => t <= max)) pills.appendChild(mk(tierLabel(t), t, mem(t)));
  cSec.appendChild(pills);

  // ── Advanced (folded): sampling + a tool-call check most people never touch ──
  const adv = document.createElement("details");
  adv.className = "cfg-adv";
  adv.innerHTML = `<summary class="cfg-adv__summary">Advanced</summary>`;
  adv.addEventListener("toggle", grow);

  const fields: [keyof ModelOverride, string][] = [
    ["temp", "Temperature"], ["top_p", "Top-p"], ["top_k", "Top-k"], ["min_p", "Min-p"],
    ["repeat_penalty", "Repeat"], ["presence_penalty", "Presence"], ["frequency_penalty", "Frequency"],
  ];
  const grid = document.createElement("div");
  grid.className = "cfg-grid";
  for (const [k, lbl] of fields) {
    const f = document.createElement("label");
    f.className = "cfg-field";
    f.innerHTML = `<span>${lbl}</span><input type="number" step="0.05" value="${ov[k] ?? ""}" placeholder="auto" />`;
    const inp = f.querySelector("input") as HTMLInputElement;
    inp.oninput = () => { (ov[k] as number | null) = inp.value === "" ? null : Number(inp.value); };
    grid.appendChild(f);
  }
  adv.appendChild(grid);

  const rel = document.createElement("div");
  rel.className = "cfg-rel";
  const relBtn = document.createElement("button");
  relBtn.className = "ubtn cfg-action";
  relBtn.textContent = "Test tool calls";
  relBtn.onclick = async () => {
    relBtn.disabled = true;
    relBtn.textContent = "Testing…";
    try {
      const r = await invoke<RelReport>("eval_tool_reliability", { modelId: id });
      if (stillOpen()) rel.innerHTML = renderRel(r);
    } catch (e) {
      rel.innerHTML = `<div class="cfg-note">Test failed: ${escapeHtml(String(e))}</div>`;
    } finally {
      relBtn.disabled = false;
      if (relBtn.textContent === "Testing…") relBtn.textContent = "Test tool calls";
    }
    grow();
  };
  rel.appendChild(relBtn);
  adv.appendChild(rel);
  host.appendChild(adv);

  // ── Actions: Save / Reset, with Delete a quiet ghost ──
  const actions = document.createElement("div");
  actions.className = "cfg-actions";

  const delBtn = document.createElement("button");
  delBtn.className = "ubtn cfg-actions__del";
  delBtn.textContent = "Delete";
  delBtn.onclick = async () => {
    const msg = m?.local
      ? `Delete ${name} from disk?`
      : `Delete ${name}? This removes it from the shared cache (also used by the Llama app).`;
    if (!confirm(msg)) return;
    try { await invoke("delete_model", { modelId: id }); } catch (err) { showError(String(err)); }
    if (openCfg === id) openCfg = null;
    await refresh();
    startPolling();
  };

  const right = document.createElement("div");
  right.className = "cfg-actions__right";

  const reset = document.createElement("button");
  reset.className = "ubtn";
  reset.textContent = "Reset";
  reset.onclick = async () => {
    await invoke("set_model_config", { modelId: id, override: {} });
    openCfg = null; await refresh(); startPolling();
  };

  const save = document.createElement("button");
  save.className = "ubtn ubtn--bordered";
  save.textContent = "Save";
  save.onclick = async () => {
    await invoke("set_model_config", { modelId: id, override: ov });
    openCfg = null; await refresh(); startPolling();
  };

  right.append(reset, save);
  actions.append(delBtn, right);
  host.appendChild(actions);

  grow();
  dither?.refresh();
}

function render() {
  setHeader();
  const dLink = document.getElementById("discover-link");
  if (view === "installed") {
    const n = catalog.filter((c) => !c.installed).length;
    if (dLink) dLink.textContent = n > 0 ? `Discover ${n} more` : "Discover models";
    renderSelector();
  } else {
    const lbl = document.getElementById("list-label");
    if (lbl) lbl.textContent = "Discover";
    if (dLink) dLink.textContent = "← Installed";
    renderDiscover();
  }
  lastSig = sigOf();
  fitWindow(430, 760);
  // Per-model config opens inline via the hero / row gear (toggleCfg sets openCfg).
  if (view === "installed" && openCfg) void hydrateCfg(openCfg);
  dither?.refresh();
}

// A cheap signature of what the model list shows, so polling can skip a full
// re-render (and the glyph teardown) when nothing visible has changed.
const sigOf = () => router.status + "|" + view + "|" + models.map((x) => x.id + ":" + x.status).join(",");
let lastSig = "";

function showError(msg: string) {
  const err = $("error");
  const raw = msg.replace(/^error:\s*/, "");
  const isConnErr = /connection|refused|tcp|timed? ?out/i.test(raw);
  // Build DOM nodes to avoid innerHTML injection of untrusted error text.
  err.textContent = "";
  if (isConnErr) {
    const friendly = document.createElement("span");
    friendly.className = "error__friendly";
    friendly.textContent = "The model server is not ready yet. Give it a few seconds and try again.";
    const br = document.createElement("br");
    const detail = document.createElement("span");
    detail.className = "error__raw";
    detail.textContent = raw;
    err.appendChild(friendly);
    err.appendChild(br);
    err.appendChild(detail);
  } else {
    err.textContent = raw;
  }
  err.classList.remove("hidden");
}

async function notify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {}
}

const RELEASES = "https://github.com/madalintat/LlamaRanch/releases/latest";

// Check GitHub Releases for a newer, signed build. On AppImage/Windows the
// update installs in place; on a .deb install (which apt owns) we point the
// user at the release page instead.
async function checkForUpdate() {
  let update;
  try {
    update = await check();
  } catch {
    return;
  }
  if (!update) return;

  const banner = $("update");
  const now = $("update-now") as HTMLButtonElement;
  $("update-text").textContent = `LlamaRanch ${update.version} is available.`;
  banner.classList.remove("hidden");
  notify("Update available", `LlamaRanch ${update.version} is ready to install.`);

  now.onclick = async () => {
    now.disabled = true;
    now.textContent = "Updating...";
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      // self-update isn't supported for every install (e.g. a .deb, which apt
      // owns), and downloads can genuinely fail. Tell the user, then offer the
      // release page as a manual fallback.
      $("update-text").textContent = "Couldn't update automatically. Get it from Releases.";
      console.error("update failed:", e);
      now.disabled = false;
      now.textContent = "Open Releases";
      now.onclick = () => openUrl(RELEASES);
    }
  };
  $("update-later").onclick = () => banner.classList.add("hidden");
}

async function refresh() {
  [router, models, catalog] = await Promise.all([
    invoke<RouterStatus>("router_status"),
    invoke<ModelView[]>("list_models"),
    invoke<CatalogView[]>("list_catalog"),
  ]);
  // Show a clean host:port/v1 (scheme stripped); copying still yields the full URL.
  ($("endpoint") as HTMLElement).textContent = router.endpoint.replace(/^https?:\/\//, "");
  if (router.status.startsWith("error")) showError(router.status);
  else $("error").classList.add("hidden");
  render();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const [r, m] = await Promise.all([
      invoke<RouterStatus>("router_status"),
      invoke<ModelView[]>("list_models"),
    ]);
    router = r;
    models = m;
    // Only repaint when something visible changed, so the canvas glyphs aren't
    // torn down and restarted (flicker) on every idle poll.
    if (sigOf() !== lastSig) render();
    const settling = r.status !== "running" || m.some((x) => BUSY(x.status));
    if (!settling) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }, 1500) as unknown as number;
}

// ── ⌘K Command bar ─────────────────────────────────────────────────────────

let cmdkQuery = "";
let cmdkSelected = 0;

function cmdkModels(): ModelView[] {
  const q = cmdkQuery.trim().toLowerCase();
  const sorted = [...models].sort((a, b) => {
    const al = LOADED(a.status) ? 0 : 1, bl = LOADED(b.status) ? 0 : 1;
    return al - bl || prettyName(a.id).localeCompare(prettyName(b.id));
  });
  if (!q) return sorted;
  return sorted.filter((m) =>
    prettyName(m.name || m.id).toLowerCase().includes(q) ||
    m.id.toLowerCase().includes(q)
  );
}

function renderCmdk() {
  const list = $("cmdk-list");
  const typed = document.getElementById("cmdk-typed")!;
  const placeholder = document.getElementById("cmdk-placeholder")!;
  const footerEp = document.getElementById("cmdk-footer-ep")!;
  const sectionLabel = document.getElementById("cmdk-section-label")!;

  typed.textContent = cmdkQuery;
  placeholder.style.display = cmdkQuery ? "none" : "";
  footerEp.textContent = "LOCAL · " + router.endpoint.replace(/^https?:\/\//, "");

  const ms = cmdkModels();
  const hasLoaded = ms.some((m) => LOADED(m.status));
  sectionLabel.textContent = hasLoaded ? "loaded · ready now" : "available models";

  list.innerHTML = "";
  const isDark = document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);

  if (cmdkSelected >= ms.length) cmdkSelected = Math.max(0, ms.length - 1);

  ms.forEach((m, idx) => {
    const loaded = LOADED(m.status);
    const name = prettyName(m.name || m.id);
    const num = String(idx + 1).padStart(2, "0");
    const isSelected = idx === cmdkSelected;

    const parts: string[] = [];
    if (m.size_bytes > 0) parts.push(gb(m.size_bytes));
    else if (m.need_download) parts.push("CLOUD");
    if (m.placement) parts.push(m.placement.toUpperCase());
    if (m.vision) parts.push("VISION");
    const metaStr = parts.join(" / ");

    const stateWord = loaded ? "serving" : m.need_download ? "get" : "load";
    const stateClass = loaded ? "cmdk-row__state--serving" : "cmdk-row__state--action";

    const row = document.createElement("div");
    row.className = "cmdk-row" + (isSelected ? " cmdk-row--selected" : "");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", isSelected ? "true" : "false");

    // Scan canvas for serving/selected row
    if (loaded || isSelected) {
      const cv = document.createElement("canvas");
      cv.className = "cmdk-row__scan";
      cv.dataset.glyph = "scan";
      cv.dataset.seed = String((idx + 1) * 3);
      cv.dataset.cell = "2.4";
      cv.dataset.color = isDark ? "#33312a" : "#ddd9cd";
      row.appendChild(cv);
    }

    const pn = document.createElement("span");
    pn.className = "partno";
    pn.textContent = num;
    row.appendChild(pn);

    const body = document.createElement("div");
    body.className = "cmdk-row__body";
    const nameEl = document.createElement("div");
    nameEl.className = "cmdk-row__name" + (loaded ? " cmdk-row__name--serving" : "");
    nameEl.textContent = name;
    const metaEl = document.createElement("div");
    metaEl.className = "meta";
    metaEl.textContent = metaStr;
    body.appendChild(nameEl);
    body.appendChild(metaEl);
    row.appendChild(body);

    const stateEl = document.createElement("span");
    stateEl.className = `cmdk-row__state ${stateClass}`;
    stateEl.textContent = stateWord;
    row.appendChild(stateEl);

    // ⏎ chip on selected row
    if (isSelected) {
      const chip = document.createElement("span");
      chip.className = "cmdk-key";
      chip.textContent = "⏎";
      row.appendChild(chip);
    }

    row.addEventListener("mousedown", (e) => {
      e.preventDefault(); // don't blur
      cmdkSelected = idx;
      cmdkActivate(ms);
    });
    row.addEventListener("mousemove", () => {
      if (cmdkSelected !== idx) {
        cmdkSelected = idx;
        renderCmdk();
      }
    });

    list.appendChild(row);
  });

  if (ms.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:20px 18px; font-family:var(--mono); font-size:11px; color:var(--faint); text-align:center;";
    empty.textContent = "no models match";
    list.appendChild(empty);
  }

  dither?.refresh();
}

async function cmdkActivate(ms: ModelView[]) {
  const m = ms[cmdkSelected];
  if (!m) { closeCmdk(); return; }
  if (LOADED(m.status)) {
    // Already serving - just close
    closeCmdk();
    return;
  }
  closeCmdk();
  try {
    await invoke("load_model", { modelId: m.id });
  } catch (err) { showError(String(err)); }
  await refresh();
  startPolling();
}

function openCmdk() {
  cmdkQuery = "";
  cmdkSelected = 0;
  const overlay = $("cmdk-overlay");
  overlay.classList.remove("hidden");
  // Sync band color
  updateHairlineColor();
  renderCmdk();
  // Scroll selected into view after paint
  requestAnimationFrame(() => {
    const selected = document.querySelector(".cmdk-row--selected");
    selected?.scrollIntoView({ block: "nearest" });
  });
}

function closeCmdk() {
  $("cmdk-overlay").classList.add("hidden");
  cmdkQuery = "";
  cmdkSelected = 0;
}

async function init() {
  (document.getElementById("brand-mark") as HTMLImageElement).src = llamaMark;

  dither = mountDither();
  updateHairlineColor(); // sync canvas data-color to current theme
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    // Only act when no explicit override is set (system mode).
    if (!document.documentElement.dataset.theme) {
      updateHairlineColor();
      render();
    }
  });

  // Copy the endpoint; the pill flashes "copied".
  $("copy").onclick = async () => {
    await navigator.clipboard.writeText(router.endpoint || "");
    const label = $("copy-label");
    label.textContent = "copied";
    setTimeout(() => (label.textContent = ""), 1200);
  };

  // "Discover N more" / "← Installed" toggles the model list view.
  $("discover-link").onclick = () => {
    view = view === "installed" ? "discover" : "installed";
    render();
  };

  // Open the showroom chat window (always reachable from the footer).
  $("chat-btn").onclick = () => openChatWindow();

  // ── ⌘K / Ctrl+K global keyboard handler ──────────────────────────────
  document.addEventListener("keydown", (e) => {
    const overlay = $("cmdk-overlay");
    const isOpen = !overlay.classList.contains("hidden");

    // Toggle open: ⌘K (macOS) or Ctrl+K (Linux/Windows)
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      if (isOpen) closeCmdk();
      else openCmdk();
      return;
    }

    if (!isOpen) return;

    if (e.key === "Escape") {
      e.preventDefault();
      closeCmdk();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const ms = cmdkModels();
      cmdkSelected = ms.length > 0 ? (cmdkSelected + 1) % ms.length : 0;
      renderCmdk();
      document.querySelector(".cmdk-row--selected")?.scrollIntoView({ block: "nearest" });
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      const ms = cmdkModels();
      cmdkSelected = ms.length > 0 ? (cmdkSelected - 1 + ms.length) % ms.length : 0;
      renderCmdk();
      document.querySelector(".cmdk-row--selected")?.scrollIntoView({ block: "nearest" });
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      void cmdkActivate(cmdkModels());
      return;
    }

    // Typing: update search query (printable chars + Backspace)
    if (e.key === "Backspace") {
      e.preventDefault();
      cmdkQuery = cmdkQuery.slice(0, -1);
      cmdkSelected = 0;
      renderCmdk();
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      cmdkQuery += e.key;
      cmdkSelected = 0;
      renderCmdk();
    }
  });

  // Close on backdrop click
  $("cmdk-overlay").addEventListener("mousedown", (e) => {
    if (e.target === $("cmdk-overlay")) closeCmdk();
  });

  // Settings lives in its own window (defined in tauri.conf.json); just reveal it.
  $("settings-btn").onclick = async () => {
    const w = await WebviewWindow.getByLabel("settings");
    if (!w) return;
    // Centering is best-effort: never let it block the window from opening.
    try { await w.center(); } catch { /* ignore */ }
    await w.show();
    await w.setFocus();
  };
  // The Settings window emits this after saving; refresh the panel to match.
  await listen("config-changed", async () => { await refresh(); startPolling(); });

  // Global OS shortcut (registered by Rust) emits "open-cmdk" to show the command bar.
  await listen("open-cmdk", () => openCmdk());

  // Live theme updates from the Settings window.
  await listen<Theme>("theme-changed", (e) => {
    applyTheme(e.payload);
    updateHairlineColor();
    render();
  });

  await listen<{ id: string; done: number; total: number }>("download:progress", (e) => {
    dl.set(e.payload.id, { done: e.payload.done, total: e.payload.total });
    if (view === "discover") renderDiscover();
  });
  await listen<{ id: string }>("download:done", async (e) => {
    dl.delete(e.payload.id);
    await refresh();
  });
  await listen<{ id: string; error: string }>("download:error", (e) => {
    dl.delete(e.payload.id);
    if (e.payload.error !== "cancelled") showError(`Download failed: ${e.payload.error}`);
    if (view === "discover") renderDiscover();
  });

  await refresh();
  startPolling();
  checkForUpdate();
}

init();
