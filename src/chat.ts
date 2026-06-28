import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { mountDither } from "./dither";
import { applyTheme, type Theme } from "./brand/theme";
import { tagOS } from "./platform";
import { prettyName } from "./pretty";
import { basename, shortenPath } from "./paths";

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
const lcdEl = document.getElementById("lcd") as HTMLDivElement;
const privacyModel = document.getElementById("privacy-model") as HTMLSpanElement;
const offlineToggle = document.getElementById("offline-toggle") as HTMLDivElement;
const chipWebResearch = document.getElementById("chip-web-research") as HTMLSpanElement;
const railEl = document.getElementById("rail") as HTMLElement;
const railCollapseBtn = document.getElementById("rail-collapse-btn") as HTMLButtonElement;
const privacyPanel = document.getElementById("privacy-panel") as HTMLElement;
const privacyCollapseBtn = document.getElementById("privacy-collapse-btn") as HTMLButtonElement;
const modelPopup = document.getElementById("model-popup") as HTMLDivElement;
const modelPopupList = document.getElementById("model-popup-list") as HTMLDivElement;
const modelPopupBackdrop = document.getElementById("model-popup-backdrop") as HTMLDivElement;

type PoolView = { resident: { id: string; status: string; pinned: boolean }[]; active: string | null };

type ModelView = { id: string; name: string; group: string; local: boolean; need_download: boolean };

// Mount dither engine on DOMContentLoaded (already fired - we're a module)
const dither = mountDither();

// OS-aware Cmd/Ctrl K hint
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
  // Update authoritative model state based on whether a model is active.
  if (id) {
    modelState = "ready";
  } else if (modelState !== "loading") {
    modelState = "idle";
  }
  // Reaching a resolved LCD state ends any loading animation.
  setLoadingVisual(false);
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
        descText =
          t.name === "web_fetch" ? "Opens a specific web page you point it at."
          : t.name === "web_search" ? "Searches the web through your SearXNG."
          : "Reaches the internet when used.";
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

// Last pool view seen, used for popup state rendering
let lastPoolView: PoolView | null = null;

/** Render the compact pool strip (the dot row above the chat log). */
function renderPoolStrip(view: PoolView): void {
  pool.innerHTML = "";
  for (const m of view.resident) {
    const dot = document.createElement("span");
    dot.className = "pooldot";
    if (m.id === view.active) dot.classList.add("active");
    if (m.pinned) dot.classList.add("pinned");
    const led = document.createElement("span");
    if (m.id === view.active) {
      led.className = "led led--sm";
    } else if (m.status === "loading") {
      led.className = "led led--sm led--loading";
    } else {
      led.className = "led led--idle";
    }
    dot.appendChild(led);
    dot.append(" " + prettyName(m.id));
    pool.appendChild(dot);
  }
}

async function refreshPool(): Promise<void> {
  try {
    const view = await invoke<PoolView>("model_pool");
    lastPoolView = view;
    renderPoolStrip(view);
    // While a load is actively in progress, the load flow owns the LCD (the
    // live "loading Ns" counter). Only let the background sync set the active
    // model when nothing is mid-load, so it never clobbers loading feedback.
    if (modelState !== "loading") {
      setActiveModel(view.active ?? "");
    }
  } catch {
    /* router not ready yet - leave the strip empty */
  }
}

// Authoritative model-load state: "idle" = nothing loaded, "loading" = load in
// progress, "ready" = at least one model is serving.
let modelState: "idle" | "loading" | "ready" = "idle";

// Cache of available models for the popup
let cachedModels: ModelView[] = [];

async function loadPicker() {
  try {
    const models = await invoke<ModelView[]>("list_models");
    cachedModels = models.filter((x) => x.local || !x.need_download);
    // Preserve the currently selected value so a re-call doesn't reset the picker.
    const selected = modelPick.value;
    // Clear all options beyond the first (the "Auto"/default placeholder).
    while (modelPick.options.length > 1) modelPick.remove(1);
    // Repopulate the composer select.
    for (const m of cachedModels) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = prettyName(m.name || m.id);
      modelPick.appendChild(opt);
    }
    // Restore selection if still present.
    if (selected && cachedModels.some((m) => m.id === selected)) {
      modelPick.value = selected;
    }
  } catch {
    /* leave just "Auto" */
  }
}

