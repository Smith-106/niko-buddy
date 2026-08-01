// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Studio Contributors
// Book analysis task lifecycle store — manages ingestion, character extraction and recognition.

import { create } from "zustand"
import type {
  BookAnalysisTask,
  BookAnalysisConfig,
  BookAnalysisProgress,
  BookAnalysisMetadata,
  BookAnalysisResult,
  ExtractedCharacter,
  CharacterSkill,
  RecognizedCharacter,
  BookStyleProfile,
} from "@/lib/novel/book-analysis/types"
import { normalizePath } from "@/lib/path-utils"

type BookAnalysisChapterSummary = NonNullable<BookAnalysisTask["chapters"]>[number]

/** Full state surface for the book analysis feature. */
export interface BookAnalysisState {
  tasks: BookAnalysisTask[]
  currentTaskId: string | null
  selectedResultPath: string | null
  currentResult: BookAnalysisResult | null
  showResultViewer: boolean

  // Character recognition state (feature/character-recognition-and-simple-mode)
  recognitionStatus: "idle" | "heuristic" | "llm_scoring" | "llm_recognizing" | "done" | "error"
  recognizedCharacters: RecognizedCharacter[]
  selectedCharacterIds: string[]
  recognitionError?: string

  // Task lifecycle
  startTask: (projectPath: string, config: BookAnalysisConfig, abortController?: AbortController) => string
  updateTaskBookData: (taskId: string, bookId: string, chapters: BookAnalysisChapterSummary[], bookPath?: string) => void
  updateTaskProgress: (taskId: string, progress: Partial<BookAnalysisProgress>) => void
  updateTaskMetadata: (taskId: string, metadata: BookAnalysisMetadata) => void
  updateTaskCharacters: (taskId: string, characters: ExtractedCharacter[]) => void
  updateTaskSkills: (taskId: string, skills: CharacterSkill[]) => void
  updateTaskStyleProfile: (taskId: string, styleProfile: BookStyleProfile) => void
  pauseTask: (taskId: string) => void
  resumeTask: (taskId: string) => void
  cancelTask: (taskId: string) => void
  completeTask: (taskId: string) => void
  errorTask: (taskId: string, error: string) => void
  removeTask: (taskId: string) => void

  // Result viewer
  setSelectedResult: (projectPath: string | null) => void
  setCurrentResult: (result: BookAnalysisResult | null) => void
  setShowResultViewer: (show: boolean) => void

  // Sidebar book selection
  selectedLibraryBookId: string | null
  setSelectedLibraryBookId: (id: string | null) => void

  // Sidebar refresh trigger
  sidebarRefreshCounter: number
  triggerSidebarRefresh: () => void

  // Recognition completion pending signal
  pendingRecognitionTaskId: string | null
  requestReopenChapterSelection: (taskId: string) => void
  consumeReopenRequest: () => string | null

  // Character recognition actions
  setRecognitionStatus: (status: "idle" | "heuristic" | "llm_scoring" | "llm_recognizing" | "done" | "error") => void
  setRecognizedCharacters: (characters: RecognizedCharacter[]) => void
  setSelectedCharacterIds: (ids: string[]) => void
  setRecognitionError: (error?: string) => void
  clearRecognition: () => void

  // Query helpers
  getTask: (taskId: string) => BookAnalysisTask | null
  getTaskByProject: (projectPath: string) => BookAnalysisTask | null
  getCurrentTask: () => BookAnalysisTask | null
}

/** Counter for unique task identifiers. */
let analysisSeq = 0

/**
 * Applies a patch to the task matching `taskId`, updating its
 * `updatedAt` timestamp. Returns the original state if no match.
 */
function patchTask(
  tasks: BookAnalysisTask[],
  taskId: string,
  patch: Partial<BookAnalysisTask>,
): BookAnalysisTask[] {
  return tasks.map((t) =>
    t.id === taskId ? { ...t, ...patch, updatedAt: Date.now() } : t
  )
}

/** Clears `currentTaskId` when it equals the given id, otherwise leaves it unchanged. */
function clearIfCurrent(currentTaskId: string | null, taskId: string): string | null {
  return currentTaskId === taskId ? null : currentTaskId
}

/**
 * Zustand store managing the full book analysis lifecycle: file reading,
 * chapter extraction, character/skill recognition, style profiling, and
 * result viewer state. Supports concurrent tasks across multiple projects.
 */
