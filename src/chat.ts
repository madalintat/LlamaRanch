import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { mountDither } from "./dither";
import "./brand/theme";

type BrainEvent =
  | { kind: "routed"; model_id: string; category: string; reason: string }
  | { kind: "token"; text: string }
  | { kind: "done"; usage: { prompt_tokens: number; completion_tokens: number } }
  | { kind: "error"; message: string }
  | { kind: "tool_call"; name: string; args: string }
  | { kind: "tool_result"; name: string; ok: boolean; preview: string };

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
const privacyModel = document.getElementById("privacy-model") as HTMLSpanElement;

type PoolView = { resident: { id: string; status: string; pinned: boolean }[]; active: string | null };

type ModelView = { id: string; name: string; group: string; local: boolean; need_download: boolean };

// Mount dither engine on DOMContentLoaded (already fired — we're a module)
const dither = mountDither();

/** Show/hide the empty state based on whether the log has any messages. */
function syncEmptyState(): void {
  const hasMessages = log.children.length > 0;
  emptyState.classList.toggle("hidden", hasMessages);
  log.style.display = hasMessages ? "" : "none";
}

/** Update the model name shown in titlebar, LCD, and privacy panel. */
function setActiveModel(name: string): void {
  const label = name ? `${name} · local` : "new chat · no model loaded";
  titlebarModel.textContent = label;
  lcdModel.textContent = name || "no model";
  if (privacyModel) privacyModel.textContent = name || "local";
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
      dot.textContent = `● ${m.id}`;
      pool.appendChild(dot);
    }
    if (view.active) setActiveModel(view.active);
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
      opt.textContent = m.name;
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
    await listen<{ session: string; event: BrainEvent }>("chat:event", ({ payload }) => {
      if (payload.session !== session) return;
      const ev = payload.event;
      if (ev.kind === "routed") {
        bubble("trace", `routed to ${ev.model_id} · ${ev.category} — ${ev.reason}`);
        refreshPool();
      } else if (ev.kind === "tool_call") {
        bubble("tool", `🔧 ${ev.name}(${ev.args})`);
        current = null;
      } else if (ev.kind === "tool_result") {
        const el = bubble("tool", `${ev.ok ? "✓" : "✗"} ${ev.name} → ${ev.preview}`);
        if (!ev.ok) el.classList.add("msg--error");
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
    await invoke("chat_cancel");
  } catch {
    /* ignore if no stream active */
  }
}
// Expose for potential keybinding hooks
(window as Window & typeof globalThis & { chat_cancel?: () => void }).chat_cancel = cancelStream;

// Initialize
syncEmptyState();
init();
