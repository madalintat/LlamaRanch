import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { tagOS, fitWindow } from "./platform";
import {
  enable as autoEnable,
  disable as autoDisable,
  isEnabled as autoIsEnabled,
} from "@tauri-apps/plugin-autostart";
import { saveTheme, getStoredTheme, type Theme } from "./brand/theme.ts";
import "./styles.css";

tagOS(); // match the main window: Linux opaque, macOS/Windows frosted

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const win = getCurrentWindow();
const fit = () => fitWindow(400, 640);

// ── Settings tab switching ────────────────────────────────────────
type SettingsTab = "general" | "tools" | "server";

function switchTab(tab: SettingsTab) {
  const tabs: SettingsTab[] = ["general", "tools", "server"];
  tabs.forEach((t) => {
    const btn = document.getElementById(`s-tab-${t}`)!;
    const panel = document.getElementById(`s-panel-${t}`)!;
    const active = t === tab;
    btn.classList.toggle("tab--active", active);
    panel.classList.toggle("s-panel--hidden", !active);
  });
  fit();
}

document.getElementById("s-tab-general")?.addEventListener("click", () => switchTab("general"));
document.getElementById("s-tab-tools")?.addEventListener("click", () => switchTab("tools"));
document.getElementById("s-tab-server")?.addEventListener("click", () => switchTab("server"));

// ── Theme segmented control ───────────────────────────────────────

function syncThemeSeg(current: Theme) {
  document.querySelectorAll<HTMLButtonElement>(".s-theme-seg__btn").forEach((btn) => {
    const val = btn.dataset.themeVal as Theme;
    const active = val === current;
    btn.classList.toggle("s-theme-seg__btn--active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
}

document.querySelectorAll<HTMLButtonElement>(".s-theme-seg__btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const val = btn.dataset.themeVal as Theme;
    saveTheme(val);
    syncThemeSeg(val);
    // Notify other windows so they re-apply immediately.
    await emit("theme-changed", val);
  });
});

// Initialize segmented control to match stored preference.
syncThemeSeg(getStoredTheme());

type ToolInfo = {
  name: string;
  label: string;
  scope: string;   // "local" | "online"
  enabled: boolean;
  note: string;
};

// ── Toggle pill helper ────────────────────────────────────────────
// Keeps the pill `.toggle` in sync with the hidden `<input type=checkbox>`.
// The config save reads the hidden checkbox directly - behavior unchanged.
function bindToggle(toggleId: string, checkId: string, ledId: string) {
  const toggle = document.getElementById(toggleId)!;
  const check = $(checkId);
  const led = document.getElementById(ledId)!;

  function syncUI(on: boolean) {
    toggle.classList.toggle("toggle--on", on);
    toggle.classList.toggle("toggle--off", !on);
    toggle.setAttribute("aria-checked", String(on));
    led.classList.toggle("led--on", on);
    led.classList.toggle("led--idle", !on);
  }

  toggle.addEventListener("click", () => {
    check.checked = !check.checked;
    syncUI(check.checked);
  });

  toggle.addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      check.checked = !check.checked;
      syncUI(check.checked);
    }
  });

  // Returns a setter so load() can drive initial state.
  return (on: boolean) => {
    check.checked = on;
    syncUI(on);
  };
}

const setExpose    = bindToggle("s-expose-toggle",    "s-expose",    "s-expose-led");
const setAutostart = bindToggle("s-autostart-toggle", "s-autostart", "s-autostart-led");
const setOffline   = bindToggle("s-offline-toggle",   "s-offline",   "s-offline-led");

// Full-row click forwarding: let any part of the toggle row trigger the pill
document.getElementById("s-expose-row")?.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest(".toggle")) document.getElementById("s-expose-toggle")!.click();
});
document.getElementById("s-autostart-row")?.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest(".toggle")) document.getElementById("s-autostart-toggle")!.click();
});
document.getElementById("s-offline-row")?.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest(".toggle")) document.getElementById("s-offline-toggle")!.click();
});

