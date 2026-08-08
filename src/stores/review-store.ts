// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Niko Studio Contributors
// Review centre store for contradiction, duplicate, suggestion items and novel review entries.

import { create } from "zustand"
import { normalizeReviewTitle } from "@/lib/review-utils"
import type { NovelReviewResult } from "@/lib/novel/review-adapter"

/**
 * A persisted review entry tied to a specific chapter number.
 * Created by the novel review pipeline and displayed in the review centre.
 */
export interface NovelReviewEntry {
  id: string
  chapterNumber: number
  results: NovelReviewResult[]
  createdAt: string
  resolved: boolean
}

/** Action option shown on a review item (e.g. "Accept", "Dismiss"). */
export interface ReviewOption {
  label: string
  action: string // identifier for the action
}

/**
 * A single actionable review item surfaced by the ingestion or lint
 * pipeline. Items remain visible until explicitly resolved or dismissed.
 */
export interface ReviewItem {
  id: string
  type: "contradiction" | "duplicate" | "missing-page" | "confirm" | "suggestion"
  title: string
  description: string
  sourcePath?: string
  affectedPages?: string[]
  searchQueries?: string[]
  options: ReviewOption[]
  resolved: boolean
  resolvedAction?: string
  createdAt: number
}

/** Internal state shape for the review store. */
interface ReviewState {
  items: ReviewItem[]
  addItem: (item: Omit<ReviewItem, "id" | "resolved" | "createdAt">) => void
  addItems: (items: Omit<ReviewItem, "id" | "resolved" | "createdAt">[]) => void
  setItems: (items: ReviewItem[]) => void
  resolveItem: (id: string, action: string) => void
  dismissItem: (id: string) => void
  clearResolved: () => void
  novelReviewEntries: NovelReviewEntry[]
  addNovelReviewEntry: (entry: NovelReviewEntry) => void
  dismissNovelReviewEntry: (id: string) => void
  clearNovelReviewEntries: () => void
}

/** Counter for minting unique review item identifiers. */
let reviewSeq = 0

/**
 * Builds a de-duplication key from an item's type and normalised title.
 * Used by `addItems` to merge overlapping contradictions/confirmations
 * that can surface from multiple ingested files.
 */
function dedupeKey(type: string, title: string): string {
  return `${type}::${normalizeReviewTitle(title)}`
}

/**
 * Zustand store powering the Review Centre panel. Manages two
 * independent collections: ad-hoc `ReviewItem`s (contradictions,
 * suggestions, etc.) and structured `NovelReviewEntry` results
 * from the chapter review pipeline.
 */
export const useReviewStore = create<ReviewState>((set) => ({
  items: [],
  novelReviewEntries: [],

  addNovelReviewEntry: (entry) =>
    set((prev) => ({
      novelReviewEntries: [...prev.novelReviewEntries, entry],
    })),

  dismissNovelReviewEntry: (entryId) =>
    set((prev) => ({
      novelReviewEntries: prev.novelReviewEntries.map((e) =>
        e.id === entryId ? { ...e, resolved: true } : e
      ),
    })),

  clearNovelReviewEntries: () => set({ novelReviewEntries: [] }),

  addItem: (partial) =>
    set((prev) => ({
      items: [
        ...prev.items,
        {
          ...partial,
          id: `review-${++reviewSeq}`,
          resolved: false,
          createdAt: Date.now(),
        },
      ],
    })),

  addItems: (incoming) =>
    set((prev) => {
      const merged = [...prev.items]

      // Build an index of unresolved items for O(1) duplicate detection.
      const pendingIndex = new Map<string, number>()
      merged.forEach((existing, idx) => {
        if (!existing.resolved) {
          pendingIndex.set(dedupeKey(existing.type, existing.title), idx)
        }
      })

      for (const partial of incoming) {
        const key = dedupeKey(partial.type, partial.title)
        const hitIdx = pendingIndex.get(key)

        if (hitIdx !== undefined) {
          // Merge affected pages, search queries and source into the existing entry.
          const existing = merged[hitIdx]
          const combinedPages = Array.from(
            new Set([...(existing.affectedPages ?? []), ...(partial.affectedPages ?? [])])
          )
          const combinedQueries = Array.from(
            new Set([...(existing.searchQueries ?? []), ...(partial.searchQueries ?? [])])
          )
          merged[hitIdx] = {
            ...existing,
            description: partial.description || existing.description,
            sourcePath: partial.sourcePath ?? existing.sourcePath,
            affectedPages: combinedPages.length > 0 ? combinedPages : undefined,
            searchQueries: combinedQueries.length > 0 ? combinedQueries : undefined,
          }
        } else {
          const newItem: ReviewItem = {
            ...partial,
            id: `review-${++reviewSeq}`,
            resolved: false,
            createdAt: Date.now(),
          }
          merged.push(newItem)
          pendingIndex.set(key, merged.length - 1)
        }
      }

      return { items: merged }
    }),

  setItems: (items) => set({ items }),

  resolveItem: (targetId, action) =>
    set((prev) => ({
      items: prev.items.map((item) =>
        item.id === targetId ? { ...item, resolved: true, resolvedAction: action } : item
      ),
    })),

  dismissItem: (targetId) =>
    set((prev) => ({
      items: prev.items.filter((item) => item.id !== targetId),
    })),

  clearResolved: () =>
    set((prev) => ({
      items: prev.items.filter((item) => !item.resolved),
    })),
}))
