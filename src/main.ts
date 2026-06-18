import { invoke } from "@tauri-apps/api/core";
import { exit } from "@tauri-apps/plugin-process";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "./styles.css";
import llamaMark from "./assets/llama.svg";

type ModelView = {
  id: string; name: string; group: string; path: string;
  size_bytes: number; mmproj_path: string | null; placement: string;
};
type StatusView = { status: string; model_id: string | null; endpoint: string };

const $ = (id: string) => document.getElementById(id)!;
const gb = (n: number) => (n / 1e9).toFixed(1) + " GB";

let pollTimer: number | undefined;

function setStatus(status: string, modelId: string | null) {
  const el = $("status");
  const label = $("status-label");
  el.className = "status";
  if (status === "running") {
    el.classList.add("status--running");
    label.textContent = modelId ? `serving ${modelId}` : "running";
  } else if (status === "starting") {
    el.classList.add("status--starting");
    label.textContent = "starting...";
  } else if (status.startsWith("error")) {
    el.classList.add("status--error");
    label.textContent = "error";
  } else {
    el.classList.add("status--idle");
    label.textContent = "idle";
  }
}

async function refresh() {
  const [models, status] = await Promise.all([
    invoke<ModelView[]>("list_models"),
    invoke<StatusView>("server_status"),
  ]);

  ($("endpoint") as HTMLElement).textContent = status.endpoint;
  setStatus(status.status, status.model_id);

  const err = $("error");
  if (status.status.startsWith("error")) {
    err.textContent = status.status.replace(/^error:\s*/, "");
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
      const serving = status.model_id === m.id && status.status === "running";
      const starting = status.model_id === m.id && status.status === "starting";

      const card = document.createElement("div");
      card.className = "card" + (serving ? " is-serving" : "");
      card.dataset.placement = m.placement;
      card.innerHTML = `
        <div class="card__body">
          <div class="card__name" title="${m.name}">${m.name}</div>
          <div class="card__meta">
            <span class="card__size">${gb(m.size_bytes)}</span>
            <span class="dot">&middot;</span>
            <span class="tag tag--${m.placement}">${m.placement}</span>
          </div>
        </div>`;

      const btn = document.createElement("button");
      btn.className = "btn card__action" + (serving ? " is-stop" : starting ? " is-busy" : "");
      btn.textContent = serving ? "Stop" : starting ? "..." : "Load";
      btn.disabled = status.status === "starting";
      btn.onclick = async () => {
        if (serving) await invoke("stop_server");
        else await invoke("start_server", { modelId: m.id });
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
    const s = await invoke<StatusView>("server_status");
    if (s.status !== "starting") {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    await refresh();
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
        expose_to_network: ($("s-expose") as HTMLInputElement).checked,
      },
    });
    await refresh();
  });

  await refresh();
}

init();
