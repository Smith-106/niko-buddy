/**
 * Application state persistence.
 * Desktop uses the Tauri store; a plain browser keeps the same key-value
 * contract in localStorage so startup and settings do not crash.
 * MIT licensed implementation.
 */
import { isTauri } from "@/lib/platform"

interface AppStateStore {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown): Promise<void>
  save(): Promise<void>
}

const BROWSER_STORE_KEY = "niko-buddy.app-state"

function readBrowserState(): Record<string, unknown> {
  if (typeof localStorage === "undefined") return {}
  try {
    const raw = localStorage.getItem(BROWSER_STORE_KEY)
    const parsed = raw ? JSON.parse(raw) as unknown : {}
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function browserStore(): AppStateStore {
  return {
    async get<T>(key: string): Promise<T | null> {
      const value = readBrowserState()[key]
      return value === undefined ? null : value as T
    },
    async set(key: string, value: unknown): Promise<void> {
      if (typeof localStorage === "undefined") return
      const next = { ...readBrowserState(), [key]: value }
      localStorage.setItem(BROWSER_STORE_KEY, JSON.stringify(next))
    },
    async save(): Promise<void> {},
  }
}

/**
 * Loads the application state store with automatic persistence.
 * @returns Promise resolving to the store instance
 */
export async function getStore(): Promise<AppStateStore> {
  if (!isTauri()) return browserStore()
  const { load } = await import("@tauri-apps/plugin-store")
  return load("app-state.json", { autoSave: true, defaults: {} })
}
