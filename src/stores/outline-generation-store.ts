// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Studio Contributors
// Outline generation task tracking store.

import { create } from "zustand"

/** Lifecycle status for an outline generation task. */
export type OutlineTaskStatus = "generating" | "generated" | "ingesting" | "done" | "error"

/** Kind of outline operation this task represents. */
export type OutlineTaskKind = "outline" | "refine" | "ingest"

/**
 * A single outline generation task, tracking it from creation through
 * ingestion or error. Persisted only in memory (no disk backing).
 */
export interface OutlineGenerationTask {
  id: string
  projectPath: string
  kind: OutlineTaskKind
  genre: string
  scale: string
  premise: string
  prompt: string
  userRequest: string
  selectedSectionKey: string | null
  displayTitle: string | null
  writeMode: string | null
  targetPath: string | null
  outlinePath: string | null
  status: OutlineTaskStatus
  message: string
  error: string | null
  createdAt: number
  updatedAt: number
}

/** Input fields accepted when creating a new outline task. All optional beyond projectPath. */
interface CreateOutlineTaskInput {
  projectPath: string
  kind?: OutlineTaskKind
  genre?: string
  scale?: string
  premise?: string
  prompt?: string
  userRequest?: string
  selectedSectionKey?: string | null
  displayTitle?: string | null
  writeMode?: string | null
  targetPath?: string | null
  outlinePath?: string | null
  status?: OutlineTaskStatus
  message?: string
  error?: string | null
}

/** Public surface of the outline generation store. */
export interface OutlineGenerationState {
  tasks: OutlineGenerationTask[]
  panelOpen: boolean
  setPanelOpen: (open: boolean) => void
  createTask: (input: CreateOutlineTaskInput) => string
  updateTask: (taskId: string, patch: Partial<OutlineGenerationTask>) => void
  getLatestTaskByProject: (projectPath: string) => OutlineGenerationTask | null
  removeTask: (taskId: string) => void
}

/** Monotonic sequence counter for task ID generation. */
let outlineSeq = 0

/**
 * Zustand store for outline generation tasks. Tasks are prepended so the
 * most recent task appears first. The `panelOpen` flag controls the UI
 * visibility of the outline generation side panel.
 */
export const useOutlineGenerationStore = create<OutlineGenerationState>((set) => ({
  tasks: [],
  panelOpen: false,

  setPanelOpen: (visible) => set({ panelOpen: visible }),

  createTask: (input) => {
    const taskId = `outline-task-${++outlineSeq}`
    const now = Date.now()
    const task: OutlineGenerationTask = {
      id: taskId,
      projectPath: input.projectPath,
      kind: input.kind ?? "outline",
      genre: input.genre ?? "",
      scale: input.scale ?? "",
      premise: input.premise ?? "",
      prompt: input.prompt ?? "",
      userRequest: input.userRequest ?? "",
      selectedSectionKey: input.selectedSectionKey ?? null,
      displayTitle: input.displayTitle ?? null,
      writeMode: input.writeMode ?? null,
      targetPath: input.targetPath ?? null,
      outlinePath: input.outlinePath ?? null,
      status: input.status ?? "generating",
      message: input.message ?? "",
      error: input.error ?? null,
      createdAt: now,
      updatedAt: now,
    }
    set((prev) => ({ tasks: [task, ...prev.tasks] }))
    return taskId
  },

  updateTask: (taskId, patch) =>
    set((prev) => ({
      tasks: prev.tasks.map((t) =>
        t.id === taskId ? { ...t, ...patch, updatedAt: Date.now() } : t
      ),
    })),

  getLatestTaskByProject: (projectPath): OutlineGenerationTask | null => {
    const matches = useOutlineGenerationStore
      .getState()
      .tasks.filter((t: OutlineGenerationTask) => t.projectPath === projectPath)
      .sort((a: OutlineGenerationTask, b: OutlineGenerationTask) => b.updatedAt - a.updatedAt)
    return matches[0] ?? null
  },

  removeTask: (taskId) =>
    set((prev) => ({
      tasks: prev.tasks.filter((t) => t.id !== taskId),
    })),
}))
