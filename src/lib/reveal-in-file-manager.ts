/**
 * Reveals a file in the system file manager.
 * Uses Tauri opener plugin on desktop, falls back to browser file:// URI.
 * MIT licensed implementation.
 */

import { isTauri } from "@/lib/platform"

/**
 * Opens the file explorer to the specified file location.
 * @param filePath - Absolute path to the file to reveal
 */
export async function revealInFileManager(filePath: string): Promise<void> {
  if (!filePath) return
  if (isTauri()) {
    try {
      const opener = await import("@tauri-apps/plugin-opener")
      const reveal = (
        opener as { revealItemInDir?: (path: string) => Promise<void> }
      ).revealItemInDir
      if (typeof reveal === "function") {
        await reveal(filePath)
        return
      }
      const openPath = (
        opener as { openPath?: (path: string) => Promise<void> }
      ).openPath
      if (typeof openPath === "function") {
        await openPath(filePath)
        return
      }
    } catch (error) {
      console.warn("[revealInFileManager] Tauri opener failed", error)
    }
  }
  // Fallback: try to open via file:// URI in browser
  try {
    window.open(
      `file://${filePath.replace(/\\/g, "/")}`,
      "_blank",
      "noopener,noreferrer",
    )
  } catch (error) {
    console.warn("[revealInFileManager] Browser fallback failed", error)
  }
}
