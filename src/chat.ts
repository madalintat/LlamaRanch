import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { mountDither } from "./dither";
import "./brand/theme";
import { tagOS } from "./platform";

tagOS();

type BrainEvent =
  | { kind: "routed"; model_id: string; category: string; reason: string }
  | { kind: "token"; text: string }
  | { kind: "done"; usage: { prompt_tokens: number; completion_tokens: number } }
  | { kind: "error"; message: string }
  | { kind: "tool_call"; name: string; args: string }
  | { kind: "tool_result"; name: string; ok: boolean; preview: string };

type ToolInfo = {
  name: string;
  label: string;
  scope: string;   // "local" | "online"
  enabled: boolean;
  note: string;
};

const pool = document.getElementById("pool") as HTMLDivElement;
const log = document.getElementById("log") as HTMLDivElement;
const input = document.getElementById("input") as HTMLTextAreaElement;
const send = document.getElementById("send") as HTMLButtonElement;
const form = document.getElementById("composer") as HTMLFormElement;
const modelPick = document.getElementById("model-pick") as HTMLSelectElement;
const emptyState = document.getElementById("empty-state") as HTMLDivElement;
const newChatBtn = document.getElementById("new-chat") as HTMLButtonElement;
const titlebarModel = document.getElementById("titlebar-model") as HTMLSpanElement;
const lcdModel = document.getElementById("lcd-model") as HTMLSpanElement;
const lcdStatus = document.getElementById("lcd-status") as HTMLSpanElement;
const lcdKbd = document.getElementById("lcd-kbd") as HTMLSpanElement;
const privacyModel = document.getElementById("privacy-model") as HTMLSpanElement;
const offlineToggle = document.getElementById("offline-toggle") as HTMLDivElement;
const chipWebResearch = document.getElementById("chip-web-research") as HTMLSpanElement;

type PoolView = { resident: { id: string; status: string; pinned: boolean }[]; active: string | null };

type ModelView = { id: string; name: string; group: string; local: boolean; need_download: boolean };

// Strip org prefix, .gguf extension, quant suffixes like :Q4_0, then clean separators.
function prettyName(id: string): string {
  return id
    .split("/").pop()!   // drop "org/"
    .split(":")[0]        // drop ":Q4_0" quant suffix
    .replace(/\.gguf$/i, "") // drop .gguf extension
    .replace(/[-_]/g, " ")  // dashes/underscores → spaces
    .replace(/\bGGUF\b/gi, "") // remove standalone GGUF token
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Mount dither engine on DOMContentLoaded (already fired — we're a module)
const dither = mountDither();

// OS-aware ⌘K hint
if (lcdKbd) {
  const isMac = document.documentElement.dataset.os === "macos";
  lcdKbd.textContent = isMac ? "⌘K" : "Ctrl K";
}

/** Show/hide the empty state based on whether the log has any messages. */
function syncEmptyState(): void {
  const hasMessages = log.children.length > 0;
  emptyState.classList.toggle("hidden", hasMessages);
  log.style.display = hasMessages ? "" : "none";
}

/** Update the model name shown in titlebar, LCD, and privacy panel. */
function setActiveModel(id: string): void {
  const name = id ? prettyName(id) : "";
  const label = name ? `${name} · local` : "new chat · no model loaded";
  titlebarModel.textContent = label;
  lcdModel.textContent = name || "no model";
  if (lcdStatus) lcdStatus.textContent = name ? "SERVING" : "idle";
  if (privacyModel) privacyModel.textContent = name || "local";
}

/** Render tool rows in the rail and privacy panel, and update the web-research chip. */
function renderTools(tools: ToolInfo[]): void {
  const railList = document.getElementById("rail-tools-list");
  const privacyList = document.getElementById("privacy-tools-list");

  if (railList) {
    railList.innerHTML = "";
    for (const t of tools) {
      const row = document.createElement("div");
      const off = !t.enabled;
      row.className = "rail__tool-row" + (off ? " rail__tool-row--off" : "");
      const ledClass = off ? "led led--idle" : "led led--on";
      row.innerHTML = `
        <span class="${ledClass}"></span>
        <span class="rail__tool-name">${t.label}</span>
        <span class="mono rail__tool-tag">${t.scope.toUpperCase()}</span>
      `;
      if (!t.enabled && t.note) row.title = t.note;
      railList.appendChild(row);
    }
  }

  if (privacyList) {
    privacyList.innerHTML = "";
    for (const t of tools) {
      const on = t.enabled;
      const row = document.createElement("div");
      row.className = "privacy__row" + (on ? "" : " privacy__row--off");

      const ledClass = on
        ? (t.scope === "local" ? "privacy__led privacy__led--on" : "privacy__led privacy__led--idle")
        : "privacy__led privacy__led--off";

      let badgeClass = "mono privacy__badge";
      let badgeText = t.scope.toUpperCase();
      let descText = "";
      if (!on) {
        badgeClass = "mono privacy__badge privacy__badge--off";
        badgeText = "OFF";
        descText = t.note || "Disabled.";
      } else if (t.scope === "online") {
        badgeClass = "mono privacy__badge privacy__badge--muted";
        descText = "Reaches the internet when used.";
      } else {
        descText = "Stays on your machine.";
      }

      row.innerHTML = `
        <span class="${ledClass}"></span>
        <div class="privacy__info">
          <div class="privacy__info-name">${t.label}</div>
          <div class="privacy__info-desc">${descText}</div>
        </div>
        <span class="${badgeClass}">${badgeText}</span>
      `;
      privacyList.appendChild(row);
    }
  }

  // Update web-research chip: enabled = at least one of web_fetch / web_search is on
  if (chipWebResearch) {
    const webOn = tools.some(
      (t) => (t.name === "web_fetch" || t.name === "web_search") && t.enabled
    );
    chipWebResearch.classList.toggle("chip--on", webOn);
  }
}

/** Refresh tool list from backend and re-render. */
async function refreshTools(): Promise<void> {
  try {
    const tools = await invoke<ToolInfo[]>("list_tools");
    renderTools(tools);

    // Sync offline toggle visual state from backend config
    try {
      const cfg = await invoke<any>("get_config");
      const isOffline: boolean = cfg.offline_mode ?? false;
      offlineToggle.classList.toggle("toggle--on", isOffline);
      offlineToggle.classList.toggle("toggle--off", !isOffline);
      offlineToggle.setAttribute("aria-checked", String(isOffline));
    } catch { /* ignore */ }
  } catch { /* router not ready yet */ }
}

// Wire offline toggle in privacy panel
if (offlineToggle) {
  offlineToggle.setAttribute("role", "checkbox");
  offlineToggle.setAttribute("tabindex", "0");
  offlineToggle.setAttribute("aria-label", "Offline mode");
  offlineToggle.classList.add("toggle--off"); // initial state

  async function toggleOffline(): Promise<void> {
    try {
      const cfg = await invoke<any>("get_config");
      const nowOffline: boolean = !(cfg.offline_mode ?? false);
      await invoke("set_config", {
        newCfg: { ...cfg, offline_mode: nowOffline },
      });
      await refreshTools();
    } catch { /* ignore */ }
  }

  offlineToggle.addEventListener("click", toggleOffline);
  offlineToggle.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggleOffline(); }
  });
}

