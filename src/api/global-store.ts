// Global session store singleton (persists across Vite HMR)

import { createMemoryStore } from "../session/memory";
import type { SessionStore } from "../session/types";

// Use a global variable to persist across HMR reloads
const GLOBAL_KEY = "__C0DE_SESSION_STORE__";

if (!(globalThis as any)[GLOBAL_KEY]) {
  (globalThis as any)[GLOBAL_KEY] = createMemoryStore();
}

export const globalSessionStore: SessionStore = (globalThis as any)[GLOBAL_KEY];