// ============================================================
// Model popup (Cmd+K / LCD click)
// ============================================================

/**
 * Build or rebuild the popup list using live pool state plus cachedModels.
 * Rows show: filled LED for the active/loaded model, animated "loading" dot,
 * plain LED for unloaded. Clicking the active row unloads; clicking any other
 * row loads it.
 */
function buildModelPopup(livePool: PoolView | null): void {
  modelPopupList.innerHTML = "";

  if (cachedModels.length === 0) {
    const empty = document.createElement("div");
    empty.className = "model-popup__empty mono";
    empty.textContent = "no downloaded models found";
    modelPopupList.appendChild(empty);
    return;
  }

  // Build a quick lookup from the pool
  const poolStatus = new Map<string, string>(); // id -> status
  const activeId = livePool?.active ?? null;
  if (livePool) {
    for (const e of livePool.resident) poolStatus.set(e.id, e.status);
  }

  for (const m of cachedModels) {
    const row = document.createElement("button");
    row.className = "model-popup__row mono";
    row.dataset.modelId = m.id;

    const status = poolStatus.get(m.id);
    const isActive = m.id === activeId;
    const isLoading = status === "loading";
    const isLoaded = status === "loaded" || status === "sleeping";

    // Build label with LED indicator
    const led = document.createElement("span");
    if (isActive && isLoaded) {
      led.className = "led led--sm";
      led.title = "serving";
    } else if (isLoading) {
      led.className = "led led--sm led--loading";
      led.title = "loading";
    } else {
      led.className = "led led--idle";
    }

    row.appendChild(led);
    row.append(" " + prettyName(m.name || m.id));

    if (isActive && isLoaded) {
      // Clicking the serving model unloads it
      const hint = document.createElement("span");
      hint.className = "model-popup__row-hint mono";
      hint.textContent = " · unload";
      row.appendChild(hint);

      row.addEventListener("click", async () => {
        // Do not allow unload while a model is loading - it would leave inconsistent state.
        if (modelState === "loading") return;
        closeModelPopup();
        try {
          await invoke("unload_model", { modelId: m.id });
        } catch {
          /* ignore benign errors like already unloaded */
        }
        await refreshPool();
        buildModelPopup(lastPoolView);
        // Clear the composer dropdown if it pointed to this model
        if (modelPick.value === m.id) modelPick.value = "";
      });
    } else if (!isLoading) {
      // Unloaded model: click to load
      row.addEventListener("click", () => {
        closeModelPopup();
        pickAndLoadModel(m.id);
      });
    } else {
      // Mid-load: disable the row
      row.disabled = true;
      row.style.opacity = "0.5";
    }

    modelPopupList.appendChild(row);
  }
}

function openModelPopup(): void {
  buildModelPopup(lastPoolView);
  modelPopup.classList.add("model-popup--open");
  modelPopupBackdrop.classList.add("model-popup-backdrop--open");
  modelPopup.setAttribute("aria-hidden", "false");
  // Focus first enabled row if present
  const first = modelPopupList.querySelector<HTMLButtonElement>(".model-popup__row:not(:disabled)");
  if (first) first.focus();
  // If pool data is not yet available, kick a refresh and rebuild on completion.
  if (lastPoolView === null) {
    refreshPool().then(() => {
      if (modelPopup.classList.contains("model-popup--open")) {
        buildModelPopup(lastPoolView);
      }
    });
  }
}

function closeModelPopup(): void {
  modelPopup.classList.remove("model-popup--open");
  modelPopupBackdrop.classList.remove("model-popup-backdrop--open");
  modelPopup.setAttribute("aria-hidden", "true");
}

// LCD click
if (lcdEl) {
  lcdEl.addEventListener("click", () => openModelPopup());
  lcdEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openModelPopup(); }
  });
}

// Backdrop click closes popup
modelPopupBackdrop.addEventListener("click", closeModelPopup);

// Escape closes popup
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modelPopup.classList.contains("model-popup--open")) {
    closeModelPopup();
    return;
  }
  // Cmd+K (Mac) or Ctrl+K opens model picker
  if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    if (modelPopup.classList.contains("model-popup--open")) {
      closeModelPopup();
    } else {
      openModelPopup();
    }
  }
});

