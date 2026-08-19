import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  getUserMemoryStore,
  loadUserMemoryForProject,
  saveUserMemoryForProject,
  invalidateUserMemoryCache,
  listPreferences,
  addPreferenceForProject,
  updatePreferenceForProject,
  deletePreferenceForProject,
  ensureUserMemoryFile,
  createTestStore,
} from "./session"
import { createDefaultStore, createPreference } from "./types"
import type { UserMemoryStore } from "./types"

// Mock fs module（store.ts 依赖）
vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  writeFileAtomic: vi.fn(),
}))

import { readFile, writeFileAtomic } from "@/commands/fs"

const P = "/proj/a"

function mockFileStore(store: UserMemoryStore): void {
  vi.mocked(readFile).mockResolvedValue(JSON.stringify(store))
}

beforeEach(() => {
  invalidateUserMemoryCache()
  vi.clearAllMocks()
  vi.mocked(readFile).mockResolvedValue(JSON.stringify(createDefaultStore()))
  vi.mocked(writeFileAtomic).mockResolvedValue(undefined)
})

describe("session 单例", () => {
  it("createTestStore 返回默认 store（不落盘）", () => {
    const store = createTestStore()
    expect(store.preferences).toEqual([])
    expect(store.version).toBe("user-memory/1.0")
  })

  it("getUserMemoryStore 未加载时返回 null", () => {
    expect(getUserMemoryStore(P)).toBeNull()
  })

  it("loadUserMemoryForProject 加载并缓存；再次调用命中缓存不读盘", async () => {
    const store = createDefaultStore()
    mockFileStore(store)
    const s1 = await loadUserMemoryForProject(P)
    expect(s1).toStrictEqual(store)
    expect(readFile).toHaveBeenCalledTimes(1)
    const s2 = await loadUserMemoryForProject(P)
    expect(s2).toStrictEqual(store)
    expect(readFile).toHaveBeenCalledTimes(1)
    expect(getUserMemoryStore(P)).toStrictEqual(store)
  })

  it("切项目自动 miss（keyed by projectPath）", async () => {
    const a = createDefaultStore()
    const b = createDefaultStore()
    mockFileStore(a)
    await loadUserMemoryForProject(P)
    mockFileStore(b)
    const s2 = await loadUserMemoryForProject("/proj/b")
    expect(s2).toStrictEqual(b)
    expect(readFile).toHaveBeenCalledTimes(2)
  })

  it("single-flight：并发 load 只读一次盘", async () => {
    const store = createDefaultStore()
    mockFileStore(store)
    const [s1, s2] = await Promise.all([
      loadUserMemoryForProject(P),
      loadUserMemoryForProject(P),
    ])
    expect(s1).toStrictEqual(store)
    expect(s2).toStrictEqual(store)
    expect(readFile).toHaveBeenCalledTimes(1)
  })

  it("saveUserMemoryForProject 落盘并更新缓存", async () => {
    const store = createDefaultStore()
    mockFileStore(store)
    await loadUserMemoryForProject(P)
    await saveUserMemoryForProject(P, store)
    expect(writeFileAtomic).toHaveBeenCalledTimes(1)
    expect(getUserMemoryStore(P)).toStrictEqual(store)
  })

  it("invalidateUserMemoryCache 清空缓存", async () => {
    const store = createDefaultStore()
    mockFileStore(store)
    await loadUserMemoryForProject(P)
    invalidateUserMemoryCache()
    expect(getUserMemoryStore(P)).toBeNull()
  })
})

describe("command 闭环薄封装", () => {
  it("listPreferences 返回偏好列表（可按分类过滤）", async () => {
    const store = createDefaultStore()
    store.preferences.push({
      id: "p1", key: "dim:plot", value: "0.3", category: "review", createdAt: "", updatedAt: "",
    })
    store.preferences.push({
      id: "p2", key: "avoid_words", value: "仿佛", category: "vocabulary", createdAt: "", updatedAt: "",
    })
    mockFileStore(store)
    const all = await listPreferences(P)
    expect(all).toHaveLength(2)
    const review = await listPreferences(P, "review")
    expect(review).toHaveLength(1)
    expect(review[0]!.key).toBe("dim:plot")
  })

  it("addPreferenceForProject 新增并落盘", async () => {
    const store = createDefaultStore()
    mockFileStore(store)
    const pref = await addPreferenceForProject(P, { key: "dim:facts", value: "0.4", category: "review" })
    expect(pref.id).toBeTruthy()
    expect(writeFileAtomic).toHaveBeenCalledTimes(1)
    const saved = JSON.parse(vi.mocked(writeFileAtomic).mock.calls[0]![1] as string)
    expect(saved.preferences).toHaveLength(1)
    expect(saved.preferences[0]!.key).toBe("dim:facts")
  })

  it("updatePreferenceForProject 更新并落盘；未找到返回 null 不落盘", async () => {
    const store = createDefaultStore()
    store.preferences.push({
      id: "p1", key: "dim:plot", value: "0.3", category: "review", createdAt: "", updatedAt: "",
    })
    mockFileStore(store)
    const updated = await updatePreferenceForProject(P, "p1", { value: "0.5" })
    expect(updated?.value).toBe("0.5")
    expect(writeFileAtomic).toHaveBeenCalledTimes(1)
    const missing = await updatePreferenceForProject(P, "nope", { value: "0.5" })
    expect(missing).toBeNull()
    expect(writeFileAtomic).toHaveBeenCalledTimes(1)
  })

  it("deletePreferenceForProject 删除并落盘；未找到返回 false 不落盘", async () => {
    const store = createDefaultStore()
    store.preferences.push({
      id: "p1", key: "dim:plot", value: "0.3", category: "review", createdAt: "", updatedAt: "",
    })
    mockFileStore(store)
    const removed = await deletePreferenceForProject(P, "p1")
    expect(removed).toBe(true)
    expect(writeFileAtomic).toHaveBeenCalledTimes(1)
    const missing = await deletePreferenceForProject(P, "nope")
    expect(missing).toBe(false)
    expect(writeFileAtomic).toHaveBeenCalledTimes(1)
  })

  it("ensureUserMemoryFile 空 store 时建立文件", async () => {
    const store = createDefaultStore()
    mockFileStore(store)
    const s = await ensureUserMemoryFile(P)
    expect(s.version).toBe("user-memory/1.0")
    expect(s.preferences).toEqual([])
    expect(writeFileAtomic).toHaveBeenCalledTimes(1)
  })

  it("ensureUserMemoryFile 非空 store 不重复落盘", async () => {
    const store = createDefaultStore()
    store.preferences.push(createPreference({ key: "k", value: "v", category: "custom" }))
    mockFileStore(store)
    const s = await ensureUserMemoryFile(P)
    expect(s.preferences).toHaveLength(1)
    expect(writeFileAtomic).not.toHaveBeenCalled()
  })

  it("saveUserMemoryForProject 写失败后写链可恢复（catch 链）", async () => {
    vi.mocked(writeFileAtomic).mockRejectedValueOnce(new Error("disk full"))
    await expect(saveUserMemoryForProject(P, createDefaultStore())).rejects.toThrow("disk full")
    // 第二次保存成功 → writeChain 已恢复
    await saveUserMemoryForProject(P, createDefaultStore())
    expect(writeFileAtomic).toHaveBeenCalledTimes(2)
  })
})
