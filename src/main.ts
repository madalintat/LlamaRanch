import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { listen, emit } from "@tauri-apps/api/event";
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
    if (w) { await w.show(); try { await (w as any).unminimize?.(); } catch { /* not minimized */ } await w.setFocus(); }
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

/** Open the per-model configuration window for a downloaded model. */
async function openConfigWindow(m: ModelView) {
  try {
    await emit("open-config", { modelId: m.id, name: prettyName(m.name || m.id), local: m.local });
    const w = await WebviewWindow.getByLabel("config");
    if (w) { await w.show(); try { await (w as any).unminimize?.(); } catch { /* not minimized */ } await w.setFocus(); }
  } catch (e) { showError(String(e)); }
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
        `<button class="ms-btn ms-btn--icon" id="hero-cfg" title="Configure" aria-label="Configure">${GEAR}</button>` +
      `</div>`;
    heroHost.querySelector("#hero-stop")?.addEventListener("click", async () => {
      try { await invoke("unload_model", { modelId: serving.id }); } catch (e) { showError(String(e)); }
      await refresh(); startPolling();
    });
    heroHost.querySelector("#hero-chat")?.addEventListener("click", () => openChatWindow());
    heroHost.querySelector("#hero-cfg")?.addEventListener("click", () => openConfigWindow(serving));
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

    // Clicking a downloaded model's name opens its config window.
    if (!cloud) {
      const bodyEl = row.querySelector<HTMLElement>(".ms-row__body");
      if (bodyEl) { bodyEl.style.cursor = "pointer"; bodyEl.onclick = () => openConfigWindow(m); }
    }

    // Configure gear (downloaded models only) — hover-revealed, opens the window.
    if (!cloud) {
      const cfgBtn = document.createElement("button");
      cfgBtn.className = "ms-row__cfg";
      cfgBtn.title = "Configure";
      cfgBtn.setAttribute("aria-label", "Configure " + prettyName(m.name || m.id));
      cfgBtn.innerHTML = GEAR;
      cfgBtn.onclick = (e) => { e.stopPropagation(); openConfigWindow(m); };
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
  });

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
  fitWindow(384, 760);
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