// ============================================================
// Load state: intervals that survive across an async load call
// ============================================================

/** Currently active load token; bumped on each new load so old loops stop. */
let loadToken = 0;

/** Elapsed-seconds interval for the LCD "loading Ns" counter. */
let loadElapsedInterval: ReturnType<typeof setInterval> | null = null;

function clearLoadIntervals(): void {
  if (loadElapsedInterval !== null) { clearInterval(loadElapsedInterval); loadElapsedInterval = null; }
}

/** Toggle the loading pulse on the rail LCD status text. */
function setLoadingVisual(on: boolean): void {
  if (lcdStatus) lcdStatus.classList.toggle("lcd--loading", on);
}

/**
 * Load a model by ID with real-time feedback. The router answers /models/load
 * with success immediately and loads the model asynchronously, so:
 * 1. Show a live "loading Ns" counter in the LCD.
 * 2. Fire load_model, then poll model_pool until the model is actually resident,
 *    updating the LCD and pool strip live (the poll awaits a sleep between
 *    iterations, so it never spins the CPU).
 * 3. On loaded: flip to SERVING. On error/timeout: surface a bubble + reset.
 *
 * Guards against overlapping loads: bumps loadToken so a superseded loop exits.
 */
async function pickAndLoadModel(modelId: string): Promise<void> {
  // Bump token so any previous load's poll loop stops
  const myToken = ++loadToken;

  // Update the composer select to match
  modelPick.value = modelId;

  // Mark as loading before the async call so the send gate can block.
  modelState = "loading";

  // Show loading state in LCD immediately
  const name = prettyName(modelId) || modelId;
  lcdModel.textContent = name;
  if (lcdStatus) lcdStatus.textContent = "loading 0s";
  setLoadingVisual(true);
  titlebarModel.textContent = `${name} · loading`;

  // Clear any leftover interval from a previous load
  clearLoadIntervals();

  // Elapsed-seconds counter that ticks once per second (cheap text update).
  // Capture the interval id locally so a token mismatch clears THIS timer only.
  const startedAt = Date.now();
  const elapsedId: ReturnType<typeof setInterval> = setInterval(() => {
    if (loadToken !== myToken) { clearInterval(elapsedId); return; }
    if (lcdStatus && modelState === "loading") {
      const secs = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      lcdStatus.textContent = `loading ${secs}s`;
    }
  }, 1000);
  loadElapsedInterval = elapsedId;

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  try {
    // The router answers /models/load with success IMMEDIATELY and loads the
    // model asynchronously, so we then poll model_pool until the model is
    // actually resident (loaded). This awaited loop sleeps between polls, so it
    // never spins the CPU.
    await invoke("load_model", { modelId });
    if (loadToken !== myToken) return; // superseded by another load

    const deadline = Date.now() + 180_000; // 3 min safety cap
    for (;;) {
      if (loadToken !== myToken) return;
      let view: PoolView | null = null;
      try { view = await invoke<PoolView>("model_pool"); } catch { /* router busy */ }
      if (loadToken !== myToken) return;
      if (view) {
        lastPoolView = view;
        renderPoolStrip(view);
        if (modelPopup.classList.contains("model-popup--open")) buildModelPopup(view);
        const entry = view.resident.find((e) => e.id === modelId);
        if (entry && (entry.status === "loaded" || entry.status === "sleeping")) {
          setActiveModel(modelId); // ready + SERVING, clears the loading visual
          loadPicker();
          return;
        }
      }
      if (Date.now() > deadline) throw new Error("the model took too long to load");
      await sleep(600);
    }
  } catch (err) {
    if (loadToken !== myToken) return;
    bubble("error", `model load failed: ${String(err)}`);
    modelState = "idle";
    setActiveModel(""); // resets the LCD and clears the loading visual
    modelPick.value = "";
  } finally {
    if (loadToken === myToken) clearLoadIntervals();
  }
}

// ============================================================
// Composer dropdown loads on change
// ============================================================

modelPick.addEventListener("change", () => {
  const val = modelPick.value;
  // Only trigger a real load for actual model ids, not the "Auto"/placeholder
  if (val) {
    pickAndLoadModel(val);
  }
});

