import { invoke } from "@tauri-apps/api/core";
import { exit, relaunch } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getVersion } from "@tauri-apps/api/app";
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
  needs_smaller_quant: boolean; native_ctx: number; cache_type: string;
  kv_per_token: number; kv_per_token_f16: number;
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

function setHeader() {
  const el = $("status");
  const label = $("status-label");
  el.className = "head__status";
  if (router.status.startsWith("error")) {
    el.classList.add("head__status--error");
    label.textContent = "error";
    return;
  }
  if (router.status !== "running") {
    el.classList.add("head__status--starting");
    label.textContent = "starting";
    return;
  }
  const loaded = models.filter((m) => LOADED(m.status));
  const loading = models.find((m) => BUSY(m.status));
  if (loading) {
    el.classList.add("head__status--starting");
    label.textContent = "loading";
  } else {
    el.classList.add("head__status--running");
    if (loaded.length > 1) {
      label.textContent = `serving ${loaded.length}`;
    } else if (loaded.length === 1) {
      label.textContent = `serving ${prettyName(loaded[0].name || loaded[0].id)}`;
    } else {
      label.textContent = "running";
    }
  }
}

function renderInstalled() {
  const host = $("models");
  host.innerHTML = "";
  if (models.length === 0) {
    const msg = router.status === "running"
      ? "no models yet, try discover"
      : "starting router…";
    host.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }

  const list = [...models].sort((a, b) => {
    const al = LOADED(a.status) ? 0 : 1, bl = LOADED(b.status) ? 0 : 1;
    return al - bl || prettyName(a.id).localeCompare(prettyName(b.id));
  });

  list.forEach((m, idx) => {
    const loaded = LOADED(m.status);
    const busy = BUSY(m.status);
    const name = prettyName(m.name || m.id);
    const num = String(idx + 1).padStart(2, "0");

    // Build .meta string: "2.4 GB / GPU / VISION"
    const parts: string[] = [];
    if (m.size_bytes > 0) parts.push(gb(m.size_bytes));
    else if (m.need_download) parts.push("CLOUD");
    if (m.placement) parts.push(m.placement.toUpperCase());
    if (m.vision) parts.push("VISION");
    const metaStr = parts.join(" / ");

    const row = document.createElement("div");
    row.className = "row" + (loaded ? " row--serving" : "");

    // Scan canvas behind serving row
    if (loaded) {
      const cv = document.createElement("canvas");
      cv.className = "row__scan";
      cv.dataset.glyph = "scan";
      cv.dataset.seed = String((idx + 1) * 3);
      cv.dataset.cell = "2.4";
      cv.dataset.color = document.documentElement.dataset.theme === "dark" ||
        (!document.documentElement.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches)
        ? "#33312a" : "#ddd9cd";
      row.appendChild(cv);
    }

    // Part number
    const pn = document.createElement("span");
    pn.className = "partno";
    pn.textContent = num;
    row.appendChild(pn);

    // Body
    const body = document.createElement("div");
    body.className = "row__body";
    const nameEl = document.createElement("div");
    nameEl.className = "row__name" + (loaded ? " row__name--serving" : "");
    nameEl.title = name;
    nameEl.textContent = name;
    const metaEl = document.createElement("div");
    metaEl.className = "meta";
    metaEl.textContent = metaStr;
    body.appendChild(nameEl);
    body.appendChild(metaEl);
    row.appendChild(body);

    // Cfg toggle (hover-revealed, only for downloaded models)
    const downloaded = m.local || !m.need_download;
    if (downloaded) {
      const cfgBtn = document.createElement("button");
      cfgBtn.className = "ubtn row__cfg-btn";
      cfgBtn.textContent = "cfg";
      cfgBtn.title = "Configure";
      cfgBtn.onclick = (e) => {
        e.stopPropagation();
        openCfg = openCfg === m.id ? null : m.id;
        render();
      };
      row.appendChild(cfgBtn);
    }

    // Primary action ubtn
    const actionLabel = loaded ? "stop" : m.need_download ? "get" : "load";
    const actionBtn = document.createElement("button");
    actionBtn.className = "ubtn row__action";
    actionBtn.textContent = actionLabel;
    actionBtn.disabled = busy;
    actionBtn.onclick = async () => {
      try {
        if (loaded) await invoke("unload_model", { modelId: m.id });
        else await invoke("load_model", { modelId: m.id });
      } catch (err) { showError(String(err)); }
      await refresh();
      startPolling();
    };
    row.appendChild(actionBtn);

    // Square LED
    const led = document.createElement("span");
    led.className = "led row__led " + (
      loaded ? "led--on" : m.need_download ? "led--cloud" : "led--idle"
    );
    row.appendChild(led);

    host.appendChild(row);

    // Config expander immediately after this row
    if (downloaded && openCfg === m.id) {
      const ph = document.createElement("div");
      ph.className = "cfg-expander";
      ph.id = "cfg-open";
      ph.innerHTML = `<div class="cfg-expander__label">Loading…</div>`;
      host.appendChild(ph);
    }
  });

  dither?.refresh();
}

