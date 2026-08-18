/**
 * Wave 1 用户记忆系统 — 项目会话层单例
 *
 * 文件为真源、缓存为工作副本（keyed by projectPath）。
 * 提供同步 getter（供 review-view useMemo）+ 异步加载/保存（single-flight + 写串行化）
 * + 四个 command 闭环薄封装（list/add/update/delete）。
 */

import type { UserMemoryStore, UserPreference, PreferenceCategory } from "./types"
import { createDefaultStore } from "./types"
import {
  loadUserMemory,
  saveUserMemory,
  addPreference,
  updatePreference,
  deletePreference,
  getPreferences,
  getDefaultUserMemoryPath,
} from "./store"

// ── 单例状态 ──

interface CacheEntry {
  projectPath: string
  store: UserMemoryStore
}

let cache: CacheEntry | null = null
let loadChain: Promise<UserMemoryStore> | null = null
let writeChain: Promise<void> = Promise.resolve()

/** 同步读缓存；未加载或项目不匹配返回 null */
export function getUserMemoryStore(projectPath: string): UserMemoryStore | null {
  if (cache && cache.projectPath === projectPath) return cache.store
  return null
}

/** 加载 + 缓存（single-flight：并发调用只读一次盘） */
export async function loadUserMemoryForProject(projectPath: string): Promise<UserMemoryStore> {
  if (cache && cache.projectPath === projectPath) return cache.store
  if (loadChain) return loadChain
  loadChain = (async () => {
    const filePath = getDefaultUserMemoryPath(projectPath)
    const store = await loadUserMemory(filePath)
    cache = { projectPath, store }
    return store
  })().finally(() => {
    loadChain = null
  })
  return loadChain
}

/** 保存（串行写链，防交错写）+ 更新缓存 */
export async function saveUserMemoryForProject(projectPath: string, store: UserMemoryStore): Promise<void> {
  const filePath = getDefaultUserMemoryPath(projectPath)
  const task = writeChain.then(() => saveUserMemory(filePath, store))
  writeChain = task.catch(() => {})
  await task
  cache = { projectPath, store }
}

/** 测试/切项目用：清空缓存 */
export function invalidateUserMemoryCache(): void {
  cache = null
  loadChain = null
  writeChain = Promise.resolve()
}

// ── command 闭环薄封装（load → CRUD → save 串行链）──

/** 列出某项目全部偏好（按分类过滤可选） */
export async function listPreferences(
  projectPath: string,
  category?: PreferenceCategory,
): Promise<UserPreference[]> {
  const store = await loadUserMemoryForProject(projectPath)
  return getPreferences(store, category)
}

/** 新增偏好并落盘 */
export async function addPreferenceForProject(
  projectPath: string,
  fields: Pick<UserPreference, "key" | "value" | "category"> & Partial<Pick<UserPreference, "label">>,
): Promise<UserPreference> {
  const store = await loadUserMemoryForProject(projectPath)
  const pref = addPreference(store, fields)
  await saveUserMemoryForProject(projectPath, store)
  return pref
}

/** 更新偏好并落盘；未找到返回 null */
export async function updatePreferenceForProject(
  projectPath: string,
  id: string,
  updates: Partial<Pick<UserPreference, "key" | "value" | "category" | "label">>,
): Promise<UserPreference | null> {
  const store = await loadUserMemoryForProject(projectPath)
  const updated = updatePreference(store, id, updates)
  if (updated) await saveUserMemoryForProject(projectPath, store)
  return updated
}

/** 删除偏好并落盘；成功返回 true */
export async function deletePreferenceForProject(projectPath: string, id: string): Promise<boolean> {
  const store = await loadUserMemoryForProject(projectPath)
  const removed = deletePreference(store, id)
  if (removed) await saveUserMemoryForProject(projectPath, store)
  return removed
}

/** 确保项目存在 user-memory 文件（首次进入时初始化） */
export async function ensureUserMemoryFile(projectPath: string): Promise<UserMemoryStore> {
  const store = await loadUserMemoryForProject(projectPath)
  if (store.preferences.length === 0 && Object.keys(store.deAiWeights.categoryBoosts).length === 0) {
    // 空 store 也落盘一次，建立文件
    await saveUserMemoryForProject(projectPath, store)
  }
  return store
}

/** 测试辅助：构造默认 store（不落盘） */
export function createTestStore(): UserMemoryStore {
  return createDefaultStore()
}