// ============================================================
// Background pool sync (every 8s) to catch external changes
// ============================================================

setInterval(async () => {
  // Don't override LCD while a load is in progress
  if (modelState !== "loading") {
    await refreshPool();
  }
}, 8000);

// ============================================================
// Collapsible rail + privacy panel (with localStorage persistence)
// ============================================================

const STORAGE_KEY_RAIL = "lr_rail_collapsed";
const STORAGE_KEY_PRIVACY = "lr_privacy_collapsed";

function isRailCollapsed(): boolean {
  return localStorage.getItem(STORAGE_KEY_RAIL) === "1";
}
function isPrivacyCollapsed(): boolean {
  return localStorage.getItem(STORAGE_KEY_PRIVACY) === "1";
}

function applyRailState(collapsed: boolean): void {
  railEl.classList.toggle("rail--collapsed", collapsed);
  // Update chevron direction
  const icon = railCollapseBtn.querySelector(".rail__collapse-icon");
  if (icon) icon.innerHTML = collapsed ? "&#8250;" : "&#8249;";
  railCollapseBtn.setAttribute("aria-label", collapsed ? "Expand left panel" : "Collapse left panel");
  railCollapseBtn.title = collapsed ? "Expand left panel" : "Collapse left panel";
}

function applyPrivacyState(collapsed: boolean): void {
  privacyPanel.classList.toggle("privacy--collapsed", collapsed);
  // Update chevron direction
  const icon = privacyCollapseBtn.querySelector(".privacy__collapse-icon");
  if (icon) icon.innerHTML = collapsed ? "&#8249;" : "&#8250;";
  privacyCollapseBtn.setAttribute("aria-label", collapsed ? "Expand right panel" : "Collapse right panel");
  privacyCollapseBtn.title = collapsed ? "Expand right panel" : "Collapse right panel";
}

function toggleRail(): void {
  const next = !isRailCollapsed();
  localStorage.setItem(STORAGE_KEY_RAIL, next ? "1" : "0");
  applyRailState(next);
}

function togglePrivacy(): void {
  const next = !isPrivacyCollapsed();
  localStorage.setItem(STORAGE_KEY_PRIVACY, next ? "1" : "0");
  applyPrivacyState(next);
}

// Wire collapse buttons
railCollapseBtn.addEventListener("click", toggleRail);
privacyCollapseBtn.addEventListener("click", togglePrivacy);

// Restore collapsed state on load (no animation - instant)
applyRailState(isRailCollapsed());
applyPrivacyState(isPrivacyCollapsed());