function renderTools(tools: ToolInfo[]) {
  const container = document.getElementById("s-tools-list")!;
  container.innerHTML = "";
  tools.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "s-row" + (t.enabled ? "" : " s-row--muted");
    const tagClass = t.scope === "online" ? "tag" : "tag tag--local";
    const toggleClass = t.enabled ? "toggle toggle--on" : "toggle toggle--off";
    const nameClass = t.enabled ? "s-row__name" : "s-row__name s-row__name--off";
    const noteHtml = (!t.enabled && t.note)
      ? `<div class="meta" style="color:var(--fg-dim,#888);">${t.note}</div>`
      : "";
    row.innerHTML = `
      <span class="partno">${String(i + 1).padStart(2, "0")}</span>
      <div class="s-row__body">
        <div class="${nameClass}">${t.label}</div>
        ${noteHtml}
      </div>
      <span class="${tagClass}">${t.scope.toUpperCase()}</span>
      <div class="${toggleClass}" aria-label="${t.label} ${t.enabled ? "enabled" : "disabled"}" title="${t.label}"></div>
    `;
    container.appendChild(row);
  });

  // Update MCP partno to follow the tool list
  const mcpPartno = document.querySelector(".s-tools-mcp-partno");
  if (mcpPartno) mcpPartno.textContent = String(tools.length + 1).padStart(2, "0");
}

// ── Shortcuts section ─────────────────────────────────────────────

const isMac = navigator.platform.toUpperCase().includes("MAC");

/** Convert a Tauri accelerator string like "CmdOrCtrl+Shift+J" to a readable label. */
function accelToLabel(accel: string): string {
  return accel
    .split("+")
    .map((part) => {
      switch (part) {
        case "CmdOrCtrl": return isMac ? "⌘" : "Ctrl";
        case "Ctrl":      return isMac ? "⌃" : "Ctrl";
        case "Alt":       return isMac ? "⌥" : "Alt";
        case "Shift":     return isMac ? "⇧" : "Shift";
        case "Meta":      return isMac ? "⌘" : "Win";
        case "Super":     return isMac ? "⌘" : "Win";
        default:          return part.length === 1 ? part.toUpperCase() : part;
      }
    })
    .join(isMac ? "" : "+");
}

/** Convert a keydown event to a Tauri accelerator string. Returns null if no valid combo. */
function eventToAccel(e: KeyboardEvent): string | null {
  const key = e.key;
  // Ignore standalone modifier presses.
  if (["Meta", "Control", "Alt", "Shift", "Super"].includes(key)) return null;
  const mods: string[] = [];
  if (e.metaKey || e.ctrlKey) mods.push("CmdOrCtrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  // Require at least one modifier.
  if (mods.length === 0) return null;
  // Map special keys to Tauri names.
  const keyMap: Record<string, string> = {
    ",": ",", ".": ".", "/": "/", ";": ";", "'": "'",
    "[": "[", "]": "]", "\\": "\\", "`": "`", "-": "-", "=": "=",
    " ": "Space", "ArrowUp": "Up", "ArrowDown": "Down",
    "ArrowLeft": "Left", "ArrowRight": "Right",
    "Escape": "Escape", "Enter": "Return", "Backspace": "Backspace",
    "Delete": "Delete", "Tab": "Tab",
  };
  const mapped = keyMap[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return [...mods, mapped].join("+");
}

type ShortcutKey = "cmdbar" | "agent" | "settings";

const shortcuts: Record<ShortcutKey, string> = {
  cmdbar: "CmdOrCtrl+K",
  agent: "CmdOrCtrl+J",
  settings: "CmdOrCtrl+,",
};

function renderShortcutKey(key: ShortcutKey) {
  const el = document.getElementById(`s-sc-key-${key}`)!;
  el.textContent = accelToLabel(shortcuts[key]);
  el.classList.remove("s-shortcut-key--capture");
}

function startCapture(key: ShortcutKey) {
  const el = document.getElementById(`s-sc-key-${key}`)!;
  const btn = document.getElementById(`s-sc-rebind-${key}`) as HTMLButtonElement;
  el.textContent = "press keys...";
  el.classList.add("s-shortcut-key--capture");
  btn.textContent = "Cancel";
  btn.dataset.capturing = "1";

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      cancel();
      return;
    }
    const accel = eventToAccel(e);
    if (!accel) return;
    e.preventDefault();
    e.stopPropagation();
    finish(accel);
  }

  function cancel() {
    cleanup();
    renderShortcutKey(key);
    btn.textContent = "Rebind";
    delete btn.dataset.capturing;
  }

  function cleanup() {
    window.removeEventListener("keydown", onKey, true);
  }

  async function finish(accel: string) {
    cleanup();
    const prev = shortcuts[key];
    shortcuts[key] = accel;
    renderShortcutKey(key);
    btn.textContent = "Rebind";
    delete btn.dataset.capturing;

    const errEl = document.getElementById("s-sc-error")!;
    errEl.textContent = "";
    errEl.classList.add("hidden");

    try {
      await invoke("set_shortcuts", {
        cmdbar: shortcuts.cmdbar,
        agent: shortcuts.agent,
        settings: shortcuts.settings,
      });
    } catch (e) {
      // Revert on failure.
      shortcuts[key] = prev;
      renderShortcutKey(key);
      errEl.textContent = String(e).replace(/^error:\s*/, "");
      errEl.classList.remove("hidden");
      fit();
    }
  }

  window.addEventListener("keydown", onKey, true);
}

