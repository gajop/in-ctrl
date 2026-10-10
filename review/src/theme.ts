// Light, dark, or the system's setting, chosen per browser. The choice sets
// <html data-theme>; styles.css switches its colour variables on it.

import { type Theme, setTheme, store, theme } from "./store";

/** Apply the stored theme; call before anything renders to avoid a flash. */
export function applyTheme() {
  const value = theme();
  if (value === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;
}

/** A button that cycles auto → light → dark; every copy stays in sync. */
export function themeButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "theme-toggle";
  const render = () => {
    const current = theme();
    button.textContent = LABELS[current].icon;
    button.title = `Theme: ${LABELS[current].name} (click to change)`;
  };
  button.addEventListener("click", () => setTheme(NEXT[theme()]));
  store.addEventListener("change", (e) => {
    if ((e as CustomEvent<string>).detail !== "theme") return;
    applyTheme();
    render();
  });
  render();
  return button;
}

// Helpers

const NEXT: Record<Theme, Theme> = { auto: "light", light: "dark", dark: "auto" };

const LABELS: Record<Theme, { icon: string; name: string }> = {
  auto: { icon: "◐", name: "system" },
  light: { icon: "☀", name: "light" },
  dark: { icon: "☾", name: "dark" },
};
