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
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "./styles.css";
import { addGlyph, resetGlyphs } from "./glyph";
import llamaMark from "./assets/llama.svg";
import { tagOS, fitWindow } from "./platform";

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
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const LOADED = (s: string) => s === "loaded" || s === "sleeping";
const BUSY = (s: string) => s === "loading" || s === "downloading";

// A model's display name strips the "org/" prefix and ":quant" suffix so HF ids
// (e.g. "ggml-org/gemma-3-4b-it-qat-GGUF:Q4_0") read like "gemma 3 4b it qat".
const prettyName = (id: string) =>
  id.split("/").pop()!.split(":")[0].replace(/[-_]/g, " ").replace(/\bGGUF\b/i, "").trim();

type ModelOverride = {
  ctx_size?: number | null; temp?: number | null; top_p?: number | null; top_k?: number | null;
  min_p?: number | null; repeat_penalty?: number | null; presence_penalty?: number | null; frequency_penalty?: number | null;
};
type ModelInfo = { native_ctx: number; file_bytes: number; kv_per_token: number; override: ModelOverride };

const CTX_TIERS = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
const tierLabel = (n: number) => (n % 1024 === 0 ? `${n / 1024}k` : String(n));

const ICON = {
  play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 6.2c0-.82.9-1.32 1.59-.88l9 5.8a1.05 1.05 0 0 1 0 1.76l-9 5.8c-.7.44-1.59-.06-1.59-.88V6.2z"/></svg>`,
  stop: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="6.5" width="11" height="11" rx="2.6"/></svg>`,
  get: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10m0 0 3.5-3.5M12 14l-3.5-3.5M5 19h14"/></svg>`,
  gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.5 7.5 0 0 0 0-2l1.7-1.3-1.8-3.1-2 .8a7.6 7.6 0 0 0-1.7-1l-.3-2.1H9.7l-.3 2.1a7.6 7.6 0 0 0-1.7 1l-2-.8-1.8 3.1L5.6 11a7.5 7.5 0 0 0 0 2l-1.7 1.3 1.8 3.1 2-.8c.5.4 1.1.7 1.7 1l.3 2.1h3.6l.3-2.1c.6-.3 1.2-.6 1.7-1l2 .8 1.8-3.1L19.4 13z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13"/></svg>`,
};

// which model's expander is open (survives re-renders so polling won't collapse it)
let openCfg: string | null = null;

let models: ModelView[] = [];
let catalog: CatalogView[] = [];
let router: RouterStatus = { status: "starting", endpoint: "" };
let view: "installed" | "discover" = "installed";
const dl = new Map<string, { done: number; total: number }>();
let pollTimer: number | undefined;

function setHeader() {
  const el = $("status");
  const label = $("status-label");
  el.className = "status";
  if (router.status.startsWith("error")) {
    el.classList.add("status--error");
    label.textContent = "router error";
    return;
  }
  if (router.status !== "running") {
    el.classList.add("status--starting");
    label.textContent = "starting router...";
    return;
  }
  const loaded = models.filter((m) => LOADED(m.status));
  const loading = models.find((m) => BUSY(m.status));
  if (loaded.length > 1) {
    el.classList.add("status--running");
    label.textContent = `serving ${loaded.length} models`;
  } else if (loaded.length === 1) {
    el.classList.add("status--running");
    label.textContent = `serving ${prettyName(loaded[0].name || loaded[0].id)}`;
  } else if (loading) {
    el.classList.add("status--starting");
    label.textContent = "loading…";
  } else {
    el.classList.add("status--running");
    label.textContent = "ready";
  }
}

