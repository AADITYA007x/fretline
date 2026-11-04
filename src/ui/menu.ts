import { getAccount, signOut } from "../cloud/session";
import { syncNow, syncStatus } from "../cloud/sync";
import { bus } from "../state";
import { $ } from "../utils";
import { closeSheet, openSheet } from "./sheets";

const SYNC_TEXT: Record<string, string> = {
  off: "",
  syncing: "Saving to your account…",
  ok: "Lessons, tab fixes and tunings are saved to your account.",
  offline: "Offline. Changes are kept on this phone and upload when you're back online.",
  "setup-needed": "Saving to your account needs a one-time setup (supabase/001_fretline.sql). Everything is kept on this phone until then.",
  error: "Couldn't save to your account just now. It'll try again.",
};

function renderSync(): void {
  $("sync-line").textContent = SYNC_TEXT[syncStatus()] ?? "";
}

function renderAccount(): void {
  const a = getAccount();
  $("menu-name").textContent = a?.name ?? "";
  $("menu-email").textContent = a?.email ?? "";
}

export function initMenu(): void {
  $("app-version").textContent = `Version ${__APP_VERSION__}`;
  $("menu-btn").addEventListener("click", () => {
    renderAccount();
    renderSync();
    void syncNow();
    openSheet("menu-sheet");
  });
  bus.on("syncstatus", renderSync);
  bus.on("authchange", renderAccount);
  $("sign-out-btn").addEventListener("click", async () => {
    if (!confirm("Sign out? You'll need to sign in again to use Fretline.")) return;
    closeSheet();
    await signOut();
  });
}
