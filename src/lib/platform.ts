/**
 * Platform detection utilities for cross-environment compatibility.
 * Supports both Tauri desktop and browser web environments.
 * MIT licensed implementation.
 */

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
}

/**
 * Checks if the current environment is a Tauri desktop app.
 * @returns True when running inside Tauri
 */
export function isTauri(): boolean {
  return (
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
  )
}

/**
 * Checks if the browser supports the FileSystem Directory Picker API.
 * @returns True when directory picker is available
 */
export function supportsDirectoryPicker(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function"
  )
}

/**
 * Prompts user to select a directory using available platform methods.
 * Tries Tauri dialog first, then FileSystem Directory Picker API,
 * finally falls back to plain text input prompt.
 * @returns Selected directory name or null if cancelled
 */
export async function pickDirectory(): Promise<string | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog")
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择文件夹",
    })
    return selected ?? null
  }

  if (supportsDirectoryPicker()) {
    try {
      const pickerWindow = window as DirectoryPickerWindow
      const handle = await pickerWindow.showDirectoryPicker?.()
      return handle?.name ?? null
    } catch (err) {
      if ((err as DOMException).name === "AbortError") {
        return null
      }
      throw err
    }
  }

  return window.prompt("请输入文件夹路径：")
}