export const useBookAnalysisStore = create<BookAnalysisState>((set, get) => ({
  tasks: [],
  currentTaskId: null,
  selectedResultPath: null,
  currentResult: null,
  showResultViewer: false,

  selectedLibraryBookId: null,
  sidebarRefreshCounter: 0,

  recognitionStatus: "idle",
  recognizedCharacters: [],
  selectedCharacterIds: [],
  recognitionError: undefined,

  pendingRecognitionTaskId: null,

  startTask: (projectPath, config, abortController) => {
    const now = Date.now()
    const taskId = `book-analysis-${++analysisSeq}-${now}`
    const normalizedPath = normalizePath(projectPath)
    const bookId = `book-${now}`

    const task: BookAnalysisTask = {
      id: taskId,
      projectPath: normalizedPath,
      bookId,
      config,
      progress: {
        stage: "reading_file",
        stageLabel: "读取文件中",
        completed: 0,
        total: 100,
        percentage: 0,
      },
      status: "running",
      startedAt: now,
      updatedAt: now,
      abortController,
      chapters: [],
      characters: [],
      skills: [],
    }

    set((prev) => ({
      tasks: [task, ...prev.tasks],
      currentTaskId: taskId,
    }))
    return taskId
  },

  updateTaskBookData: (taskId, bookId, chapters, bookPath) => {
    const extra = bookPath ? { bookPath } : {}
    set((prev) => ({
      tasks: patchTask(prev.tasks, taskId, { bookId, chapters, ...extra }),
    }))
  },

  updateTaskProgress: (taskId, progressPatch) =>
    set((prev) => ({
      tasks: prev.tasks.map((t) =>
        t.id === taskId
          ? { ...t, progress: { ...t.progress, ...progressPatch }, updatedAt: Date.now() }
          : t
      ),
    })),

  updateTaskMetadata: (taskId, metadata) =>
    set((prev) => ({ tasks: patchTask(prev.tasks, taskId, { metadata }) })),

  updateTaskCharacters: (taskId, characters) =>
    set((prev) => ({ tasks: patchTask(prev.tasks, taskId, { characters }) })),

  updateTaskSkills: (taskId, skills) =>
    set((prev) => ({ tasks: patchTask(prev.tasks, taskId, { skills }) })),

  updateTaskStyleProfile: (taskId, styleProfile) =>
    set((prev) => ({ tasks: patchTask(prev.tasks, taskId, { styleProfile }) })),

  pauseTask: (taskId) =>
    set((prev) => ({ tasks: patchTask(prev.tasks, taskId, { status: "paused" }) })),

  resumeTask: (taskId) =>
    set((prev) => ({
      tasks: patchTask(prev.tasks, taskId, { status: "running" }),
      currentTaskId: taskId,
    })),

  cancelTask: (taskId) =>
    set((prev) => {
      const task = prev.tasks.find((t) => t.id === taskId)
      task?.abortController?.abort()
      return {
        tasks: prev.tasks.map((t) =>
          t.id === taskId
            ? { ...t, status: "error" as const, error: "用户取消分析", updatedAt: Date.now() }
            : t
        ),
        currentTaskId: clearIfCurrent(prev.currentTaskId, taskId),
      }
    }),

  completeTask: (taskId) => {
    const now = Date.now()
    set((prev) => ({
      tasks: prev.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              status: "completed",
              progress: { ...t.progress, stage: "completed", percentage: 100 },
              completedAt: now,
              updatedAt: now,
            }
          : t
      ),
      currentTaskId: clearIfCurrent(prev.currentTaskId, taskId),
    }))
  },

  errorTask: (taskId, error) =>
    set((prev) => ({
      tasks: prev.tasks.map((t) =>
        t.id === taskId
          ? { ...t, status: "error", error, progress: { ...t.progress, stage: "error" }, updatedAt: Date.now() }
          : t
      ),
      currentTaskId: clearIfCurrent(prev.currentTaskId, taskId),
    })),

  removeTask: (taskId) =>
    set((prev) => ({
      tasks: prev.tasks.filter((t) => t.id !== taskId),
      currentTaskId: clearIfCurrent(prev.currentTaskId, taskId),
    })),

  setSelectedResult: (projectPath) =>
    set({ selectedResultPath: projectPath ? normalizePath(projectPath) : null }),

  setCurrentResult: (result) => set({ currentResult: result }),
  setShowResultViewer: (visible) => set({ showResultViewer: visible }),

  setSelectedLibraryBookId: (bookId) => set({ selectedLibraryBookId: bookId }),
  triggerSidebarRefresh: () =>
    set((prev) => ({ sidebarRefreshCounter: prev.sidebarRefreshCounter + 1 })),

  requestReopenChapterSelection: (taskId) => set({ pendingRecognitionTaskId: taskId }),
  consumeReopenRequest: () => {
    const pending = get().pendingRecognitionTaskId
    set({ pendingRecognitionTaskId: null })
    return pending
  },

  setRecognitionStatus: (status) => set({ recognitionStatus: status }),
  setRecognizedCharacters: (characters) =>
    set({ recognizedCharacters: characters, recognitionStatus: "done" }),
  setSelectedCharacterIds: (ids) => set({ selectedCharacterIds: ids }),
  setRecognitionError: (error) => set({ recognitionError: error }),
  clearRecognition: () =>
    set({
      recognitionStatus: "idle",
      recognizedCharacters: [],
      selectedCharacterIds: [],
      recognitionError: undefined,
    }),

  getTask: (taskId) => get().tasks.find((t) => t.id === taskId) ?? null,

  getTaskByProject: (projectPath) => {
    const normalised = normalizePath(projectPath)
    const matches = get().tasks
      .filter((t) => t.projectPath === normalised)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return matches[0] ?? null
  },

  getCurrentTask: () => {
    const { currentTaskId, tasks } = get()
    return currentTaskId ? tasks.find((t) => t.id === currentTaskId) ?? null : null
  },
}))
