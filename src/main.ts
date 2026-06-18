import { invoke } from "@tauri-apps/api/core";
import { exit } from "@tauri-apps/plugin-process";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "./styles.css";
import llamaMark from "./assets/llama.svg";

type ModelView = {
  id: string; name: string; group: string; size_bytes: number;
  vision: boolean; placement: string; status: string;
};
type RouterStatus = { status: string; endpoint: string };

const $ = (id: string) => document.getElementById(id)!;
const gb = (n: number) => (n / 1e9).toFixed(1) + " GB";

const LOADED = (s: string) => s === "loaded" || s === "sleeping";
const BUSY = (s: string) => s === "loading" || s === "downloading";

let pollTimer: number | undefined;

function setHeader(router: RouterStatus, models: ModelView[]) {
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

async function refresh() {
  const [router, models] = await Promise.all([
    invoke<RouterStatus>("router_status"),
    invoke<ModelView[]>("list_models"),
  ]);

  ($("endpoint") as HTMLElement).textContent = router.endpoint;
  setHeader(router, models);

  const webuiBtn = $("webui") as HTMLButtonElement;
  const ready = router.status === "running";
  webuiBtn.disabled = !ready;
  webuiBtn.title = ready ? "" : "Router is starting";

  const err = $("error");
  if (router.status.startsWith("error")) {
    err.textContent = router.status.replace(/^error:\s*/, "");
    err.classList.remove("hidden");
  } else {
    err.classList.add("hidden");
  }

  const host = $("models");
  host.innerHTML = "";

  if (models.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No models found. Set your models directory in Settings.";
    host.appendChild(empty);
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
      card.innerHTML = `
        <div class="card__body">
          <div class="card__name" title="${m.name}">${m.name}</div>
          <div class="card__meta">
            <span class="card__size">${gb(m.size_bytes)}</span>
            <span class="dot">&middot;</span>
            <span class="tag tag--${m.placement}">${m.placement}</span>
            ${visionTag}
          </div>
        </div>`;

      const btn = document.createElement("button");
      btn.className = "btn card__action" + (loaded ? " is-stop" : busy ? " is-busy" : "");
      btn.textContent = loaded ? "Stop" : busy ? (m.status === "downloading" ? "..." : "...") : "Load";
      btn.disabled = busy;
      btn.onclick = async () => {
        try {
          if (loaded) await invoke("unload_model", { modelId: m.id });
          else await invoke("load_model", { modelId: m.id });
        } catch (e) {
          $("error").textContent = String(e);
          $("error").classList.remove("hidden");
        }
        await refresh();
        startPolling();
      };
      card.appendChild(btn);
      host.appendChild(card);
    }
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const [router, models] = await Promise.all([
      invoke<RouterStatus>("router_status"),
      invoke<ModelView[]>("list_models"),
    ]);
    const settling =
      router.status !== "running" || models.some((m) => BUSY(m.status));
    await refresh();
    if (!settling) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }, 1500) as unknown as number;
}

async function init() {
  (document.getElementById("brand-mark") as HTMLImageElement).src = llamaMark;

  const ver = await invoke<string>("llama_cpp_version");
  ($("version") as HTMLElement).textContent = ver || "llama.cpp";

  $("copy").onclick = async () => {
    await navigator.clipboard.writeText(($("endpoint") as HTMLElement).textContent || "");
    const label = $("copy-label");
    const prev = label.textContent;
    label.textContent = "Copied";
    setTimeout(() => (label.textContent = prev), 1200);
  };
  $("webui").onclick = () => invoke("open_webui");
  $("quit").onclick = () => exit(0);

  const dlg = $("settings") as HTMLDialogElement;
  $("settings-btn").onclick = async () => {
    const cfg = await invoke<any>("get_config");
    ($("s-port") as HTMLInputElement).value = String(cfg.port);
    ($("s-models") as HTMLInputElement).value = cfg.models_dir;
    ($("s-bin") as HTMLInputElement).value = cfg.server_bin;
    ($("s-idle") as HTMLInputElement).value = String(cfg.sleep_idle_seconds ?? 0);
    ($("s-hf") as HTMLInputElement).value = cfg.hf_token ?? "";
    ($("s-expose") as HTMLInputElement).checked = cfg.expose_to_network;
    dlg.showModal();
  };
  dlg.addEventListener("close", async () => {
    if (dlg.returnValue !== "save") return;
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

  await refresh();
  startPolling();
}

init();
