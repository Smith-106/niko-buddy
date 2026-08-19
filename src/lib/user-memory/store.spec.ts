import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  addPreference,
  updatePreference,
  deletePreference,
  getPreferences,
  findPreferenceByKey,
  getUserPreferenceText,
  loadUserMemory,
  saveUserMemory,
  getDefaultUserMemoryPath,
} from "./store"
import { createDefaultStore, createPreference } from "./types"
import type { UserMemoryStore } from "./types"

// Mock fs module
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  writeFileAtomic: vi.fn(),
}))

import { readFile, writeFile, writeFileAtomic } from "@/commands/fs"

function makeStore(prefs = 0): UserMemoryStore {
  const store = createDefaultStore()
  for (let i = 0; i < prefs; i++) {
    store.preferences.push(
      createPreference({ key: `key_${i}`, value: `val_${i}`, category: "custom" }),
    )
  }
  return store
}

describe("user-memory/store — CRUD", () => {
  describe("addPreference", () => {
    it("adds a preference to the store", () => {
      const store = makeStore()
      const pref = addPreference(store, { key: "test_key", value: "test_val", category: "vocabulary" })
      expect(pref.id).toMatch(/^upref-/)
      expect(pref.key).toBe("test_key")
      expect(pref.value).toBe("test_val")
      expect(pref.category).toBe("vocabulary")
      expect(store.preferences).toHaveLength(1)
      expect(store.preferences[0]).toBe(pref)
    })

    it("adds with label", () => {
      const store = makeStore()
      const pref = addPreference(store, { key: "k", value: "v", category: "custom", label: "我的偏好" })
      expect(pref.label).toBe("我的偏好")
    })

    it("generates unique ids", () => {
      const store = makeStore()
      const p1 = addPreference(store, { key: "a", value: "1", category: "custom" })
      const p2 = addPreference(store, { key: "b", value: "2", category: "custom" })
      expect(p1.id).not.toBe(p2.id)
    })
  })

  describe("updatePreference", () => {
    it("updates existing preference fields", () => {
      const store = makeStore()
      const pref = addPreference(store, { key: "old_key", value: "old_val", category: "vocabulary" })
      const updated = updatePreference(store, pref.id, { key: "new_key", value: "new_val" })
      expect(updated).not.toBeNull()
      expect(updated!.key).toBe("new_key")
      expect(updated!.value).toBe("new_val")
      expect(updated!.category).toBe("vocabulary") // unchanged
    })

    it("updates category and label", () => {
      const store = makeStore()
      const pref = addPreference(store, { key: "k", value: "v", category: "custom" })
      const updated = updatePreference(store, pref.id, { category: "style", label: "风格" })
      expect(updated!.category).toBe("style")
      expect(updated!.label).toBe("风格")
    })

    it("updates updatedAt timestamp", () => {
      const store = makeStore()
      const pref = addPreference(store, { key: "k", value: "v", category: "custom" })
      // updatedAt is set to new Date().toISOString() on update, so it should be >= createdAt
      const updated = updatePreference(store, pref.id, { value: "v2" })
      expect(updated!.updatedAt >= pref.createdAt).toBe(true)
    })

    it("returns null for missing id", () => {
      const store = makeStore()
      const result = updatePreference(store, "nonexistent", { key: "x" })
      expect(result).toBeNull()
    })

    it("partial update — only value changes", () => {
      const store = makeStore()
      const pref = addPreference(store, { key: "k", value: "v", category: "custom", label: "L" })
      const updated = updatePreference(store, pref.id, { value: "v2" })
      expect(updated!.key).toBe("k")
      expect(updated!.value).toBe("v2")
      expect(updated!.category).toBe("custom")
      expect(updated!.label).toBe("L")
    })

    it("partial update — only key changes", () => {
      const store = makeStore()
      const pref = addPreference(store, { key: "k", value: "v", category: "custom" })
      const updated = updatePreference(store, pref.id, { key: "k2" })
      expect(updated!.key).toBe("k2")
      expect(updated!.value).toBe("v")
    })
  })

  describe("deletePreference", () => {
    it("deletes existing preference", () => {
      const store = makeStore()
      const pref = addPreference(store, { key: "k", value: "v", category: "custom" })
      expect(store.preferences).toHaveLength(1)
      const result = deletePreference(store, pref.id)
      expect(result).toBe(true)
      expect(store.preferences).toHaveLength(0)
    })

    it("returns false for missing id", () => {
      const store = makeStore()
      const result = deletePreference(store, "nonexistent")
      expect(result).toBe(false)
    })

    it("deletes correct item when multiple exist", () => {
      const store = makeStore()
      const p1 = addPreference(store, { key: "a", value: "1", category: "custom" })
      const p2 = addPreference(store, { key: "b", value: "2", category: "custom" })
      deletePreference(store, p1.id)
      expect(store.preferences).toHaveLength(1)
      expect(store.preferences[0]!.id).toBe(p2.id)
    })
  })

  describe("getPreferences", () => {
    it("returns all preferences when no category filter", () => {
      const store = makeStore()
      addPreference(store, { key: "a", value: "1", category: "vocabulary" })
      addPreference(store, { key: "b", value: "2", category: "style" })
      expect(getPreferences(store)).toHaveLength(2)
    })

    it("filters by category", () => {
      const store = makeStore()
      addPreference(store, { key: "a", value: "1", category: "vocabulary" })
      addPreference(store, { key: "b", value: "2", category: "style" })
      expect(getPreferences(store, "vocabulary")).toHaveLength(1)
      expect(getPreferences(store, "vocabulary")[0]!.key).toBe("a")
    })

    it("returns empty array for empty store", () => {
      const store = makeStore()
      expect(getPreferences(store)).toEqual([])
    })

    it("returns empty array for category with no matches", () => {
      const store = makeStore()
      addPreference(store, { key: "a", value: "1", category: "vocabulary" })
      expect(getPreferences(store, "review")).toEqual([])
    })

    it("returns a copy, not the internal array", () => {
      const store = makeStore()
      addPreference(store, { key: "a", value: "1", category: "custom" })
      const result = getPreferences(store)
      result.push(createPreference({ key: "b", value: "2", category: "custom" }))
      expect(store.preferences).toHaveLength(1)
    })
  })

  describe("findPreferenceByKey", () => {
    it("finds by key", () => {
      const store = makeStore()
      addPreference(store, { key: "target", value: "v", category: "custom" })
      const found = findPreferenceByKey(store, "target")
      expect(found).toBeDefined()
      expect(found!.value).toBe("v")
    })

    it("returns undefined for missing key", () => {
      const store = makeStore()
      expect(findPreferenceByKey(store, "missing")).toBeUndefined()
    })

    it("returns first match when duplicates exist", () => {
      const store = makeStore()
      const p1 = addPreference(store, { key: "dup", value: "first", category: "custom" })
      addPreference(store, { key: "dup", value: "second", category: "custom" })
      const found = findPreferenceByKey(store, "dup")
      expect(found!.id).toBe(p1.id)
    })
  })
})

