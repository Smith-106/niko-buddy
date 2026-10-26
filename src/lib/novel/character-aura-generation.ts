// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * M3-1: 自定义角色灵魂生成编排层 (generation orchestration)。
 *
 * 从 character-aura.ts 剥出——该层是生成流水线的唯一入口
 * (createCustomCharacterAuraSkill LLM 全流程 / createCustomCharacterAuraFromGeneratedSkill
 * 已生成 Skill 落盘), 内部 helper 全部复用既有抽象层切片
 * (document/research/markdown/store/utils/types), 本文件不引入新依赖。
 * character-aura.ts 经由 re-export 保持向后兼容 (barrel/组件 import 路径不变)。
 */

import { createDirectory, writeFileAtomic } from "@/commands/fs"
import { joinPath, normalizePath } from "@/lib/path-utils"
import { loadCharacterAuraStore, saveCharacterAuraStore } from "./character-aura-store"
import {
  collectCustomAuraWebSearch,
  readCustomAuraLocalDocuments,
  readCustomAuraUrls,
} from "./character-aura-document"
import {
  AURA_WORKFLOW_STAGES,
  buildAuraResearchStage,
  synthesizeCustomAuraFields,
} from "./character-aura-research"
import {
  buildStoredCorpus,
  customResearchMarkdown,
  customSkillMarkdown,
} from "./character-aura-markdown"
import { safeSkillSlug } from "./character-aura-utils"
import type {
  AuraInjectedConfig,
  CharacterAura,
  CharacterAuraGenerationOptions,
  CharacterAuraResearchFileName,
  CustomCharacterAuraGenerationInput,
  CustomCharacterAuraSkillInput,
  GeneratedCharacterAuraSkillInput,
} from "./character-aura-types"
import { CHARACTER_AURA_RESEARCH_FILES } from "./character-aura-types"

export async function createCustomCharacterAuraSkill(
  projectPath: string,
  input: CustomCharacterAuraSkillInput,
  options: CharacterAuraGenerationOptions = {},
): Promise<CharacterAura> {
  const store = await loadCharacterAuraStore(projectPath)
  // ISS-20260709-023 (DC-7) 渐进式 DI: 透传注入 config 到内部 helper。
  const injectedConfig: AuraInjectedConfig = {
    llmConfig: options.llmConfig,
    searchApiConfig: options.searchApiConfig,
  }
  const now = Date.now()
  const id = `custom-${now}-${Math.random().toString(36).slice(2, 8)}`
  const skillFolder = `${normalizePath(projectPath)}/.niko-buddy/character-auras/${safeSkillSlug(id, input.name)}-perspective`
  const totalSteps = 2 + AURA_WORKFLOW_STAGES.length + 2
  let progressStep = 0
  const emitProgress = (stage: string, detail: string, researchFileName?: CharacterAuraResearchFileName) => {
    progressStep += 1
    options.onProgress?.({ step: progressStep, total: totalSteps, stage, detail, researchFileName })
  }

  emitProgress("准备资料", "正在读取你提供的文本、网页和本地文档。")
  const localDocuments = await readCustomAuraLocalDocuments(input)
  const urlDocuments = await readCustomAuraUrls(input)
  const generationInput: CustomCharacterAuraGenerationInput = {
    ...input,
    ...localDocuments,
    ...urlDocuments,
    searchQueries: [],
    webSearchResults: [],
    importedSearchDocuments: [],
    failedSearchUrls: [],
    generationNotes: [],
  }

  emitProgress(
    input.enableWebSearch ? "AI 搜索" : "跳过 AI 搜索",
    input.enableWebSearch
      ? "正在根据角色名称和提示词检索联网资料。"
      : "当前仅基于你提供的资料生成，不启用联网搜索。",
  )
  const searchPack = input.enableWebSearch
    ? await collectCustomAuraWebSearch(input, injectedConfig)
    : { searchQueries: [], webSearchResults: [], importedSearchDocuments: [], failedSearchUrls: [], generationNotes: [] }
  generationInput.searchQueries = searchPack.searchQueries
  generationInput.webSearchResults = searchPack.webSearchResults
  generationInput.importedSearchDocuments = searchPack.importedSearchDocuments
  generationInput.failedSearchUrls = searchPack.failedSearchUrls
  generationInput.generationNotes = searchPack.generationNotes

  const workflowResearchFiles: Partial<Record<CharacterAuraResearchFileName, string>> = {}
  for (const stage of AURA_WORKFLOW_STAGES) {
    emitProgress(stage.label, `正在生成 ${stage.label}，写入 ${stage.fileName}。`, stage.fileName)
    workflowResearchFiles[stage.fileName] = await buildAuraResearchStage(stage, generationInput, workflowResearchFiles, injectedConfig)
  }

  emitProgress("汇总灵魂", "正在把 6 份研究文件合成为角色灵魂核心字段。")
  const generated = await synthesizeCustomAuraFields(generationInput, workflowResearchFiles, injectedConfig)
  const aura: CharacterAura = {
    id,
    builtIn: false,
    name: input.name,
    category: input.category || "自定义灵魂",
    sourceNote: generated.sourceNote,
    corpus: buildStoredCorpus(generationInput),
    styleDescription: generated.styleDescription,
    behaviorRules: generated.behaviorRules,
    boundaries: generated.boundaries,
    notes: generated.notes,
    expressionDna: generated.expressionDna,
    mentalModel: generated.mentalModel,
    decisionHeuristics: generated.decisionHeuristics,
    valueAntiPatterns: generated.valueAntiPatterns,
    honestyBoundaries: generated.honestyBoundaries,
    sourceUrls: input.sourceUrls ?? "",
    localDocumentPaths: input.localDocumentPaths ?? "",
    generationPrompt: input.generationPrompt ?? "",
    webSearchEnabled: Boolean(input.enableWebSearch),
    skillFolder,
    createdAt: now,
    updatedAt: now,
  }
  const skillMarkdown = customSkillMarkdown(aura, generationInput, workflowResearchFiles)
  await createDirectory(skillFolder)
  await createDirectory(joinPath(skillFolder, "references", "research"))
  emitProgress("保存结果", "正在写入灵魂文档和 6 份研究文件。")
  await writeFileAtomic(joinPath(skillFolder, "SKILL.md"), skillMarkdown)
  for (const file of CHARACTER_AURA_RESEARCH_FILES) {
    await writeFileAtomic(
      joinPath(skillFolder, "references", "research", file.fileName),
      workflowResearchFiles[file.fileName] ?? customResearchMarkdown(aura, generationInput, file.fileName), /* v8 ignore start */ /* v8 ignore stop */
    )
  }
  store.customAuras.push(aura)
  await saveCharacterAuraStore(projectPath, store)
  return aura
}

