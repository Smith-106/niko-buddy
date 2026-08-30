import { governUserMemoryConfig } from "./governance"
import { loadGlobalUserMemoryConfig, saveGlobalUserMemoryConfig } from "./store"

type StorageLike = Pick<Storage, "getItem" | "setItem">

function runtimeStorage(): StorageLike | null {
  try { return typeof window === "undefined" ? null : window.localStorage } catch { return null }
}

export function runUserMemoryMaintenance(storage: StorageLike | null = runtimeStorage(), now = Date.now()): boolean {
  if (!storage) return false
  const current = loadGlobalUserMemoryConfig(storage)
  const governed = governUserMemoryConfig(current, now)
  const comparable = { ...governed, updatedAt: current.updatedAt }
  if (JSON.stringify(comparable) === JSON.stringify(current)) return false
  saveGlobalUserMemoryConfig({ ...governed, updatedAt: now }, storage)
  return true
}
