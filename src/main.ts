import { invoke } from "@tauri-apps/api/core";
import { exit, relaunch } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { check } from "@tauri-apps/plugin-updater";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { enable as autoEnable, disable as autoDisable, isEnabled as autoIsEnabled } from "@tauri-apps/plugin-autostart";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "./styles.css";
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
      ? "No models. Try the Discover tab."
      : "Starting router…";
    host.innerHTML = `<div class="empty">${msg}</div>`;
    return;
  }
  const groups: Record<string, ModelView[]> = {};
  for (const m of models) (groups[m.group] ??= []).push(m);

  for (const [group, list] of Object.entries(groups)) {
    const label = document.createElement("div");
    label.className = "group__label";
    label.textContent = group;
    host.appendChild(label);

    for (const m of list) {
      const loaded = LOADED(m.status);
      const busy = BUSY(m.status);
      const card = document.createElement("div");
      card.className = "card" + (loaded ? " is-serving" : "");
      card.dataset.placement = m.placement;
      const visionTag = m.vision ? `<span class="tag tag--vision">vision</span>` : "";
      const sizeCell = m.local
        ? `<span class="card__size">${gb(m.size_bytes)}</span>`
        : `<span class="card__size">cloud</span>`;
      const placementTag = m.placement
        ? `<span class="dot">&middot;</span><span class="tag tag--${m.placement}">${m.placement}</span>`
        : "";
      card.innerHTML = `
        <div class="card__body">
          <div class="card__name" title="${esc(m.name)}">${esc(m.name)}</div>
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
          if (!confirm(`Delete ${m.name} from disk?`)) return;
          try { await invoke("delete_model", { modelId: m.id }); } catch (e) { showError(String(e)); }
          await refresh();
        };
        card.appendChild(del);
      }

      const btn = document.createElement("button");
      btn.className = "btn card__action" + (loaded ? " is-stop" : busy ? " is-busy" : "");
      btn.textContent = loaded
        ? "Stop"
        : busy ? "..."
        : (m.need_download ? "Get & Load" : "Load");
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
  const ready = router.status === "running";
  const webuiBtn = $("webui") as HTMLButtonElement;
  webuiBtn.disabled = !ready;
  webuiBtn.title = ready ? "" : "Router is starting";
  $("tab-installed").classList.toggle("is-active", view === "installed");
  $("tab-discover").classList.toggle("is-active", view === "discover");
  if (view === "installed") renderInstalled();
  else renderDiscover();
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
  ($("endpoint") as HTMLElement).textContent = router.endpoint;
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
  ($("version") as HTMLElement).textContent = (await invoke<string>("llama_cpp_version")) || "llama.cpp";

  $("tab-installed").onclick = () => { view = "installed"; render(); };
  $("tab-discover").onclick = () => { view = "discover"; render(); };

  $("copy").onclick = async () => {
    await navigator.clipboard.writeText(($("endpoint") as HTMLElement).textContent || "");
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

  const dlg = $("settings") as HTMLDialogElement;
  $("settings-btn").onclick = async () => {
    const cfg = await invoke<any>("get_config");
    ($("s-port") as HTMLInputElement).value = String(cfg.port);
    ($("s-models") as HTMLInputElement).value = cfg.models_dir;
    ($("s-bin") as HTMLInputElement).value = cfg.server_bin;
    ($("s-idle") as HTMLInputElement).value = String(cfg.sleep_idle_seconds ?? 0);
    ($("s-hf") as HTMLInputElement).value = cfg.hf_token ?? "";
    ($("s-expose") as HTMLInputElement).checked = cfg.expose_to_network;
    try { ($("s-autostart") as HTMLInputElement).checked = await autoIsEnabled(); } catch {}
    dlg.showModal();
  };
  dlg.addEventListener("close", async () => {
    if (dlg.returnValue !== "save") return;
    try {
      const want = ($("s-autostart") as HTMLInputElement).checked;
      if ((await autoIsEnabled()) !== want) want ? await autoEnable() : await autoDisable();
    } catch {}
    await invoke("set_config", {
      newCfg: {
        port: Number(($("s-port") as HTMLInputElement).value),
        models_dir: ($("s-models") as HTMLInputElement).value,
        server_bin: ($("s-bin") as HTMLInputElement).value,
        sleep_idle_seconds: Number(($("s-idle") as HTMLInputElement).value) || 0,
        hf_token: ($("s-hf") as HTMLInputElement).value.trim(),
        expose_to_network: ($("s-expose") as HTMLInputElement).checked,
      },
    });
    await refresh();
    startPolling();
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
