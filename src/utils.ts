export function escapeHtml(s: string | null | undefined): string {
  return (s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Typed element lookup that fails loudly if index.html and the code drift apart. */
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el as T;
}

/** JSON localStorage wrapper that never throws (private mode, full quota, etc). */
export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage unavailable or full; the value just won't persist
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

type Listener<T> = (payload: T) => void;

/** Tiny typed event bus so modules can talk without importing each other. */
export function createEmitter<Events extends Record<string, unknown>>() {
  const listeners = new Map<keyof Events, Set<Listener<never>>>();
  return {
    on<K extends keyof Events>(event: K, fn: Listener<Events[K]>) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn as Listener<never>);
      return () => listeners.get(event)!.delete(fn as Listener<never>);
    },
    emit<K extends keyof Events>(event: K, payload: Events[K]) {
      listeners.get(event)?.forEach((fn) => (fn as Listener<Events[K]>)(payload));
    },
  };
}