/**
 * 由已生成的拆书 Skill 创建自定义灵魂（feature/book-analysis-6d-skill）
 *
 * 区别于 createCustomCharacterAuraSkill：本函数不再调用 LLM，
 * 假定 skillContent 和 researchFiles 已经由 6 维度分析生成完毕，
 * 只负责把结果落盘到 <projectPath>/.niko-buddy/character-auras/<id>-perspective/。
 */
export async function createCustomCharacterAuraFromGeneratedSkill(
  projectPath: string,
  input: GeneratedCharacterAuraSkillInput,
): Promise<CharacterAura> {
  const store = await loadCharacterAuraStore(projectPath)
  const now = Date.now()
  const id = `custom-${now}-${Math.random().toString(36).slice(2, 8)}`
  const skillFolder = `${normalizePath(projectPath)}/.niko-buddy/character-auras/${safeSkillSlug(id, input.name)}-perspective`
  const aura: CharacterAura = {
    id,
    builtIn: false,
    name: input.name,
    category: input.category || "拆书角色",
    sourceNote: input.sourceNote,
    corpus: input.corpus,
    styleDescription: input.styleDescription,
    behaviorRules: input.behaviorRules,
    boundaries: input.boundaries,
    notes: input.notes,
    expressionDna: input.expressionDna,
    mentalModel: input.mentalModel,
    decisionHeuristics: input.decisionHeuristics,
    valueAntiPatterns: input.valueAntiPatterns,
    honestyBoundaries: input.honestyBoundaries,
    generationPrompt: input.generationPrompt ?? "",
    webSearchEnabled: false,
    skillFolder,
    createdAt: now,
    updatedAt: now,
  }
  await createDirectory(skillFolder)
  await createDirectory(joinPath(skillFolder, "references", "research"))
  await writeFileAtomic(joinPath(skillFolder, "SKILL.md"), input.skillContent)
  const researchFiles = input.researchFiles ?? {}
  // 写已提供的 6 份研究文件；缺失文件用空 markdown 兜底，避免下游读不到
  for (const file of CHARACTER_AURA_RESEARCH_FILES) {
    const content = researchFiles[file.fileName]
    await writeFileAtomic(
      joinPath(skillFolder, "references", "research", file.fileName),
      content ?? `# ${input.name} - ${file.label}\n\n（拆书分析未提供该维度）\n`,
    )
  }
  store.customAuras.push(aura)
  await saveCharacterAuraStore(projectPath, store)
  return aura
}
