import type { Account } from "./cloud/session";
import { createEmitter } from "./utils";

export type SyncStatus = "off" | "syncing" | "ok" | "offline" | "setup-needed" | "error";

export type ViewId = "lessons" | "tuner";

/** App-wide events. Modules subscribe instead of importing each other. */
export const bus = createEmitter<{
  /** Signed in (the account) or out (null). */
  authchange: Account | null;
  /** A short message at the bottom of the screen. */
  toast: string;
  /** The visible section changed. */
  viewchange: ViewId;
  /** Something saved on the phone that should go to the account. */
  localchange: { kind: "lesson" | "fixes" | "settings"; id?: string };
  /** Something arrived from the account. */
  remotechange: { kind: "lesson" | "fixes" | "settings"; id?: string };
  syncstatus: SyncStatus;
}>();
