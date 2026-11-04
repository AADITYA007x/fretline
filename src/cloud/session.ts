// Who's signed in. Kept tiny so any module can ask without import cycles.
import { bus } from "../state";
import { supabase } from "./client";

export interface Account {
  id: string;
  email: string;
  name: string;
}

let account: Account | null = null;

export function getAccount(): Account | null {
  return account;
}

async function loadAccount(user: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null) {
  if (!user) {
    setAccount(null);
    return;
  }
  const fallbackName = (user.user_metadata?.display_name as string) || (user.email ?? "").split("@")[0];
  setAccount({ id: user.id, email: user.email ?? "", name: fallbackName });
  // The display name lives in the shared profiles table (made by Groov).
  const { data } = await supabase.from("profiles").select("display_name").eq("id", user.id).maybeSingle();
  if (data?.display_name && account?.id === user.id) setAccount({ ...account, name: data.display_name });
}

function setAccount(next: Account | null): void {
  const changed = account?.id !== next?.id || account?.name !== next?.name;
  account = next;
  if (changed) bus.emit("authchange", account);
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

/** Plain-English versions of Supabase's errors. */
export function friendly(error: unknown): string {
  const msg = (error as Error)?.message || String(error);
  if (/invalid login credentials/i.test(msg)) return "Wrong email or password.";
  if (/email not confirmed/i.test(msg)) return "Confirm your email first (check your inbox).";
  if (/rate limit/i.test(msg)) return "Too many tries. Wait a minute and try again.";
  if (/fetch|network/i.test(msg)) return "Can't reach the server. Check your internet.";
  return msg;
}

export function initSession(): void {
  supabase.auth.onAuthStateChange((_event, session) => {
    // Supabase recommends not awaiting other Supabase calls inside this callback.
    setTimeout(() => void loadAccount(session?.user ?? null), 0);
  });
}
