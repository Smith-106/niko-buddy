// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

import { readFile } from "@/commands/fs"
import { searchWiki } from "@/lib/search"
import { joinPath } from "@/lib/path-utils"
import { logger } from "@/lib/utils"
import type {
  CharacterAura,
  CharacterAuraBinding,
  BuildCharacterAuraContextOptions,
} from "./character-aura-types"
import { BUILT_IN_CHARACTER_AURAS } from "./character-aura-builtin"
import { loadCharacterAuraStore } from "./character-aura-store"
import {
  toPinyin,
  toSimplified,
  normalizeCharacterText,
  compressMarkdownForAuraContext,
} from "./character-aura-utils"
import { CHARACTER_AURA_RESEARCH_FILES } from "./character-aura-types"
import { listBindableNovelCharacters } from "./bindable-characters"

export async function buildCharacterAuraContext(
  projectPath: string,
  task: string,
  options: BuildCharacterAuraContextOptions = {},
): Promise<string> {
  const store = await loadCharacterAuraStore(projectPath)
  if (store.bindings.length === 0) return ""
  const allAuras = [...BUILT_IN_CHARACTER_AURAS, ...store.customAuras]
  const matchingText = [task, options.matchingText ?? ""].filter(Boolean).join("\n")
  const normalizedTask = normalizeCharacterText(matchingText)
  const pinyinTask = toPinyin(normalizedTask)
  const simplifiedTask = toSimplified(normalizedTask)
  const tokens = new Set(matchingText.split(/[\s，。、『』《》：:；;,.!?！？\-]+/).filter(Boolean))
  const matched = store.bindings.filter((binding) => {
    const normalizedName = normalizeCharacterText(binding.characterName)
    const aliases = (binding.aliases ?? []).filter((alias) => alias.trim().length > 0)
    const normalizedAliases = aliases.map((alias) => normalizeCharacterText(alias)).filter((n) => n.length > 0)
    // 拼音和简繁形式
    const pinyinName = normalizedName.length > 0 ? toPinyin(normalizedName) : ""
    const simplifiedName = normalizedName.length > 0 ? toSimplified(normalizedName) : ""
    const pinyinAliases = normalizedAliases.map((a) => toPinyin(a))
    const simplifiedAliases = normalizedAliases.map((a) => toSimplified(a))
    return (
      matchingText.includes(binding.characterName)
      || tokens.has(binding.characterName)
      || (normalizedName.length > 0 && normalizedTask.includes(normalizedName))
      // 别名匹配：任务描述或上下文中出现别名时也命中该角色
      || aliases.some((alias) => matchingText.includes(alias) || tokens.has(alias))
      || normalizedAliases.some((normalizedAlias) => normalizedTask.includes(normalizedAlias))
      // 拼音模糊匹配：任务描述的拼音包含角色名/别名的拼音
      || (pinyinName.length > 0 && pinyinTask.includes(pinyinName))
      || pinyinAliases.some((pa) => pa.length > 0 && pinyinTask.includes(pa))
      // 简繁模糊匹配：任务描述的简体形式包含角色名/别名的简体形式
      || (simplifiedName.length > 0 && simplifiedTask.includes(simplifiedName))
      || simplifiedAliases.some((sa) => sa.length > 0 && simplifiedTask.includes(sa))
    )
  })
  const effectiveMatched = matched.length > 0 || !options.fallbackAuraId
    ? matched
    : store.bindings.filter((binding) => binding.auraId === options.fallbackAuraId)
  if (effectiveMatched.length === 0) return ""
  if (options.previewMode === "writing") {
    return buildCharacterAuraWritingPreview(task, effectiveMatched, allAuras)
  }
  const lines: string[] = []
  for (const binding of effectiveMatched) {
    const aura = allAuras.find((item) => item.id === binding.auraId)
    if (!aura) continue
    lines.push(
      `- ${binding.characterName}：${aura.name}`,
      `  - 人物分类：${aura.category ?? "自定义灵魂"}`,
      `  - 灵魂摘要：${aura.styleDescription}`,
      `  - 怎么说话 / 表达特征：${aura.expressionDna ?? aura.corpus}`,
      `  - 怎么想 / 心智模型：${aura.mentalModel ?? aura.styleDescription}`,
      `  - 怎么判断 / 决策启发式：${aura.decisionHeuristics ?? aura.behaviorRules}`,
      `  - 什么不做 / 价值观反模式：${aura.valueAntiPatterns ?? aura.notes}`,
      `  - 知道局限 / 诚实边界：${aura.honestyBoundaries ?? aura.boundaries}`,
      ...(await buildCompressedSkillSummary(aura)),
    )
  }
  if (lines.length === 0) return ""
  lines.push("- 角色灵魂必须服从大纲、人物小传、角色认知和正史规则，不得覆盖或改写硬性设定。")
  return lines.join("\n")
}

