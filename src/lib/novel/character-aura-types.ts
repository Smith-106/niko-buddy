// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

import type { WebSearchResult } from "@/lib/web-search"
import type { LlmConfig, SearchApiConfig } from "@/stores/wiki-store"

export interface CharacterAura {
  id: string
  builtIn: boolean
  name: string
  category?: string
  sourceNote: string
  corpus: string
  styleDescription: string
  behaviorRules: string
  boundaries: string
  notes: string
  expressionDna?: string
  mentalModel?: string
  decisionHeuristics?: string
  valueAntiPatterns?: string
  honestyBoundaries?: string
  sourceUrls?: string
  localDocumentPaths?: string
  generationPrompt?: string
  webSearchEnabled?: boolean
  skillFolder?: string
  createdAt?: number
  updatedAt?: number
}

export interface CharacterAuraBinding {
  characterName: string
  auraId: string
  /** 角色别名/昵称列表，用于在任务描述或初稿正文中匹配该角色 */
  aliases?: string[]
}

export interface BuildCharacterAuraContextOptions {
  fallbackAuraId?: string
  previewMode?: "context" | "writing"
  matchingText?: string
  /**
   * ISS-20260709-023 (DC-7) 渐进式 DI: store 字段注入。缺省回退 useWikiStore
   * 保持向后兼容。逐步消除内部 helper 对 useWikiStore 的直接耦合。
   */
  llmConfig?: LlmConfig
  searchApiConfig?: SearchApiConfig
}

export interface CharacterAuraStore {
  customAuras: CharacterAura[]
  bindings: CharacterAuraBinding[]
}

export type CharacterAuraInput = Omit<CharacterAura, "id" | "builtIn" | "createdAt" | "updatedAt">

export interface CustomCharacterAuraSkillInput {
  name: string
  category?: string
  corpus?: string
  sourceUrls?: string
  localDocumentPaths?: string
  generationPrompt?: string
  enableWebSearch?: boolean
}

/**
 * 由"已经生成好的拆书 Skill"创建自定义灵魂的输入（feature/book-analysis-6d-skill）
 * 适用于：6 维度分析已经在外部跑完，只需要把结果保存为角色灵魂
 */
export interface GeneratedCharacterAuraSkillInput {
  name: string
  category?: string
  sourceBook?: string
  sourceNote: string
  corpus: string
  styleDescription: string
  behaviorRules: string
  boundaries: string
  notes: string
  expressionDna: string
  mentalModel: string
  decisionHeuristics: string
  valueAntiPatterns: string
  honestyBoundaries: string
  /** 完整的 SKILL.md 内容（6 维度分析已生成） */
  skillContent: string
  /** 生成提示词，用于追溯 */
  generationPrompt?: string
  /** 6 份研究文件的内容（key: 文件名，value: markdown 内容） */
  researchFiles?: Record<string, string>
}

export interface LocalDocumentImportResult {
  path: string
  content: string
}

export interface UrlDocumentImportResult {
  url: string
  content: string
}

export interface SearchDocumentImportResult extends UrlDocumentImportResult {
  title: string
  query: string
  source: string
  snippet: string
}

export interface CustomCharacterAuraGenerationInput extends CustomCharacterAuraSkillInput {
  importedDocuments: LocalDocumentImportResult[]
  failedDocuments: string[]
  importedUrls: UrlDocumentImportResult[]
  failedUrls: string[]
  searchQueries: string[]
  webSearchResults: WebSearchResult[]
  importedSearchDocuments: SearchDocumentImportResult[]
  failedSearchUrls: string[]
  generationNotes: string[]
  distillationFallbackNote?: string
}

export interface CustomAuraGeneratedFields {
  sourceNote: string
  styleDescription: string
  behaviorRules: string
  boundaries: string
  notes: string
  expressionDna: string
  mentalModel: string
  decisionHeuristics: string
  valueAntiPatterns: string
  honestyBoundaries: string
}

export interface CharacterAuraGenerationProgress {
  step: number
  total: number
  stage: string
  detail: string
  researchFileName?: CharacterAuraResearchFileName
}

export interface CharacterAuraGenerationOptions {
  onProgress?: (progress: CharacterAuraGenerationProgress) => void
  /**
   * ISS-20260709-023 (DC-7) 渐进式 DI: store 字段注入。透传到内部 helper,
   * 缺省回退 useWikiStore.getState() 保持向后兼容。
   */
  llmConfig?: LlmConfig
  searchApiConfig?: SearchApiConfig
}

export interface AuraWorkflowStage {
  fileName: CharacterAuraResearchFileName
  label: string
  sections: string[]
  goal: string
}

/**
 * ISS-20260709-023 (DC-7) 渐进式 DI: custom aura 生成子系统的 store 字段注入。
 * 缺省回退 useWikiStore.getState() 保持向后兼容。
 */
export interface AuraInjectedConfig {
  llmConfig?: LlmConfig
  searchApiConfig?: SearchApiConfig
}

export interface CustomSourceIndexInput {
  sourceUrls?: string
  localDocumentPaths?: string
  generationPrompt?: string
  enableWebSearch?: boolean
  webSearchEnabled?: boolean
  searchQueries?: string[]
  webSearchResults?: WebSearchResult[]
  failedSearchUrls?: string[]
  generationNotes?: string[]
}

export const CHARACTER_AURA_RESEARCH_FILES = [
  { fileName: "01-writings.md", label: "01 公开资料" },
  { fileName: "02-conversations.md", label: "02 对话方式" },
  { fileName: "03-expression-dna.md", label: "03 表达特征" },
  { fileName: "04-external-views.md", label: "04 外部评价" },
  { fileName: "05-decisions.md", label: "05 决策记录" },
  { fileName: "06-timeline.md", label: "06 时间线" },
] as const

export type CharacterAuraResearchFileName = typeof CHARACTER_AURA_RESEARCH_FILES[number]["fileName"]
