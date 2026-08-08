// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Studio Contributors
// Activity tracking store for background operations (ingest, lint, query).

import { create } from "zustand"

/**
 * Describes a single tracked activity with lifecycle metadata.
 * Each activity progresses through running → done | error states.
 */
export interface ActivityItem {
  id: string
  type: "ingest" | "lint" | "query"
  title: string
  status: "running" | "done" | "error"
  detail: string
  filesWritten: string[]
  createdAt: number
}

/** Shape of the activity store state and actions. */
interface ActivityState {
  items: ActivityItem[]
  addItem: (item: Omit<ActivityItem, "id" | "createdAt">) => string
  updateItem: (id: string, updates: Partial<Pick<ActivityItem, "status" | "detail" | "filesWritten">>) => void
  appendDetail: (id: string, text: string) => void
  clearDone: () => void
}

/** Module-level monotonic counter for generating unique activity identifiers. */
let seqCounter = 0

/**
 * Zustand store that tracks background activities (file ingestion, linting,
 * search queries). New items are prepended so the most recent activity
 * appears first in the list.
 */
export const useActivityStore = create<ActivityState>((set) => ({
  items: [],

  addItem: (partial) => {
    const generatedId = `activity-${++seqCounter}`
    const timestamp = Date.now()
    set((prev) => ({
      items: [
        { ...partial, id: generatedId, createdAt: timestamp },
        ...prev.items,
      ],
    }))
    return generatedId
  },

  updateItem: (targetId, patch) =>
    set((prev) => ({
      items: prev.items.map((entry) =>
        entry.id === targetId ? { ...entry, ...patch } : entry
      ),
    })),

  appendDetail: (targetId, fragment) =>
    set((prev) => ({
      items: prev.items.map((entry) =>
        entry.id === targetId
          ? { ...entry, detail: entry.detail + fragment }
          : entry
      ),
    })),

  clearDone: () =>
    set((prev) => ({
      items: prev.items.filter((entry) => entry.status === "running"),
    })),
}))