async function buildCompressedSkillSummary(aura: CharacterAura): Promise<string[]> {
  if (!aura.skillFolder) return []
  const lines: string[] = []
  let skillReadFailed = false
  let researchReadFailed = false
  try {
    const skill = await loadCharacterAuraSkillDocument(aura)
    const summary = compressMarkdownForAuraContext(skill, 700)
    if (summary) lines.push(`  - 灵魂文档压缩摘要：${summary}`)
  } catch {
    skillReadFailed = true
  }
  const researchSummaries: string[] = []
  for (const file of CHARACTER_AURA_RESEARCH_FILES) {
    try {
      const document = await loadCharacterAuraResearchDocument(aura, file.fileName)
      const summary = compressMarkdownForAuraContext(document, 220)
      if (summary) researchSummaries.push(`${file.label}：${summary}`)
    } catch {
      researchReadFailed = true
    }
  }
  if (researchSummaries.length > 0) lines.push(`  - 研究文件压缩摘要：${researchSummaries.join("；")}`)
  if (skillReadFailed || researchReadFailed) lines.push("  - 灵魂文档读取失败，已降级使用结构化灵魂字段。")
  return lines
}

export async function loadCharacterAuraSkillDocument(aura: CharacterAura, projectPath?: string): Promise<string> {
  if (!aura.skillFolder) return ""
  return readSkillFileWithFallback(joinPath(aura.skillFolder, "SKILL.md"), projectPath)
}

export async function loadCharacterAuraResearchDocument(
  aura: CharacterAura,
  fileName: typeof CHARACTER_AURA_RESEARCH_FILES[number]["fileName"],
  projectPath?: string,
): Promise<string> {
  if (!aura.skillFolder) return ""
  return readSkillFileWithFallback(joinPath(aura.skillFolder, "references", "research", fileName), projectPath)
}

import { isTauri } from "@/lib/platform"
async function readSkillFileWithFallback(filePath: string, projectPath?: string): Promise<string> {
  try {
    return await readFile(filePath)
  } catch (error) {
    const roots: string[] = []
    
    // 项目目录
    if (projectPath) {
      const { normalizePath } = await import("./character-aura-utils")
      roots.push(normalizePath(projectPath))
    }
    
    // Tauri 环境：尝试获取可执行文件目录和资源目录
    if (isTauri()) {
      try {
        const { getExecutableDir, getResourceDir } = await import("@/commands/fs")
        try {
          const exeDir = await getExecutableDir()
          roots.push(exeDir)
          // 便携版：skills 直接在 exe 旁边
          // 安装版：skills 在 exe 目录下的 _up_ 子目录中
          roots.push(joinPath(exeDir, "_up_"))
          // 也尝试 exe 的上一级目录
          const parentDir = exeDir.replace(/[\\/][^\\/]+[\\/]?$/, "")
          if (parentDir && parentDir !== exeDir) roots.push(parentDir)
        } catch {}
        try {
          const resDir = await getResourceDir()
          roots.push(resDir)
          // Tauri NSIS 安装版把 ../skills 放到 _up_/skills
          roots.push(joinPath(resDir, "_up_"))
        } catch {}
      } catch {}

      try {
        const { resourceDir } = await import("@tauri-apps/api/path")
        try {
          const resDir = await resourceDir()
          roots.push(resDir)
          roots.push(joinPath(resDir, "_up_"))
        } catch {}
      } catch {}
    }
    
    // 去重
    const uniqueRoots = [...new Set(roots.filter(Boolean))]
    
    for (const root of uniqueRoots) {
      /* v8 ignore next */
      if (!root) continue
      try {
        const fullPath = joinPath(root, filePath)
        return await readFile(fullPath)
      } catch {}
    }
    
    throw error
  }
}

