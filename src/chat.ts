import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type BrainEvent =
  | { kind: "routed"; model_id: string; category: string; reason: string }
  | { kind: "token"; text: string }
  | { kind: "done"; usage: { prompt_tokens: number; completion_tokens: number } }
  | { kind: "error"; message: string };

const pool = document.getElementById("pool") as HTMLDivElement;
const log = document.getElementById("log") as HTMLDivElement;
const input = document.getElementById("input") as HTMLTextAreaElement;
const send = document.getElementById("send") as HTMLButtonElement;
const form = document.getElementById("composer") as HTMLFormElement;

type PoolView = { resident: { id: string; status: string; pinned: boolean }[]; active: string | null };

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
  } catch {
    /* router not ready yet — leave the strip empty */
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
  return el;
}

async function init() {
  try {
    session = await invoke<string>("chat_new_session");
    refreshPool();
    await listen<{ session: string; event: BrainEvent }>("chat:event", ({ payload }) => {
      if (payload.session !== session) return;
      const ev = payload.event;
      if (ev.kind === "routed") {
        bubble("trace", `routed to ${ev.model_id} · ${ev.category} — ${ev.reason}`);
        current = bubble("assistant");
        refreshPool();
      } else if (ev.kind === "token" && current) {
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
  setStreaming(true);
  try {
    await invoke("chat_send", { sessionId: session, message: text, hasImage: false, explicitGroup: null });
  } catch (err) {
    bubble("error", String(err));
    setStreaming(false);
  }
});

init();
