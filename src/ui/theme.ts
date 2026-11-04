// Colour presets. Each one swaps only the board and accent tokens (see the
// top of style.css), so every theme still feels like the same app.
import { $, storage } from "../utils";

interface Theme {
  label: string;
  vars: Record<"--board" | "--board-2" | "--accent" | "--accent-bright", string>;
}

const THEMES: Record<string, Theme> = {
  rosewood: {
    label: "Rosewood",
    vars: { "--board": "#1d1512", "--board-2": "#2a1f1a", "--accent": "#c9a15a", "--accent-bright": "#e6c17e" },
  },
  ebony: {
    label: "Ebony",
    vars: { "--board": "#141619", "--board-2": "#1f2227", "--accent": "#a9b9c9", "--accent-bright": "#d2dde8" },
  },
  koa: {
    label: "Koa",
    vars: { "--board": "#24140e", "--board-2": "#331d14", "--accent": "#e0884f", "--accent-bright": "#f4a874" },
  },
};

const KEY = "fretline:theme";

function apply(id: string): void {
  const theme = THEMES[id] ?? THEMES.rosewood;
  const style = document.documentElement.style;
  for (const [prop, value] of Object.entries(theme.vars)) style.setProperty(prop, value);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.vars["--board"]);
  storage.set(KEY, id);
  $("theme-swatches")
    .querySelectorAll<HTMLElement>(".swatch")
    .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.theme === id)));
}

export function initTheme(): void {
  const host = $("theme-swatches");
  host.innerHTML = "";
  for (const [id, theme] of Object.entries(THEMES)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.dataset.theme = id;
    b.innerHTML = `<i style="background: linear-gradient(135deg, ${theme.vars["--board-2"]} 45%, ${theme.vars["--accent"]} 45%)"></i>${theme.label}`;
    b.addEventListener("click", () => apply(id));
    host.appendChild(b);
  }
  apply(storage.get<string>(KEY, "rosewood"));
}
