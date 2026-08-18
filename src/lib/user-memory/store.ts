/**
 * Wave 1 用户记忆系统 — 持久化层
 *
 * 独立 `user-memory.json` 读写（R1 风险缓解：不并入 status.json）。
 * 纯 CRUD + 文件 IO，不包含业务逻辑。
 */

import { readFile, writeFileAtomic } from "@/commands/fs"
import type { UserPreference, UserMemoryStore, PreferenceCategory } from "./types"
import { createDefaultStore } from "./types"

// ── 文件 IO ──

/** 从文件加载 UserMemoryStore；文件不存在或损坏时返回默认空 store */
export async function loadUserMemory(filePath: string): Promise<UserMemoryStore> {
  try {
    const raw = await readFile(filePath)
    const parsed = JSON.parse(raw) as UserMemoryStore
    // 基本结构校验：至少要有 version 和 preferences 数组
    if (!parsed || typeof parsed !== "object") {
      return createDefaultStore()
    }
    if (!Array.isArray(parsed.preferences)) {
      return createDefaultStore()
    }
    // 补齐缺失字段（向后兼容旧版本）
    return {
      version: parsed.version || "user-memory/1.0",
      preferences: parsed.preferences,
      deAiWeights: parsed.deAiWeights ?? { categoryBoosts: {}, severityThreshold: "medium", genreOverrides: {} },
      reviewCalibration: parsed.reviewCalibration ?? { dimensionWeights: {}, severityDeductions: {} },
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    }
  } catch {
    return createDefaultStore()
  }
}

/** 保存 UserMemoryStore 到文件（原子写，防断电半写） */
export async function saveUserMemory(filePath: string, store: UserMemoryStore): Promise<void> {
  store.updatedAt = new Date().toISOString()
  await writeFileAtomic(filePath, JSON.stringify(store, null, 2))
}

// ── CRUD ──

/** 添加偏好条目（纯函数，修改传入的 store 并返回新条目） */
export function addPreference(
  store: UserMemoryStore,
  fields: Pick<UserPreference, "key" | "value" | "category"> & Partial<Pick<UserPreference, "label">>,
): UserPreference {
  const now = new Date().toISOString()
  const id = `upref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const pref: UserPreference = {
    id,
    key: fields.key,
    value: fields.value,
    category: fields.category,
    label: fields.label,
    createdAt: now,
    updatedAt: now,
  }
  store.preferences.push(pref)
  return pref
}

/** 更新偏好条目；返回更新后的条目，未找到返回 null */
export function updatePreference(
  store: UserMemoryStore,
  id: string,
  updates: Partial<Pick<UserPreference, "key" | "value" | "category" | "label">>,
): UserPreference | null {
  const pref = store.preferences.find((p) => p.id === id)
  if (!pref) return null
  if (updates.key !== undefined) pref.key = updates.key
  if (updates.value !== undefined) pref.value = updates.value
  if (updates.category !== undefined) pref.category = updates.category
  if (updates.label !== undefined) pref.label = updates.label
  pref.updatedAt = new Date().toISOString()
  return pref
}

/** 删除偏好条目；成功返回 true，未找到返回 false */
export function deletePreference(store: UserMemoryStore, id: string): boolean {
  const idx = store.preferences.findIndex((p) => p.id === id)
  if (idx === -1) return false
  store.preferences.splice(idx, 1)
  return true
}

/** 查询偏好条目（可按分类过滤） */
export function getPreferences(
  store: UserMemoryStore,
  category?: PreferenceCategory,
): UserPreference[] {
  if (category === undefined) return [...store.preferences]
  return store.preferences.filter((p) => p.category === category)
}

/** 按 key 查找单条偏好 */
export function findPreferenceByKey(
  store: UserMemoryStore,
  key: string,
): UserPreference | undefined {
  return store.preferences.find((p) => p.key === key)
}

/** 构建默认 user-memory.json 路径 */
export function getDefaultUserMemoryPath(projectPath: string): string {
  return `${projectPath}/.novel/user-memory.json`
}