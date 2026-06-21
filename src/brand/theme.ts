import "../assets/fonts/fonts.css";
import "./tokens.css";
import "./components.css";

export type Theme = "light" | "dark" | "system";

/** Apply a theme. "system" clears the override so prefers-color-scheme wins. */
export function applyTheme(theme: Theme) {
  const el = document.documentElement;
  if (theme === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", theme);
}
