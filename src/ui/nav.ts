// The two sections (Lessons, Tuner) and the tab bar.
import { bus, type ViewId } from "../state";
import { $, storage } from "../utils";
import { pushStep, removeStep } from "./back";

const KEY = "fretline:view";
let current: ViewId = "tuner";

export function currentView(): ViewId {
  return current;
}

export function showView(view: ViewId, remember = true): void {
  const previous = current;
  current = view;
  for (const id of ["lessons", "tuner"] as const) $(`view-${id}`).hidden = id !== view;
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => {
    if (t.dataset.view === view) t.setAttribute("aria-current", "page");
    else t.removeAttribute("aria-current");
  });
  if (remember) storage.set(KEY, view);
  // Back from Lessons returns to the tuner (the home section for now).
  if (view === "lessons" && previous !== "lessons") pushStep("view", () => showView("tuner"));
  if (view === "tuner") removeStep("view");
  bus.emit("viewchange", view);
}

export function initNav(): void {
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) =>
    t.addEventListener("click", () => showView(t.dataset.view as ViewId)),
  );
  const saved = storage.get<ViewId>(KEY, "tuner");
  current = saved === "lessons" ? "tuner" : saved; // so Lessons gets its back step
  showView(saved);
}
