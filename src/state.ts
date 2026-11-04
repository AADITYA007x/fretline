import type { Account } from "./cloud/session";
import { createEmitter } from "./utils";

export type ViewId = "lessons" | "tuner";

/** App-wide events. Modules subscribe instead of importing each other. */
export const bus = createEmitter<{
  /** Signed in (the account) or out (null). */
  authchange: Account | null;
  /** A short message at the bottom of the screen. */
  toast: string;
  /** The visible section changed. */
  viewchange: ViewId;
}>();
