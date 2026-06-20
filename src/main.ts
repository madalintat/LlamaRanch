import { invoke } from "@tauri-apps/api/core";
import { exit, relaunch } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
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
  const active = models.find((m) => LOADED(m.status));
  const loading = models.find((m) => BUSY(m.status));
  if (active) {
    el.classList.add("status--running");
    label.textContent = `serving ${active.name}`;
  } else if (loading) {
    el.classList.add("status--starting");
    label.textContent = "loading...";
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

    if (m.local) {
      const del = document.createElement("button");
      del.className = "iconbtn card__del";
      del.textContent = "Delete";
      del.title = "Delete model file";
      del.onclick = async () => {
        if (!confirm(`Delete ${name} from disk?`)) return;
        try { await invoke("delete_model", { modelId: m.id }); } catch (e) { showError(String(e)); }
        await refresh();
      };
      card.appendChild(del);
    }

    const btn = document.createElement("button");
    btn.className = "btn card__action" + (loaded ? " is-stop" : busy ? " is-busy" : "");
    btn.textContent = loaded ? "Stop" : busy ? "…" : (m.need_download ? "Get & Load" : "Load");
    btn.disabled = busy;
    btn.onclick = async () => {
      try {
        if (loaded) await invoke("unload_model", { modelId: m.id });
        else await invoke("load_model", { modelId: m.id });
      } catch (e) { showError(String(e)); }
      await refresh();
      startPolling();
    };
    card.appendChild(btn);
    host.appendChild(card);
    addGlyph(card.querySelector(".card__logo") as HTMLCanvasElement, m.id);
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
    btn.className = "btn card__action";
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
  fitWindow();
}

// Resize the window to hug the panel's content (capped), so it never shows a
// tall empty box — it just fits, like a native popover.
function fitWindow() {
  const apply = () => {
    const h = Math.min(560, Math.max(80, Math.ceil($("app").offsetHeight)));
    getCurrentWindow().setSize(new LogicalSize(340, h)).catch(() => {});
  };
  // Two passes: once after layout, once after fonts/images settle, so the
  // window always hugs the real content height (never a tall empty box).
  requestAnimationFrame(apply);
  setTimeout(apply, 90);
}

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
    render();
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