// ============================================================
// Session + messaging
// ============================================================

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
    // Live theme updates from Settings window.
    await listen<Theme>("theme-changed", (e) => {
      applyTheme(e.payload);
    });

    // Respect OS theme changes when in system mode.
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (!document.documentElement.dataset.theme) {
        dither.refresh();
      }
    });

    await startNewSession();
    loadPicker();
    refreshTools();
    await listen<{ session: string; event: BrainEvent }>("chat:event", ({ payload }) => {
      if (payload.session !== session) return;
      const ev = payload.event;
      if (ev.kind === "routed") {
        bubble("trace", `routed to ${ev.model_id} · ${ev.category} · ${ev.reason}`);
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
        el.append(` ${ev.name} -> ${ev.preview}`);
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

  const picked = modelPick.value || null;

  // Block send while a model is still loading.
  if (modelState === "loading") {
    bubble("error", "a model is still loading, hold on.");
    return;
  }

  // If no model is ready and none explicitly selected, nudge the user.
  if (modelState === "idle" && !picked) {
    bubble("error", "load a model first. click the LCD or press Cmd+K to pick one.");
    openModelPopup();
    return;
  }

  bubble("user", text);
  input.value = "";
  setStreaming(true);
  try {
    await invoke("chat_send", { sessionId: session, message: text, hasImage: false, explicitGroup: null, explicitModel: picked });
  } catch (err) {
    bubble("error", String(err));
    setStreaming(false);
  }
});

// New chat button - start a fresh session
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

// ============================================================
// Drag-and-drop file/folder access
// ============================================================
//
// Uses the Tauri v2 webview drag-drop event (NOT browser ondrop, which never
// fires for OS file drops). Dropping a file or folder onto the chat grants the
// agent access to it via add_allowed_dirs, then references each granted path in
// the composer so the next message can ask about it. The listener is registered
// once on load and lives for the window lifetime; every payload is wrapped so a
// failure can never crash the listener.

const chatMain = document.querySelector(".chat-main") as HTMLElement | null;

/** Toggle the drop affordance overlay on the chat area. */
function setDropAffordance(on: boolean): void {
  document.body.classList.toggle("dragover", on);
  if (chatMain) chatMain.classList.toggle("dragover", on);
}

/** Append granted absolute paths to the composer, one per line, no auto-send. */
function referencePathsInComposer(paths: string[]): void {
  if (paths.length === 0) return;
  const existing = input.value;
  const needsBreak = existing.length > 0 && !existing.endsWith("\n");
  const block = paths.join("\n");
  input.value = existing + (needsBreak ? "\n" : "") + block + "\n";
  // Nudge the textarea so any autosize/scroll reacts, and focus for typing.
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
}

async function handleDroppedPaths(paths: string[]): Promise<void> {
  if (!paths || paths.length === 0) return;
  try {
    const granted = await invoke<string[]>("add_allowed_dirs", { paths });
    if (!granted || granted.length === 0) {
      bubble("error", "could not grant access to the dropped item(s).");
      return;
    }
    const names = granted.map(basename).join(", ");
    bubble("trace", `Granted access to ${granted.length} item(s): ${names}`);
    referencePathsInComposer(granted);
  } catch (err) {
    bubble("error", `granting file access failed: ${String(err)}`);
  }
}

// Register the OS-level drag-drop listener once. Wrapped so listener never dies.
getCurrentWebviewWindow()
  .onDragDropEvent((event) => {
    try {
      const t = event.payload.type;
      if (t === "over") {
        setDropAffordance(true);
      } else if (t === "drop") {
        setDropAffordance(false);
        const paths = (event.payload as { paths?: string[] }).paths ?? [];
        void handleDroppedPaths(paths);
      } else {
        // "leave" | "cancel" | anything else: clear the affordance.
        setDropAffordance(false);
      }
    } catch {
      setDropAffordance(false);
    }
  })
  .catch(() => { /* drag-drop unavailable; ignore */ });

// ============================================================
// "@"-mention file picker (insert a granted file's path)
// ============================================================
//
// Typing "@" at the start of the input or after whitespace opens a fuzzy search
// over the agent's GRANTED folders only (config.allowed_dirs, via the backend
// list_allowed_files command, which itself never leaves the allowlist). Selecting
// a file replaces the "@query" run with the file's ABSOLUTE path + a space, so the
// model can read_file it. Robust by design: every backend call is wrapped, the
// listener is registered once, and a backend that is not ready just shows nothing.

const atPopup = document.getElementById("at-popup") as HTMLDivElement;
const atPopupList = document.getElementById("at-popup-list") as HTMLDivElement;

// Index into the input where the current "@" sits (-1 = picker closed).
let atStart = -1;
let atResults: string[] = [];
let atActive = 0;
let atDebounce: ReturnType<typeof setTimeout> | null = null;
let atSearchToken = 0;

function atIsOpen(): boolean {
  return atPopup.classList.contains("at-popup--open");
}

function closeAtPopup(): void {
  atPopup.classList.remove("at-popup--open");
  atPopup.setAttribute("aria-hidden", "true");
  atStart = -1;
  atResults = [];
  atActive = 0;
  if (atDebounce !== null) { clearTimeout(atDebounce); atDebounce = null; }
}

/** Position the popup above the composer input, left-aligned to it. */
function positionAtPopup(): void {
  const r = input.getBoundingClientRect();
  const margin = 8;
  // Render to measure, then place above the input.
  atPopup.style.left = `${Math.max(margin, r.left)}px`;
  const height = atPopup.offsetHeight || 200;
  let top = r.top - height - 6;
  if (top < margin) top = r.bottom + 6; // fall back to below if no room above
  atPopup.style.top = `${top}px`;
}

function renderAtResults(): void {
  atPopupList.innerHTML = "";
  if (atResults.length === 0) {
    const hint = document.createElement("div");
    hint.className = "at-popup__hint";
    hint.textContent = "No granted files. Add a folder in Settings or drop one here.";
    atPopupList.appendChild(hint);
    positionAtPopup();
    return;
  }
  atResults.forEach((path, i) => {
    const row = document.createElement("div");
    row.className = "at-popup__row" + (i === atActive ? " at-popup__row--active" : "");
    row.setAttribute("role", "option");
    const base = document.createElement("span");
    base.className = "at-popup__base";
    base.textContent = basename(path);
    const dir = document.createElement("span");
    dir.className = "at-popup__dir";
    dir.textContent = shortenPath(path);
    row.appendChild(base);
    row.appendChild(dir);
    row.addEventListener("mousedown", (e) => {
      // mousedown (not click) so the textarea never loses focus first.
      e.preventDefault();
      selectAtResult(i);
    });
    atPopupList.appendChild(row);
  });
  positionAtPopup();
}

/** Replace the "@query" run with the chosen absolute path + a trailing space. */
function selectAtResult(i: number): void {
  const path = atResults[i];
  if (atStart < 0 || !path) { closeAtPopup(); return; }
  const value = input.value;
  const cursor = input.selectionStart ?? value.length;
  const before = value.slice(0, atStart);
  const after = value.slice(cursor);
  const insert = path + " ";
  input.value = before + insert + after;
  const caret = before.length + insert.length;
  input.selectionStart = input.selectionEnd = caret;
  closeAtPopup();
  input.focus();
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Inspect the text before the caret; return the query if a mention is active. */
function currentMention(): { start: number; query: string } | null {
  const value = input.value;
  const cursor = input.selectionStart ?? value.length;
  // Walk back from the cursor to find an "@" not interrupted by whitespace.
  let i = cursor - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === "@") {
      // Valid trigger only at start or right after whitespace.
      const prev = i > 0 ? value[i - 1] : "";
      if (i === 0 || /\s/.test(prev)) {
        return { start: i, query: value.slice(i + 1, cursor) };
      }
      return null;
    }
    if (/\s/.test(ch)) return null; // whitespace breaks the mention
    i--;
  }
  return null;
}