function renderInstalled() {
  const host = $("models");
  host.innerHTML = "";
  if (models.length === 0) {
    const msg = router.status === "running"
      ? "No models yet. Try the Discover tab."
      : "Starting router…";
    host.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }

  // One flat list — loaded models first, then alphabetical. No category groups.
  const list = [...models].sort((a, b) => {
    const al = LOADED(a.status) ? 0 : 1, bl = LOADED(b.status) ? 0 : 1;
    return al - bl || prettyName(a.id).localeCompare(prettyName(b.id));
  });

  for (const m of list) {
    const loaded = LOADED(m.status);
    const busy = BUSY(m.status);
    const name = prettyName(m.name || m.id);
    const card = document.createElement("div");
    card.className = "card" + (loaded ? " is-serving" : "");
    card.dataset.placement = m.placement;

    const visionTag = m.vision ? `<span class="tag tag--vision">vision</span>` : "";
    // Size when known (local file or resolved HF cache); only a model the router
    // must still fetch (need_download) reads as "cloud".
    const sizeCell = m.size_bytes > 0
      ? `<span class="card__size">${gb(m.size_bytes)}</span>`
      : `<span class="card__size">${m.need_download ? "cloud" : "ready"}</span>`;
    const placementTag = m.placement
      ? `<span class="dot">&middot;</span><span class="tag tag--${m.placement}">${m.placement}</span>`
      : "";

    card.innerHTML = `
      <canvas class="card__logo"></canvas>
      <div class="card__body">
        <div class="card__name" title="${esc(name)}">${esc(name)}</div>
        <div class="card__meta">
          ${sizeCell}
          ${placementTag}
          ${visionTag}
        </div>
      </div>`;

    const downloaded = m.local || !m.need_download;
    const actions = document.createElement("div");
    actions.className = "card__actions";

    const iconBtn = (cls: string, svg: string, title: string, onclick: (e: MouseEvent) => void) => {
      const b = document.createElement("button");
      b.className = "act " + cls;
      b.innerHTML = svg;
      b.title = title;
      b.onclick = onclick;
      return b;
    };

    if (downloaded) {
      actions.appendChild(
        iconBtn("act--cfg", ICON.gear, "Configure", (e) => {
          e.stopPropagation();
          openCfg = openCfg === m.id ? null : m.id;
          render();
        }),
      );
      actions.appendChild(
        iconBtn("act--del", ICON.trash, "Delete", async () => {
          const msg = m.local
            ? `Delete ${name} from disk?`
            : `Delete ${name}? This removes it from the shared cache (also used by the Llama app).`;
          if (!confirm(msg)) return;
          try { await invoke("delete_model", { modelId: m.id }); } catch (err) { showError(String(err)); }
          if (openCfg === m.id) openCfg = null;
          await refresh();
        }),
      );
    }

    const primary = iconBtn(
      "act--primary" + (loaded ? " is-stop" : "") + (busy ? " is-busy" : ""),
      loaded ? ICON.stop : m.need_download ? ICON.get : ICON.play,
      loaded ? "Stop" : m.need_download ? "Get & load" : "Load",
      async () => {
        try {
          if (loaded) await invoke("unload_model", { modelId: m.id });
          else await invoke("load_model", { modelId: m.id });
        } catch (err) { showError(String(err)); }
        await refresh();
        startPolling();
      },
    );
    (primary as HTMLButtonElement).disabled = busy;
    actions.appendChild(primary);
    card.appendChild(actions);

    host.appendChild(card);
    addGlyph(card.querySelector(".card__logo") as HTMLCanvasElement, m.id);
    // Open config expander (any downloaded model); filled async after render.
    if (downloaded && openCfg === m.id) {
      const ph = document.createElement("div");
      ph.className = "cfg";
      ph.id = "cfg-open";
      ph.innerHTML = `<div class="cfg__label">Loading…</div>`;
      host.appendChild(ph);
    }
  }
}

function renderDiscover() {
  const host = $("models");
  host.innerHTML = "";
  for (const e of catalog) {
    const card = document.createElement("div");
    card.className = "card card--cat";
    const prog = dl.get(e.id);
    card.innerHTML = `
      <div class="card__body">
        <div class="card__name">${e.name}</div>
        <div class="card__desc">${e.description}</div>
        <div class="card__meta"><span class="card__size">~${e.approx_gb.toFixed(1)} GB</span></div>
        ${prog ? `<div class="progress"><div class="progress__fill" style="width:${prog.total ? Math.round((prog.done / prog.total) * 100) : 0}%"></div></div>` : ""}
      </div>`;
    const btn = document.createElement("button");
    btn.className = "btn card__dl-btn";
    if (e.installed) {
      btn.textContent = "Installed";
      btn.disabled = true;
    } else if (prog) {
      btn.textContent = prog.total ? `${Math.round((prog.done / prog.total) * 100)}%` : "...";
      btn.classList.add("is-busy");
      btn.disabled = true;
      const cancel = document.createElement("button");
      cancel.className = "iconbtn";
      cancel.textContent = "Cancel";
      cancel.onclick = () => invoke("cancel_download", { id: e.id });
      card.appendChild(cancel);
    } else {
      btn.textContent = "Download";
      btn.onclick = async () => {
        dl.set(e.id, { done: 0, total: 0 });
        renderDiscover();
        try { await invoke("download_model", { id: e.id }); } catch (err) { dl.delete(e.id); showError(String(err)); renderDiscover(); }
      };
    }
    card.appendChild(btn);
    host.appendChild(card);
  }
}