function buildCharacterAuraWritingPreview(
  task: string,
  bindings: CharacterAuraBinding[],
  allAuras: CharacterAura[],
): string {
  const normalizedTask = task.trim()
  const sections = bindings
    .map((binding) => {
      const aura = allAuras.find((item) => item.id === binding.auraId)
      if (!aura) return ""
      const expression = summarizeAuraPreviewField(aura.expressionDna ?? aura.styleDescription)
      const mental = summarizeAuraPreviewField(aura.mentalModel ?? aura.corpus)
      const decision = summarizeAuraPreviewField(aura.decisionHeuristics ?? aura.behaviorRules)
      const avoid = summarizeAuraPreviewField(aura.valueAntiPatterns ?? aura.notes)
      return [
        `【本次写作会怎样塑造「${binding.characterName}」】`,
        `这段内容只借用这类灵魂的气质、语气、判断方式和表达倾向来塑造「${binding.characterName}」，不会把灵魂原型的人生经历、时代背景、历史使命或成就直接写进正文。`,
        `任务场景：${normalizedTask}`,
        "",
        "【会体现哪些风格影响】",
        `- 表达方式：${expression}`,
        `- 思考方式：${mental}`,
        `- 决策方式：${decision}`,
        `- 写作时要避免：${avoid}`,
        "",
        "【示例写法】",
        buildCharacterAuraPreviewExcerpt(binding.characterName, normalizedTask, aura),
      ].join("\n")
    })
    .filter(Boolean)
  return sections.join("\n\n")
}

function summarizeAuraPreviewField(value: string | undefined): string {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim()
  if (!normalized) return "保持当前任务需要的角色状态，不额外偏离剧情目标。"
  const sentence = normalized.split(/[。！？!?]/).map((part) => part.trim()).find(Boolean) ?? normalized
  return sentence
}

function buildCharacterAuraPreviewExcerpt(characterName: string, task: string, aura: CharacterAura): string {
  const expression = summarizeAuraPreviewField(aura.expressionDna ?? aura.styleDescription)
  const decision = summarizeAuraPreviewField(aura.decisionHeuristics ?? aura.behaviorRules)
  return `这段剧情里，${characterName}会先贴住当前场景和关系变化来行动，不额外补写灵魂原型的个人经历或历史包袱。围绕「${task}」这个任务，落笔时会更强调${expression}；真正做决定时，会更明显体现出${decision}，让角色呈现出稳定一致的气质和表达倾向。`
}

export async function hasCharacterProfile(projectPath: string, characterName: string): Promise<boolean> {
  const knownCharacters = await listBindableNovelCharacters(projectPath)
  const normalizedTarget = normalizeCharacterText(characterName)
  if (knownCharacters.some((name) => normalizeCharacterText(name) === normalizedTarget)) return true
  const results = await searchWiki(projectPath, `${characterName} 人物小传 人物设定`)
  for (const result of results) {
    const text = [result.title, result.snippet].join("\n")
    if (/人物小传|人物设定/.test(text) && text.includes(characterName)) return true
    try {
      const content = await readFile(result.path)
      if (/人物小传|人物设定/.test(content) && content.includes(characterName)) return true
    } catch (err) {
      logger.warn("Character Aura", "readFile failed for research file", { error: err instanceof Error ? err.message : String(err) })
    }
  }
  return false
}
