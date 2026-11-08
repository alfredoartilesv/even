/**
 * Light, dark or the system's (You > About). A display choice of this device, so it lives in
 * localStorage, not the database, and applies before the first paint (shell/start.tsx) through
 * data-theme on <html>, which palette.css reads.
 */
export type Theme = "system" | "light" | "dark";

const KEY = "even.theme";

export function storedTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(t: Theme): void {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

export function saveTheme(t: Theme): void {
  applyTheme(t);
  try {
    if (t === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    // Private mode: the choice holds for this visit only.
  }
}
