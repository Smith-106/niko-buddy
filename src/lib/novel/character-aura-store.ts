// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { joinPath } from "@/lib/path-utils"
import type {
  CharacterAura,
  CharacterAuraBinding,
  CharacterAuraInput,
  CharacterAuraStore,
  CharacterAuraResearchFileName,
} from "./character-aura-types"
import { CHARACTER_AURA_RESEARCH_FILES } from "./character-aura-types"
import { BUILT_IN_CHARACTER_AURAS } from "./character-aura-builtin"
import { storePath } from "./character-aura-utils"

export async function loadCharacterAuraStore(projectPath: string): Promise<CharacterAuraStore> {
  try {
    const raw = await readFile(storePath(projectPath))
    const parsed = JSON.parse(raw) as Partial<CharacterAuraStore>
    return {
      customAuras: Array.isArray(parsed.customAuras) ? parsed.customAuras : [],
      bindings: Array.isArray(parsed.bindings) ? parsed.bindings : [],
    }
  } catch {
    return { customAuras: [], bindings: [] }
  }
}

export async function saveCharacterAuraStore(projectPath: string, store: CharacterAuraStore): Promise<void> {
  await writeFileAtomic(storePath(projectPath), JSON.stringify(store, null, 2))
}

export async function listCharacterAuras(projectPath: string): Promise<CharacterAura[]> {
  const store = await loadCharacterAuraStore(projectPath)
  return [...BUILT_IN_CHARACTER_AURAS, ...store.customAuras]
}

export async function createCustomCharacterAura(projectPath: string, input: CharacterAuraInput): Promise<CharacterAura> {
  const store = await loadCharacterAuraStore(projectPath)
  const now = Date.now()
  const aura: CharacterAura = {
    id: `custom-${now}-${Math.random().toString(36).slice(2, 8)}`,
    builtIn: false,
    ...input,
    createdAt: now,
    updatedAt: now,
  }
  store.customAuras.push(aura)
  await saveCharacterAuraStore(projectPath, store)
  return aura
}

export async function updateCustomCharacterAura(projectPath: string, auraId: string, patch: Partial<CharacterAuraInput>): Promise<CharacterAura> {
  const store = await loadCharacterAuraStore(projectPath)
  const index = store.customAuras.findIndex((aura) => aura.id === auraId)
  if (index < 0) throw new Error("未找到自定义灵魂")
  const updated = { ...store.customAuras[index], ...patch, builtIn: false, updatedAt: Date.now() }
  store.customAuras[index] = updated
  await saveCharacterAuraStore(projectPath, store)
  await syncStoredCustomAuraFiles(updated)
  return updated
}

export async function deleteCustomCharacterAura(projectPath: string, auraId: string): Promise<CharacterAuraStore> {
  const store = await loadCharacterAuraStore(projectPath)
  const nextStore = {
    customAuras: store.customAuras.filter((aura) => aura.id !== auraId),
    bindings: store.bindings.filter((binding) => binding.auraId !== auraId),
  }
  await saveCharacterAuraStore(projectPath, nextStore)
  return nextStore
}

export async function bindCharacterAura(
  projectPath: string,
  binding: CharacterAuraBinding,
  hasCharacterProfile: (projectPath: string, characterName: string) => Promise<boolean>,
): Promise<CharacterAuraStore> {
  const store = await loadCharacterAuraStore(projectPath)
  const allAuras = [...BUILT_IN_CHARACTER_AURAS, ...store.customAuras]
  if (!allAuras.some((aura) => aura.id === binding.auraId)) {
    throw new Error("请选择有效的角色灵魂")
  }
  const characterName = binding.characterName.trim()
  const hasProfile = await hasCharacterProfile(projectPath, characterName)
  if (!hasProfile) {
    throw new Error("请先在大纲中添加人物小传或人物设定，再绑定角色灵魂")
  }
  const nextBinding = { ...binding, characterName }
  const existingIndex = store.bindings.findIndex((item) => item.characterName === characterName)
  const bindings = existingIndex >= 0
    ? store.bindings.map((item, index) => (index === existingIndex ? nextBinding : item))
    : [...store.bindings, nextBinding]
  const nextStore = { ...store, bindings }
  await saveCharacterAuraStore(projectPath, nextStore)
  return nextStore
}

export async function unbindCharacterAura(
  projectPath: string,
  characterName: string,
  auraId?: string,
): Promise<CharacterAuraStore> {
  const store = await loadCharacterAuraStore(projectPath)
  const normalizedCharacterName = characterName.trim()
  const bindings = store.bindings.filter((binding) => {
    if (binding.characterName !== normalizedCharacterName) return true
    if (auraId && binding.auraId !== auraId) return true
    return false
  })
  const nextStore = { ...store, bindings }
  await saveCharacterAuraStore(projectPath, nextStore)
  return nextStore
}

export async function getCharacterAuraBindings(projectPath: string): Promise<CharacterAuraBinding[]> {
  return (await loadCharacterAuraStore(projectPath)).bindings
}

export async function syncStoredCustomAuraFiles(aura: CharacterAura): Promise<void> {
  if (!aura.skillFolder) return
  await createDirectory(aura.skillFolder)
  await createDirectory(joinPath(aura.skillFolder, "references", "research"))
  const existingResearchFiles = await loadExistingResearchFiles(aura.skillFolder)
  // Note: storedCustomSkillMarkdown and storedCustomResearchMarkdown are imported from markdown module
  const { storedCustomSkillMarkdown, storedCustomResearchMarkdown } = await import("./character-aura-markdown")
  await writeFileAtomic(joinPath(aura.skillFolder, "SKILL.md"), storedCustomSkillMarkdown(aura, existingResearchFiles))
  for (const file of CHARACTER_AURA_RESEARCH_FILES) {
    if (existingResearchFiles[file.fileName]?.trim()) continue
    await writeFileAtomic(joinPath(aura.skillFolder, "references", "research", file.fileName), storedCustomResearchMarkdown(aura, file.fileName))
  }
}

export async function loadExistingResearchFiles(
  skillFolder: string,
): Promise<Partial<Record<CharacterAuraResearchFileName, string>>> {
  const files: Partial<Record<CharacterAuraResearchFileName, string>> = {}
  for (const file of CHARACTER_AURA_RESEARCH_FILES) {
    try {
      const content = await readFile(joinPath(skillFolder, "references", "research", file.fileName))
      if (content.trim()) files[file.fileName] = content
    } catch {
      // Keep edit flow resilient when some generated research files are missing.
    }
  }
  return files
}