async function runAtSearch(query: string): Promise<void> {
  const token = ++atSearchToken;
  let results: string[] = [];
  try {
    results = await invoke<string[]>("list_allowed_files", { query });
  } catch {
    results = []; // backend not ready: show the empty-state hint, never throw
  }
  if (token !== atSearchToken || atStart < 0) return; // superseded or closed
  atResults = results;
  atActive = 0;
  renderAtResults();
}

/** Re-evaluate the mention state after any input/selection change. */
function syncAtPicker(): void {
  const mention = currentMention();
  if (!mention) {
    if (atIsOpen()) closeAtPopup();
    return;
  }
  atStart = mention.start;
  if (!atIsOpen()) {
    atPopup.classList.add("at-popup--open");
    atPopup.setAttribute("aria-hidden", "false");
    atResults = [];
    renderAtResults(); // show hint immediately while the search debounces
  }
  if (atDebounce !== null) clearTimeout(atDebounce);
  atDebounce = setTimeout(() => { void runAtSearch(mention.query); }, 120);
}

input.addEventListener("input", syncAtPicker);
input.addEventListener("click", syncAtPicker);

// Keyboard navigation while the picker is open. Capture phase so Enter/Tab/arrows
// are handled here before the form submit or textarea default kicks in.
input.addEventListener("keydown", (e) => {
  if (!atIsOpen()) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeAtPopup();
  } else if (e.key === "ArrowDown") {
    if (atResults.length === 0) return;
    e.preventDefault();
    atActive = (atActive + 1) % atResults.length;
    renderAtResults();
  } else if (e.key === "ArrowUp") {
    if (atResults.length === 0) return;
    e.preventDefault();
    atActive = (atActive - 1 + atResults.length) % atResults.length;
    renderAtResults();
  } else if (e.key === "Enter" || e.key === "Tab") {
    if (atResults.length === 0) return;
    e.preventDefault();
    selectAtResult(atActive);
  }
});

// Initialize
syncEmptyState();
init();
