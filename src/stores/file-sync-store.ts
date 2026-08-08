// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Studio Contributors
// File synchronization progress store for batch file operations.

import { create } from "zustand"
import type { FileChangeTask } from "@/commands/file-sync"

/** State shape for the file-sync progress tracker. */
interface FileSyncState {
  tasks: FileChangeTask[]
  running: boolean
  lastError: string | null
  setTasks: (tasks: FileChangeTask[]) => void
  setRunning: (running: boolean) => void
  setLastError: (error: string | null) => void
  clear: () => void
}

/**
 * Lightweight Zustand store that mirrors the current batch file-sync
 * operation. Components observe `running` and `lastError` to render
 * progress indicators and error banners.
 */
export const useFileSyncStore = create<FileSyncState>((set) => ({
  tasks: [],
  running: false,
  lastError: null,
  setTasks: (incoming) => set({ tasks: incoming }),
  setRunning: (isRunning) => set({ running: isRunning }),
  setLastError: (err) => set({ lastError: err }),
  clear: () => set({ tasks: [], running: false, lastError: null }),
}))