async function refreshPool() {
  try {
    const view = await invoke<PoolView>("model_pool");
    pool.innerHTML = "";
    for (const m of view.resident) {
      const dot = document.createElement("span");
      dot.className = "pooldot";
      if (m.id === view.active) dot.classList.add("active");
      if (m.pinned) dot.classList.add("pinned");
      // Square LED instead of ● emoji
      const led = document.createElement("span");
      led.className = m.id === view.active ? "led led--sm" : "led led--idle";
      dot.appendChild(led);
      dot.append(" " + prettyName(m.id));
      pool.appendChild(dot);
    }
    setActiveModel(view.active ?? "");
  } catch {
    /* router not ready yet — leave the strip empty */
  }
}

async function loadPicker() {
  try {
    const models = await invoke<ModelView[]>("list_models");
    for (const m of models.filter((x) => x.local || !x.need_download)) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = prettyName(m.name || m.id);
      modelPick.appendChild(opt);
    }
  } catch {
    /* leave just "Auto" */
  }
}

let session = "";
let current: HTMLDivElement | null = null; // the streaming assistant bubble

function setStreaming(active: boolean) {
  send.disabled = active;
  input.disabled = active;
}

function bubble(role: string, text = ""): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `msg msg--${role}`;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  syncEmptyState();
  // Refresh dither in case new data-glyph canvases were added
  dither.refresh();
  return el;
}

async function startNewSession(): Promise<void> {
  await invoke("chat_cancel", { sessionId: session }).catch(()=>{});
  setStreaming(false);
  session = await invoke<string>("chat_new_session");
  log.innerHTML = "";
  current = null;
  input.value = "";
  setStreaming(false);
  syncEmptyState();
  refreshPool();
}

async function init() {
  try {
    await startNewSession();
    loadPicker();
    refreshTools();
    await listen<{ session: string; event: BrainEvent }>("chat:event", ({ payload }) => {
      if (payload.session !== session) return;
      const ev = payload.event;
      if (ev.kind === "routed") {
        bubble("trace", `routed to ${ev.model_id} · ${ev.category} — ${ev.reason}`);
        refreshPool();
      } else if (ev.kind === "tool_call") {
        bubble("tool", `${ev.name}(${ev.args})`);
        current = null;
      } else if (ev.kind === "tool_result") {
        const el = document.createElement("div");
        el.className = "msg msg--tool";
        // Small square LED conveys ok/fail; no emoji
        const led = document.createElement("span");
        led.className = ev.ok ? "led led--sm" : "led led--idle";
        el.appendChild(led);
        el.append(` ${ev.name} → ${ev.preview}`);
        if (!ev.ok) el.classList.add("msg--error");
        log.appendChild(el);
        log.scrollTop = log.scrollHeight;
        syncEmptyState();
        dither.refresh();
      } else if (ev.kind === "token") {
        if (!current) current = bubble("assistant");
        current.textContent += ev.text;
        log.scrollTop = log.scrollHeight;
      } else if (ev.kind === "done") {
        current = null;
        setStreaming(false);
        refreshPool();
      } else if (ev.kind === "error") {
        bubble("error", ev.message);
        current = null;
        setStreaming(false);
      }
    });
  } catch (err) {
    bubble("error", `chat init failed: ${String(err)}`);
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  bubble("user", text);
  input.value = "";
  const picked = modelPick.value || null;
  setStreaming(true);
  try {
    await invoke("chat_send", { sessionId: session, message: text, hasImage: false, explicitGroup: null, explicitModel: picked });
  } catch (err) {
    bubble("error", String(err));
    setStreaming(false);
  }
});

// New chat button — start a fresh session
newChatBtn.addEventListener("click", async () => {
  try {
    await startNewSession();
  } catch (err) {
    bubble("error", `new session failed: ${String(err)}`);
  }
});

// Also handle chat_cancel if invoked externally (keyboard shortcut etc.)
async function cancelStream() {
  try {
    await invoke("chat_cancel", { sessionId: session });
  } catch {
    /* ignore if no stream active */
  }
}
// Expose for potential keybinding hooks
(window as Window & typeof globalThis & { chat_cancel?: () => void }).chat_cancel = cancelStream;

// Initialize
syncEmptyState();
init();