describe("user-memory/store — file IO", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe("loadUserMemory", () => {
    it("loads a valid store from file", async () => {
      const store = makeStore(2)
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(store))

      const loaded = await loadUserMemory("/test/user-memory.json")
      expect(loaded.preferences).toHaveLength(2)
      expect(loaded.version).toBe("user-memory/1.0")
    })

    it("returns default store when file not found", async () => {
      vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"))

      const loaded = await loadUserMemory("/test/user-memory.json")
      expect(loaded.preferences).toEqual([])
      expect(loaded.version).toBe("user-memory/1.0")
    })

    it("returns default store when JSON is invalid", async () => {
      vi.mocked(readFile).mockResolvedValue("not json")

      const loaded = await loadUserMemory("/test/user-memory.json")
      expect(loaded.preferences).toEqual([])
    })

    it("returns default store when parsed value is null", async () => {
      vi.mocked(readFile).mockResolvedValue("null")

      const loaded = await loadUserMemory("/test/user-memory.json")
      expect(loaded.preferences).toEqual([])
    })

    it("fills missing fields for backward compatibility", async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({
        version: "user-memory/1.0",
        preferences: [],
        // missing deAiWeights and reviewCalibration
      }))

      const loaded = await loadUserMemory("/test/user-memory.json")
      expect(loaded.deAiWeights).toEqual({
        categoryBoosts: {},
        severityThreshold: "medium",
        genreOverrides: {},
      })
      expect(loaded.reviewCalibration).toEqual({
        dimensionWeights: {},
        severityDeductions: {},
      })
    })

    it("fills missing updatedAt", async () => {
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({
        version: "user-memory/1.0",
        preferences: [],
      }))

      const loaded = await loadUserMemory("/test/user-memory.json")
      expect(loaded.updatedAt).toBeTruthy()
    })
  })

  describe("saveUserMemory", () => {
    it("saves store with updated timestamp via atomic write", async () => {
      const store = makeStore(1)

      await saveUserMemory("/test/user-memory.json", store)
      expect(vi.mocked(writeFileAtomic)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(writeFile)).not.toHaveBeenCalled()
      // updatedAt should be a valid ISO timestamp
      expect(store.updatedAt).toBeTruthy()
      expect(new Date(store.updatedAt).getTime()).toBeGreaterThan(0)

      const savedJson = vi.mocked(writeFileAtomic).mock.calls[0]![1]
      const parsed = JSON.parse(savedJson as string)
      expect(parsed.version).toBe("user-memory/1.0")
      expect(parsed.preferences).toHaveLength(1)
    })
  })

  describe("getUserPreferenceText", () => {
    it("renders preferences as human-readable text with label", () => {
      const store = createDefaultStore()
      store.preferences.push(
        createPreference({ key: "avoid_words", value: "仿佛、不禁", category: "vocabulary", label: "避用词" }),
      )
      expect(getUserPreferenceText(store, "vocabulary")).toBe("避用词: 仿佛、不禁")
    })

    it("falls back to key when label missing", () => {
      const store = createDefaultStore()
      store.preferences.push(
        createPreference({ key: "dim:plot", value: "0.3", category: "review" }),
      )
      expect(getUserPreferenceText(store, "review")).toBe("dim:plot: 0.3")
    })

    it("joins multiple preferences with semicolons", () => {
      const store = createDefaultStore()
      store.preferences.push(
        createPreference({ key: "a", value: "1", category: "custom" }),
        createPreference({ key: "b", value: "2", category: "custom" }),
      )
      expect(getUserPreferenceText(store)).toBe("a: 1；b: 2")
    })

    it("returns empty string when no preferences", () => {
      expect(getUserPreferenceText(createDefaultStore(), "vocabulary")).toBe("")
    })
  })

  describe("getDefaultUserMemoryPath", () => {
    it("returns .novel/user-memory.json under project path", () => {
      expect(getDefaultUserMemoryPath("/my/project")).toBe("/my/project/.novel/user-memory.json")
    })
  })
})