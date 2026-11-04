// Bottom sheets: one open at a time, closed by the backdrop, the back
// button, or Escape.
import { pushStep, removeStep } from "./back";
import { $ } from "../utils";

let openId: string | null = null;
const closeHandlers = new Map<string, () => void>();

export function openSheet(id: string, onClose?: () => void): void {
  if (openId && openId !== id) closeSheet();
  openId = id;
  if (onClose) closeHandlers.set(id, onClose);
  $(id).hidden = false;
  $("sheet-backdrop").hidden = false;
  pushStep("sheet", () => closeSheet(false));
}

export function closeSheet(fromCode = true): void {
  if (!openId) return;
  const id = openId;
  openId = null;
  $(id).hidden = true;
  $("sheet-backdrop").hidden = true;
  if (fromCode) removeStep("sheet");
  const fn = closeHandlers.get(id);
  closeHandlers.delete(id);
  fn?.();
}

export function isSheetOpen(id?: string): boolean {
  return id ? openId === id : openId !== null;
}

export function initSheets(): void {
  $("sheet-backdrop").addEventListener("click", () => closeSheet());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSheet();
  });
}