(["cmdbar", "agent", "settings"] as ShortcutKey[]).forEach((key) => {
  const btn = document.getElementById(`s-sc-rebind-${key}`) as HTMLButtonElement;
  btn.addEventListener("click", () => {
    if (btn.dataset.capturing) {
      // Cancel active capture.
      btn.click(); // the keydown Escape handler handles it; trigger via Escape simulation
      // Simpler: just dispatch an Escape keydown to our own listener.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } else {
      startCapture(key);
    }
  });
});

async function load() {
  const cfg = await invoke<any>("get_config");
  $("s-port").value = String(cfg.port);
  $("s-models").value = cfg.models_dir;
  $("s-bin").value = cfg.server_bin;
  $("s-idle").value = String(cfg.sleep_idle_seconds ?? 0);
  $("s-models-max").value = String(cfg.models_max ?? 1);
  $("s-hf").value = cfg.hf_token ?? "";
  setExpose(cfg.expose_to_network);
  setOffline(cfg.offline_mode ?? false);
  ($("s-searxng") as HTMLInputElement).value = cfg.searxng_url ?? "";
  const allowedDirsEl = document.getElementById("s-allowed-dirs") as HTMLTextAreaElement;
  allowedDirsEl.value = (cfg.allowed_dirs ?? []).join("\n");
  try { setAutostart(await autoIsEnabled()); } catch {}

  // Load stored shortcuts and render them.
  shortcuts.cmdbar = cfg.shortcut_cmdbar ?? "CmdOrCtrl+K";
  shortcuts.agent = cfg.shortcut_agent ?? "CmdOrCtrl+J";
  shortcuts.settings = cfg.shortcut_settings ?? "CmdOrCtrl+,";
  (["cmdbar", "agent", "settings"] as ShortcutKey[]).forEach(renderShortcutKey);

  try {
    const tools = await invoke<ToolInfo[]>("list_tools");
    renderTools(tools);
  } catch {
    /* backend not ready yet - leave static placeholder */
  }

  fit();
}

async function save() {
  try {
    const want = $("s-autostart").checked;
    if ((await autoIsEnabled()) !== want) want ? await autoEnable() : await autoDisable();
  } catch {}

  // Parse allowed_dirs from textarea (one path per line, trim blanks)
  const allowedDirsEl = document.getElementById("s-allowed-dirs") as HTMLTextAreaElement;
  const allowed_dirs = allowedDirsEl.value
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // We must send the full Config - load existing to preserve fields we don't expose
  let existingCfg: any = {};
  try { existingCfg = await invoke<any>("get_config"); } catch {}

  try {
    await invoke("set_config", {
      newCfg: {
        ...existingCfg,
        port: Number($("s-port").value),
        models_dir: $("s-models").value,
        server_bin: $("s-bin").value,
        sleep_idle_seconds: Number($("s-idle").value) || 0,
        models_max: Number($("s-models-max").value) || 1,
        hf_token: $("s-hf").value.trim(),
        expose_to_network: $("s-expose").checked,
        offline_mode: $("s-offline").checked,
        searxng_url: ($("s-searxng") as HTMLInputElement).value.trim(),
        allowed_dirs,
      },
    });
  } catch (e) {
    const err = document.getElementById("s-error")!;
    err.textContent = String(e).replace(/^error:\s*/, "");
    err.classList.remove("hidden");
    fit();
    return;
  }
  await emit("config-changed");   // tell the main panel to refresh
  await win.hide();
}

$("s-save").onclick = save;
$("s-cancel").onclick = () => win.hide();
$("s-close").onclick = () => win.hide();
// Closing the window just tucks it away so it can reopen instantly.
win.onCloseRequested((e) => { e.preventDefault(); win.hide(); });

load();
