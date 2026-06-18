import { invoke } from "@tauri-apps/api/core";
import { exit } from "@tauri-apps/plugin-process";
import "./styles.css";

type ModelView = {
  id: string; name: string; group: string; path: string;
  size_bytes: number; mmproj_path: string | null; placement: string;
};
type StatusView = { status: string; model_id: string | null; endpoint: string };

const $ = (id: string) => document.getElementById(id)!;
const gb = (n: number) => (n / 1e9).toFixed(1) + " GB";

let pollTimer: number | undefined;

async function refresh() {
  const [models, status] = await Promise.all([
    invoke<ModelView[]>("list_models"),
    invoke<StatusView>("server_status"),
  ]);
  ($("endpoint") as HTMLElement).textContent = status.endpoint;
  ($("serving") as HTMLElement).textContent =
    status.status === "running" ? `serving: ${status.model_id}` : status.status;

  const err = $("error");
  if (status.status.startsWith("error")) {
    err.textContent = status.status;
    err.classList.remove("hidden");
  } else {
    err.classList.add("hidden");
  }

  const groups: Record<string, ModelView[]> = {};
  for (const m of models) (groups[m.group] ??= []).push(m);

  const host = $("models");
  host.innerHTML = "";
  for (const [group, list] of Object.entries(groups)) {
    const h = document.createElement("div");
    h.className = "group";
    h.textContent = group;
    host.appendChild(h);
    for (const m of list) {
      const row = document.createElement("div");
      row.className = "model";
      const running = status.model_id === m.id && status.status === "running";
      row.innerHTML = `
        <div class="info">
          <div class="name">${m.name}</div>
          <div class="meta muted">${gb(m.size_bytes)} - <span class="badge ${m.placement}">${m.placement}</span></div>
        </div>`;
      const btn = document.createElement("button");
      btn.textContent = running ? "Stop" : (status.model_id === m.id ? status.status : "Load");
      btn.disabled = status.status === "starting";
      btn.onclick = async () => {
        if (running) await invoke("stop_server");
        else await invoke("start_server", { modelId: m.id });
        await refresh();
        startPolling();
      };
      row.appendChild(btn);
      host.appendChild(row);
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
  ($("version") as HTMLElement).textContent = await invoke<string>("llama_cpp_version");
  $("copy").onclick = async () => {
    await navigator.clipboard.writeText(($("endpoint") as HTMLElement).textContent || "");
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
