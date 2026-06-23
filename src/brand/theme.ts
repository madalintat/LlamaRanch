import "../assets/fonts/fonts.css";
import "./tokens.css";
import "./components.css";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "lr_theme";

/** Apply a theme. "system" clears the override so prefers-color-scheme wins. */
export function applyTheme(theme: Theme) {
  const el = document.documentElement;
  if (theme === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", theme);
}

/** Read the persisted theme and apply it immediately. Call once at startup. */
export function applyStoredTheme() {
  const stored = (localStorage.getItem(STORAGE_KEY) ?? "system") as Theme;
  applyTheme(stored);
}

/** Persist and apply a theme choice. */
export function saveTheme(theme: Theme) {
  localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
}

/** Read the currently persisted theme preference. */
export function getStoredTheme(): Theme {
  return (localStorage.getItem(STORAGE_KEY) ?? "system") as Theme;
}

// Apply immediately on module load to prevent flash of wrong theme.
applyStoredTheme();
