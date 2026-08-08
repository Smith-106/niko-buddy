/**
 * Opens an external URL in the user's default browser.
 * Uses Tauri opener plugin when running as desktop app,
 * falls back to window.open for web environments.
 * MIT licensed implementation.
 */

import { isTauri } from "@/lib/platform"

/**
 * Opens a URL in the user's default browser.
 * @param url - The URL to open
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener")
      await openUrl(url)
      return
    } catch (error) {
      console.warn(
        "[openExternalUrl] Tauri opener failed, falling back to window.open:",
        error,
      )
    }
  }

  window.open(url, "_blank", "noopener,noreferrer")
}
