import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import {
  enable as autoEnable,
  disable as autoDisable,
  isEnabled as autoIsEnabled,
} from "@tauri-apps/plugin-autostart";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "./styles.css";

const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
const win = getCurrentWindow();

// Keep this window sized to its content, like the main popover.
function fit() {
  requestAnimationFrame(() => {
    const h = Math.min(620, Math.max(220, Math.ceil(document.getElementById("app")!.scrollHeight)));
    win.setSize(new LogicalSize(380, h)).catch(() => {});
  });
}

async function load() {
  const cfg = await invoke<any>("get_config");
  $("s-port").value = String(cfg.port);
  $("s-models").value = cfg.models_dir;
  $("s-bin").value = cfg.server_bin;
  $("s-idle").value = String(cfg.sleep_idle_seconds ?? 0);
  $("s-hf").value = cfg.hf_token ?? "";
  $("s-expose").checked = cfg.expose_to_network;
  try { $("s-autostart").checked = await autoIsEnabled(); } catch {}
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
