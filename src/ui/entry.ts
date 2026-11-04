import { AUTH_KEY, supabase } from "../cloud/client";
import { friendly, signIn } from "../cloud/session";
import { $ } from "../utils";

const root = document.documentElement;

function hasSession(): boolean {
  try {
    return localStorage.getItem(AUTH_KEY) !== null;
  } catch {
    return false;
  }
}

function showError(message: string): void {
  const el = $("entry-error");
  el.textContent = message;
  el.hidden = !message;
}

let onOpen: () => void = () => {};

/** Something to do when the screen closes over the app (stop the mic…). */
export function whenEntryOpens(fn: () => void): void {
  onOpen = fn;
}

function setOpen(open: boolean): void {
  if (open === root.classList.contains("entry")) return;
  root.classList.toggle("entry", open);
  if (open) {
    onOpen();
    $<HTMLInputElement>("entry-password").value = "";
    showError("");
  }
}

export function initEntry(): void {
  setOpen(!hasSession());
  const submit = $<HTMLButtonElement>("entry-submit");
  $<HTMLFormElement>("entry-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    submit.disabled = true;
    try {
      await signIn($<HTMLInputElement>("entry-email").value, $<HTMLInputElement>("entry-password").value);
      setOpen(false);
    } catch (err) {
      showError(friendly(err));
    } finally {
      submit.disabled = false;
    }
  });
  supabase.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => setOpen(!session && !hasSession()), 0);
  });
}
