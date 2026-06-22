import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { tagOS, fitWindow } from "./platform";
import {
  enable as autoEnable,
  disable as autoDisable,
  isEnabled as autoIsEnabled,
} from "@tauri-apps/plugin-autostart";
import "./brand/theme.ts";
import "./styles.css";

tagOS(); // match the main window: Linux opaque, macOS/Windows frosted

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const win = getCurrentWindow();
const fit = () => fitWindow(400, 680);

// ── Toggle pill helper ────────────────────────────────────────────
// Keeps the pill `.toggle` in sync with the hidden `<input type=checkbox>`.
// The config save reads the hidden checkbox directly — behavior unchanged.
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

// Full-row click forwarding: let any part of the toggle row trigger the pill
document.getElementById("s-expose-row")?.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest(".toggle")) document.getElementById("s-expose-toggle")!.click();
});
document.getElementById("s-autostart-row")?.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest(".toggle")) document.getElementById("s-autostart-toggle")!.click();
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
  try { setAutostart(await autoIsEnabled()); } catch {}
  fit();
}

async function save() {
  try {
    const want = $("s-autostart").checked;
    if ((await autoIsEnabled()) !== want) want ? await autoEnable() : await autoDisable();
  } catch {}
  try {
    await invoke("set_config", {
      newCfg: {
        port: Number($("s-port").value),
        models_dir: $("s-models").value,
        server_bin: $("s-bin").value,
        sleep_idle_seconds: Number($("s-idle").value) || 0,
        models_max: Number($("s-models-max").value) || 1,
        hf_token: $("s-hf").value.trim(),
        expose_to_network: $("s-expose").checked,
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
