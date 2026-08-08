// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Studio Contributors
// Import progress tracker store for chapter and outline ingestion workflows.

import { create } from "zustand"
import { normalizePath } from "@/lib/path-utils"

/** Discriminator for the kind of content being imported. */
export type ImportProgressKind = "chapter" | "outline" | "outline_generation" | "outline_refinement"

/** Lifecycle states an import task can occupy. */
export type ImportProgressStatus = "running" | "done" | "cancelled" | "error"

/**
 * A single import operation being tracked. Carries enough metadata for
 * the UI to render a progress bar with cancellation support.
 */
export interface ImportProgressTask {
  id: string
  projectPath: string
  kind: ImportProgressKind
  status: ImportProgressStatus
  completed: number
  total: number
  currentTitle: string
  message?: string
  error?: string
  cancelling: boolean
  createdAt: number
  updatedAt: number
  abortController?: AbortController
}

/** Input payload required to kick off a new import progress task. */
interface StartImportProgressTaskInput {
  projectPath: string
  kind: ImportProgressKind
  total: number
  currentTitle?: string
  message?: string
  abortController?: AbortController
}

/** Public state surface exposed by the import progress store. */
export interface ImportProgressState {
  tasks: ImportProgressTask[]
  startTask: (input: StartImportProgressTaskInput) => string
  updateTask: (taskId: string, patch: Partial<ImportProgressTask>) => void
  finishTask: (
    taskId: string,
    status: Exclude<ImportProgressStatus, "running">,
    patch?: Partial<ImportProgressTask>,
  ) => void
  markCancelling: (taskId: string) => void
  cancelTask: (taskId: string) => void
  clearTask: (taskId: string) => void
  getLatestTask: (projectPath: string, kind?: ImportProgressKind) => ImportProgressTask | null
}

/** Auto-incrementing sequence used to mint unique task identifiers. */
let importSeq = 0

/** Grace period (ms) before a cancelled task is removed from the list. */
const CANCEL_CLEAR_DELAY_MS = 3_000

/**
 * Zustand store tracking the lifecycle of chapter/outline import
 * operations. Supports concurrent tasks keyed by project path so
 * multiple projects can ingest in parallel.
 */
export const useImportProgressStore = create<ImportProgressState>((set, get) => ({
  tasks: [],

  startTask: (input) => {
    const now = Date.now()
    const taskId = `import-progress-${++importSeq}`
    const normalised = normalizePath(input.projectPath)
    const newTask: ImportProgressTask = {
      id: taskId,
      projectPath: normalised,
      kind: input.kind,
      status: "running",
      completed: 0,
      total: input.total,
      currentTitle: input.currentTitle ?? "",
      message: input.message,
      cancelling: false,
      createdAt: now,
      updatedAt: now,
      abortController: input.abortController,
    }
    set((prev) => ({ tasks: [newTask, ...prev.tasks] }))
    return taskId
  },

  updateTask: (taskId, patch) => {
    const touched = Date.now()
    set((prev) => ({
      tasks: prev.tasks.map((t) =>
        t.id === taskId ? { ...t, ...patch, updatedAt: touched } : t
      ),
    }))
  },

  finishTask: (taskId, terminalStatus, patch = {}) => {
    get().updateTask(taskId, { ...patch, status: terminalStatus, cancelling: false })
  },

  markCancelling: (taskId) => {
    get().updateTask(taskId, { cancelling: true })
  },

  cancelTask: (taskId) => {
    const match = get().tasks.find((t) => t.id === taskId)
    if (!match) return
    match.abortController?.abort()
    get().updateTask(taskId, { status: "cancelled", cancelling: false })
    setTimeout(() => {
      get().clearTask(taskId)
    }, CANCEL_CLEAR_DELAY_MS)
  },

  clearTask: (taskId) => {
    set((prev) => ({ tasks: prev.tasks.filter((t) => t.id !== taskId) }))
  },

  getLatestTask: (projectPath, kind) => {
    const normalised = normalizePath(projectPath)
    const candidates = get().tasks.filter(
      (t) => t.projectPath === normalised && (!kind || t.kind === kind)
    )
    candidates.sort((a, b) => b.updatedAt - a.updatedAt)
    return candidates[0] ?? null
  },
}))
