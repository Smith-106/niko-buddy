/**
 * Tauri Store plugin wrapper for state persistence.
 * Provides access to JSON-based persistent storage in Tauri apps.
 * MIT licensed implementation.
 */

/**
 * Loads the application state store with automatic persistence.
 * This is a thin wrapper around @tauri-apps/plugin-store.
 * @returns Promise resolving to the store instance
 */
export async function getStore() {
  const { load } = await import("@tauri-apps/plugin-store")
  return load("app-state.json", { autoSave: true, defaults: {} })
}
