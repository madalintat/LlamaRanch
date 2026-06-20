import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

// Shared window helpers used by both the main popover and the Settings window.

/** Tag <html data-os> so CSS adapts: Linux opaque, macOS/Windows frosted. */
export function tagOS() {
  const ua = navigator.userAgent;
  document.documentElement.dataset.os = ua.includes("Mac")
    ? "macos"
    : ua.includes("Win")
      ? "windows"
      : "linux";
}

/** Resize the current window to hug #app's content height. Two passes (after
 *  layout, then after fonts/images settle) so it always fits — never a tall box. */
export function fitWindow(width: number, max = 560) {
  const apply = () => {
    const el = document.getElementById("app");
    if (!el) return;
    const h = Math.min(max, Math.max(80, Math.ceil(el.offsetHeight)));
    getCurrentWindow().setSize(new LogicalSize(width, h)).catch(() => {});
  };
  requestAnimationFrame(apply);
  setTimeout(apply, 90);
}
