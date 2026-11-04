import { getAccount, signOut } from "../cloud/session";
import { bus } from "../state";
import { $ } from "../utils";
import { closeSheet, openSheet } from "./sheets";

function renderAccount(): void {
  const a = getAccount();
  $("menu-name").textContent = a?.name ?? "";
  $("menu-email").textContent = a?.email ?? "";
}

export function initMenu(): void {
  $("app-version").textContent = `Version ${__APP_VERSION__}`;
  $("menu-btn").addEventListener("click", () => {
    renderAccount();
    openSheet("menu-sheet");
  });
  bus.on("authchange", renderAccount);
  $("sign-out-btn").addEventListener("click", async () => {
    if (!confirm("Sign out? You'll need to sign in again to use Fretline.")) return;
    closeSheet();
    await signOut();
  });
}
