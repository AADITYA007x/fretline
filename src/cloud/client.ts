// Supabase: accounts (and, later, synced tabs and lessons).
// Same project as Groov, so the same accounts work. The publishable key is
// meant to ship inside apps; row-level security decides who sees what.
import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://tuampzpsciqannjolflv.supabase.co";
export const SUPABASE_KEY = "sb_publishable_TAqzXvJVHGX85oH6vSQnAQ_toa4eAJf";
export const AUTH_KEY = "fretline:auth";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: AUTH_KEY,
  },
});