function renderDiscover() {
  const host = $("models");
  host.innerHTML = "";

  catalog.forEach((e, idx) => {
    const num = String(idx + 1).padStart(2, "0");
    const prog = dl.get(e.id);

    const row = document.createElement("div");
    row.className = "disc-row";

    const head = document.createElement("div");
    head.className = "disc-row__head";

    const pn = document.createElement("span");
    pn.className = "partno";
    pn.textContent = num;
    head.appendChild(pn);

    const body = document.createElement("div");
    body.className = "disc-row__body";
    const nameEl = document.createElement("div");
    nameEl.className = "disc-row__name" + (e.installed ? " disc-row__name--installed" : "");
    nameEl.textContent = e.name;
    const metaEl = document.createElement("div");
    metaEl.className = "meta";
    metaEl.textContent = `~${e.approx_gb.toFixed(1)} GB · ${e.description || e.group}`;
    body.appendChild(nameEl);
    body.appendChild(metaEl);
    head.appendChild(body);

    // Action
    const pct = prog && prog.total ? Math.round((prog.done / prog.total) * 100) : 0;
    if (e.installed) {
      const done = document.createElement("span");
      done.className = "ubtn";
      done.textContent = "done ▣";
      head.appendChild(done);
    } else if (prog) {
      const pctEl = document.createElement("span");
      pctEl.className = "disc-row__pct";
      pctEl.textContent = prog.total ? `${pct}%` : "…";
      head.appendChild(pctEl);
      const cancel = document.createElement("button");
      cancel.className = "ubtn";
      cancel.textContent = "cancel";
      cancel.onclick = () => invoke("cancel_download", { id: e.id });
      head.appendChild(cancel);
    } else {
      const getBtn = document.createElement("button");
      getBtn.className = "ubtn ubtn--bordered";
      getBtn.textContent = "get";
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
      head.appendChild(getBtn);
    }

    row.appendChild(head);

    // Dithered progress bar (only during download)
    if (prog) {
      const track = document.createElement("div");
      track.className = "progress-track";
      const fill = document.createElement("div");
      fill.className = "progress-fill";
      fill.style.width = prog.total ? `${pct}%` : "6%";
      const isDark = document.documentElement.dataset.theme === "dark" ||
        (!document.documentElement.dataset.theme && window.matchMedia("(prefers-color-scheme: dark)").matches);
      const cv = document.createElement("canvas");
      cv.dataset.glyph = "band";
      cv.dataset.seed = String(idx + 3);
      cv.dataset.cell = "2";
      cv.dataset.color = isDark ? "#ece9df" : "#15140f";
      cv.style.width = "100%";
      cv.style.height = "10px";
      fill.appendChild(cv);
      track.appendChild(fill);
      row.appendChild(track);
    }

    host.appendChild(row);
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
  host.innerHTML = "";

  // Context tier picker
  const max = info.native_ctx || 262144;
  const mem = (ctx: number) =>
    info.kv_per_token > 0 ? gb(info.file_bytes + ctx * info.kv_per_token) : "n/a";
  const ctxLabel = document.createElement("div");
  ctxLabel.className = "cfg-expander__label";
  ctxLabel.textContent = info.native_ctx ? `Context · max ${tierLabel(info.native_ctx)}` : "Context";
  host.appendChild(ctxLabel);

  // Fit panel: does this model fit, and how to make it fit, at the chosen context.
  // Re-queried whenever the context changes, so the verdict tracks the choice.
  const fit = document.createElement("div");
  fit.className = "cfg-fit";
  const renderFit = async (ctx: number | null) => {
    let f: ModelFit;
    try {
      f = await invoke<ModelFit>("fit_estimate", { modelId: id, ctxSize: ctx });
    } catch {
      fit.innerHTML = "";
      return;
    }
    if (document.getElementById("cfg-open") !== host) return;
    const v = fitVerdict(f);
    fit.innerHTML =
      `<div class="cfg-fit__head">` +
        `<span class="cfg-fit__led cfg-fit__led--${v.cls}"></span>` +
        `<span class="cfg-fit__word">${v.word}</span>` +
        `<span class="cfg-fit__detail">${v.detail}</span>` +
      `</div>` +
      `<div class="cfg-fit__advice">${v.advice}</div>`;
    fitWindow(360);
  };

  const pills = document.createElement("div");
  pills.className = "cfg-expander__pills";
  const mk = (text: string, val: number | null, sub: string) => {
    const b = document.createElement("button");
    b.className = "cfg-expander__pill" + ((ov.ctx_size ?? null) === val ? " cfg-expander__pill--on" : "");
    b.innerHTML = `${text}<span class="cfg-expander__sub">${sub}</span>`;
    b.onclick = () => {
      ov.ctx_size = val;
      pills.querySelectorAll(".cfg-expander__pill").forEach((el) => el.classList.remove("cfg-expander__pill--on"));
      b.classList.add("cfg-expander__pill--on");
      renderFit(val);
    };
    return b;
  };
  pills.appendChild(mk("Auto", null, "fit"));
  for (const t of CTX_TIERS.filter((t) => t <= max)) pills.appendChild(mk(tierLabel(t), t, mem(t)));
  host.appendChild(pills);
  host.appendChild(fit);
  renderFit(ov.ctx_size ?? null);

  // Sampling fields
  const fields: [keyof ModelOverride, string][] = [
    ["temp", "temp"], ["top_p", "top-p"], ["top_k", "top-k"], ["min_p", "min-p"],
    ["repeat_penalty", "repeat"], ["presence_penalty", "presence"], ["frequency_penalty", "freq"],
  ];
  const grid = document.createElement("div");
  grid.className = "cfg-expander__grid";
  for (const [k, lbl] of fields) {
    const f = document.createElement("label");
    f.className = "cfg-expander__field";
    f.innerHTML = `<span>${lbl}</span><input type="number" step="0.05" value="${ov[k] ?? ""}" />`;
    const inp = f.querySelector("input") as HTMLInputElement;
    inp.oninput = () => { (ov[k] as number | null) = inp.value === "" ? null : Number(inp.value); };
    grid.appendChild(f);
  }
  host.appendChild(grid);

  // Actions: delete (ghost left) + reset + save (right)
  const actions = document.createElement("div");
  actions.className = "cfg-expander__actions";

  // Delete - ghost left
  const delBtn = document.createElement("button");
  delBtn.className = "ubtn";
  delBtn.textContent = "delete";
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
  right.style.display = "flex";
  right.style.gap = "8px";

  const reset = document.createElement("button");
  reset.className = "ubtn";
  reset.textContent = "reset";
  reset.onclick = async () => {
    await invoke("set_model_config", { modelId: id, override: {} });
    openCfg = null; await refresh(); startPolling();
  };

  const save = document.createElement("button");
  save.className = "ubtn ubtn--bordered";
  save.textContent = "save";
  save.onclick = async () => {
    await invoke("set_model_config", { modelId: id, override: ov });
    openCfg = null; await refresh(); startPolling();
  };

  right.append(reset, save);
  actions.append(delBtn, right);
  host.appendChild(actions);

  fitWindow(360);
  dither?.refresh();
}

function render() {
  setHeader();
  // (no resetGlyphs - per-model glyphs dropped)
  const ready = router.status === "running";
  const agentBtn = $("agent-btn") as HTMLButtonElement;
  agentBtn.disabled = !ready;
  agentBtn.title = ready ? "" : "Router is starting";
  $("tab-installed").classList.toggle("tab--active", view === "installed");
  $("tab-discover").classList.toggle("tab--active", view === "discover");
  if (view === "installed") renderInstalled();
  else renderDiscover();
  lastSig = sigOf();
  fitWindow(360);
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

  // Footer: "LLAMARANCH <appVersion> · LLAMA.CPP b<build>"
  const rawVer = (await invoke<string>("llama_cpp_version")) || "";
  const build = rawVer.match(/\b(\d{3,})\b/)?.[1];
  const appVer = await getVersion().catch(() => "");
  ($("version") as HTMLElement).textContent = [
    appVer ? `LLAMARANCH ${appVer}` : "LLAMARANCH",
    build ? `LLAMA.CPP b${build}` : rawVer ? rawVer.toUpperCase() : "LLAMA.CPP",
  ].filter(Boolean).join(" · ");

  $("tab-installed").onclick = () => { view = "installed"; render(); };
  $("tab-discover").onclick = () => { view = "discover"; render(); };

  $("copy").onclick = async () => {
    await navigator.clipboard.writeText(router.endpoint || "");
    const label = $("copy-label");
    const prev = label.textContent;
    label.textContent = "copied";
    setTimeout(() => (label.textContent = prev), 1200);
  };

  // AGENT button: opens the in-app chat window
  $("agent-btn").onclick = async () => {
    const w = await WebviewWindow.getByLabel("chat");
    if (w) {
      await w.show();
      if (typeof (w as any).unminimize === "function") {
        await (w as any).unminimize();
      }
      await w.setFocus();
    } else {
      showError("Could not open the chat window.");
    }
  };

  // ⌘K hint button - labeled based on OS
  const cmdkHint = $("cmdk-hint") as HTMLButtonElement;
  const isMac = document.documentElement.dataset.os === "macos";
  cmdkHint.textContent = isMac ? "⌘K" : "Ctrl K";
  cmdkHint.onclick = () => openCmdk();

  $("quit").onclick = () => exit(0);

  $("close-btn").onclick = async () => {
    await getCurrentWindow().hide();
    if (!localStorage.getItem("tray-hint-shown")) {
      localStorage.setItem("tray-hint-shown", "1");
      notify("LlamaRanch is still running", "Click the llama icon in your tray to reopen it.");
    }
  };

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