async function hydrateCfg(id: string) {
  const host = document.getElementById("cfg-open");
  if (!host) return;
  const info = await invoke<ModelInfo>("model_info", { modelId: id });
  if (document.getElementById("cfg-open") !== host) return; // re-rendered meanwhile
  const ov: ModelOverride = { ...info.override };
  host.innerHTML = "";

  // context tier picker
  const max = info.native_ctx || 262144;
  const mem = (ctx: number) =>
    info.kv_per_token > 0 ? gb(info.file_bytes + ctx * info.kv_per_token) : "—";
  const label = document.createElement("div");
  label.className = "cfg__label";
  label.textContent = info.native_ctx ? `Context — max ${tierLabel(info.native_ctx)}` : "Context";
  host.appendChild(label);
  const pills = document.createElement("div");
  pills.className = "cfg__pills";
  const mk = (text: string, val: number | null, sub: string) => {
    const b = document.createElement("button");
    b.className = "cfg__pill" + ((ov.ctx_size ?? null) === val ? " is-on" : "");
    b.innerHTML = `${text}<span class="cfg__sub">${sub}</span>`;
    b.onclick = () => {
      ov.ctx_size = val;
      pills.querySelectorAll(".cfg__pill").forEach((el) => el.classList.remove("is-on"));
      b.classList.add("is-on");
    };
    return b;
  };
  pills.appendChild(mk("Auto", null, "fit"));
  for (const t of CTX_TIERS.filter((t) => t <= max)) pills.appendChild(mk(tierLabel(t), t, mem(t)));
  host.appendChild(pills);

  // sampling fields
  const fields: [keyof ModelOverride, string][] = [
    ["temp", "temp"], ["top_p", "top-p"], ["top_k", "top-k"], ["min_p", "min-p"],
    ["repeat_penalty", "repeat"], ["presence_penalty", "presence"], ["frequency_penalty", "freq"],
  ];
  const grid = document.createElement("div");
  grid.className = "cfg__grid";
  for (const [k, lbl] of fields) {
    const f = document.createElement("label");
    f.className = "cfg__field";
    f.innerHTML = `<span>${lbl}</span><input type="number" step="0.05" value="${ov[k] ?? ""}" />`;
    const inp = f.querySelector("input") as HTMLInputElement;
    inp.oninput = () => { (ov[k] as number | null) = inp.value === "" ? null : Number(inp.value); };
    grid.appendChild(f);
  }
  host.appendChild(grid);

  // actions
  const actions = document.createElement("div");
  actions.className = "cfg__actions";
  const reset = document.createElement("button");
  reset.className = "btn btn--quiet";
  reset.textContent = "Reset";
  reset.onclick = async () => {
    await invoke("set_model_config", { modelId: id, override: {} });
    openCfg = null; await refresh(); startPolling();
  };
  const save = document.createElement("button");
  save.className = "btn btn--primary";
  save.textContent = "Save";
  save.onclick = async () => {
    await invoke("set_model_config", { modelId: id, override: ov });
    openCfg = null; await refresh(); startPolling();
  };
  actions.append(reset, save);
  host.appendChild(actions);

  fitWindow(340); // grow the popover to include the now-filled expander
}

function render() {
  setHeader();
  resetGlyphs(); // drop old model glyphs; the active view re-adds its own
  const ready = router.status === "running";
  const webuiBtn = $("webui") as HTMLButtonElement;
  webuiBtn.disabled = !ready;
  webuiBtn.title = ready ? "" : "Router is starting";
  $("tab-installed").classList.toggle("is-active", view === "installed");
  $("tab-discover").classList.toggle("is-active", view === "discover");
  if (view === "installed") renderInstalled();
  else renderDiscover();
  lastSig = sigOf();
  fitWindow(340);
  if (view === "installed" && openCfg) void hydrateCfg(openCfg);
}

// A cheap signature of what the model list shows, so polling can skip a full
// re-render (and the glyph teardown) when nothing visible has changed.
const sigOf = () => router.status + "|" + view + "|" + models.map((x) => x.id + ":" + x.status).join(",");
let lastSig = "";

function showError(msg: string) {
  const err = $("error");
  err.textContent = msg.replace(/^error:\s*/, "");
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

async function init() {
  (document.getElementById("brand-mark") as HTMLImageElement).src = llamaMark;
  // Footer: "LlamaRanch <appVersion> · llama.cpp b<build>" — llama_cpp_version
  // returns a line like "version: 9670 (02810c7aa)"; pull the build number out.
  const rawVer = (await invoke<string>("llama_cpp_version")) || "";
  const build = rawVer.match(/\b(\d{3,})\b/)?.[1];
  const appVer = await getVersion().catch(() => "");
  ($("version") as HTMLElement).textContent = [
    appVer ? `LlamaRanch ${appVer}` : "",
    build ? `llama.cpp b${build}` : rawVer || "llama.cpp",
  ].filter(Boolean).join("  ·  ");

  $("tab-installed").onclick = () => { view = "installed"; render(); };
  $("tab-discover").onclick = () => { view = "discover"; render(); };

  $("copy").onclick = async () => {
    await navigator.clipboard.writeText(router.endpoint || "");
    const label = $("copy-label");
    const prev = label.textContent;
    label.textContent = "Copied";
    setTimeout(() => (label.textContent = prev), 1200);
  };
  $("webui").onclick = () => invoke("open_webui");
  $("quit").onclick = () => exit(0);

  $("close-btn").onclick = async () => {
    await getCurrentWindow().hide();
    if (!localStorage.getItem("tray-hint-shown")) {
      localStorage.setItem("tray-hint-shown", "1");
      notify("LlamaRanch is still running", "Click the llama icon in your tray to reopen it.");
    }
  };

  // Settings lives in its own window (defined in tauri.conf.json); just reveal it.
  $("settings-btn").onclick = async () => {
    const w = await WebviewWindow.getByLabel("settings");
    if (w) { await w.show(); await w.setFocus(); }
  };
  // The Settings window emits this after saving; refresh the panel to match.
  await listen("config-changed", async () => { await refresh(); startPolling(); });

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
