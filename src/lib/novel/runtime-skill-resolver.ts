// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * runtime-skill-resolver.ts — Phase 1 单一权威运行时技能装载与预算器
 *
 * 统一接入四条主链（Deep Chapter / Deep Outline / Six-Dim Review / Chat）：
 * 1. 按需精准水合 `source === "linked"` 技能（不扫全库，避免 90+ 技能启动 IO）；
 * 2. 尊重 `disabledSkillIds` 过滤；
 * 3. 修复同名遮蔽：明确优先级 `uploaded > project > linked(非空) > built-in`，linked 空内容自动降级并留痕 gap；
 * 4. 使用 `parseFrontmatter`（含 UTF-8 BOM 兼容）剥离 YAML frontmatter，只向提示词注入干净正文；
 * 5. 使用统一 `estimateTokens` 分配阶段独立预算槽，截断/丢弃/缺失全部写入 `ContextGap`；
 * 6. 零配置字节等价：当任务技能名单为空且无显式引用时直接零 IO 短路返回空串。
 */

import type { LlmConfig, NovelConfig, TaskPromptKey } from "@/stores/wiki-store"
import { parseFrontmatter } from "@/lib/frontmatter"
import { estimateTokens } from "@/lib/token-estimator"
import { logger, toErrorMessage } from "@/lib/utils"
import type { ContextGap } from "./context-data-source"
import type { ContextPack } from "./context-engine-types"
import type { UserSkill } from "./skill-library"
import { resolveTaskSkillNames } from "./task-customization"
import {
  loadLinkedSkillContent,
  loadUserSkillConfig,
  resolveEnabledWritingSkills,
  type UserSkillConfig,
} from "./user-skill-store"
import type { NovelTaskIntent } from "./task-router"

export type RuntimeSkillStage = "writing" | "outline" | "review" | "chat" | "summary" | "extract"

export interface ExplicitSkillRef {
  skillId?: string
  title?: string
}

export interface ResolveRuntimeSkillsInput {
  projectPath?: string | null
  stage: RuntimeSkillStage
  novelConfig?: Pick<NovelConfig, "taskSkillNames" | "contextTokenBudget">
  taskIntent?: NovelTaskIntent
  requestText?: string
  explicitReferences?: readonly ExplicitSkillRef[]
  /** 模型上下文总窗口（tokens），用于计算技能独立预算槽。 */
  windowTokens?: number
  /** 可选硬上限（tokens），优先于默认阶段配额。 */
  maxSkillBudgetTokens?: number
  /** 可选绑定 ContextPack，将截断/缺失/降级留痕写入 pack.gaps。 */
  pack?: Pick<ContextPack, "gaps">
  /** 自定义渲染段标题，默认 `## 任务自定义技能（用户配置）`。 */
  heading?: string
  /** 可选注入已加载技能池（供测试或调用方复用）。 */
  skillConfigOverride?: UserSkillConfig
}

export interface ResolveRuntimeSkillsResult {
  skills: UserSkill[]
  missingNames: string[]
  renderedText: string
  usedTokens: number
  budgetTokens: number
  truncatedNames: string[]
  droppedNames: string[]
  gaps: ContextGap[]
}

/** Phase 1 分层单字段字符上限（替代原先全字段统一 4000 字符一刀切）。 */
export const DEFAULT_TIERED_SECTION_CHAR_BUDGETS: Readonly<Partial<Record<keyof ContextPack, number>>> = {
  soulDoc: 6000,
  characterAuras: 4500,
  writingStyle: 3200,
  techniqueBlocks: 1500,
}

const DEFAULT_STAGE_HEADING = "## 任务自定义技能（用户配置）"

const SOURCE_PRECEDENCE: Record<UserSkill["source"], number> = {
  uploaded: 4,
  project: 3,
  linked: 2,
  "built-in": 1,
}

const MIN_TRUNCATED_SKILL_TOKENS = 240
const TRUNCATION_SUFFIX = "\n…（已按运行时技能预算截断）"

export function mapRuntimeStageToTaskKey(
  stage: RuntimeSkillStage,
  taskIntent?: NovelTaskIntent,
): TaskPromptKey {
  if (stage !== "chat") return stage
  if (!taskIntent) return "writing"
  const intentStr = String(taskIntent)
  if (intentStr.includes("outline")) return "outline"
  if (intentStr.includes("review")) return "review"
  if (intentStr.includes("summar")) return "summary"
  if (intentStr.includes("extract")) return "extract"
  return "writing"
}

export function computeRuntimeSkillBudgetTokens(
  stage: RuntimeSkillStage,
  windowTokens?: number,
  maxSkillBudgetTokens?: number,
): number {
  if (typeof maxSkillBudgetTokens === "number" && Number.isFinite(maxSkillBudgetTokens) && maxSkillBudgetTokens > 0) {
    return Math.floor(maxSkillBudgetTokens)
  }
  const effectiveWindow =
    typeof windowTokens === "number" && Number.isFinite(windowTokens) && windowTokens > 0
      ? windowTokens
      : 64000
  const capByStage: Record<RuntimeSkillStage, number> = {
    writing: 6000,
    chat: 5000,
    outline: 4500,
    review: 3000,
    summary: 2500,
    extract: 2500,
  }
  const ratioByStage: Record<RuntimeSkillStage, number> = {
    writing: 0.12,
    chat: 0.1,
    outline: 0.1,
    review: 0.08,
    summary: 0.05,
    extract: 0.05,
  }
  const scaled = Math.floor(effectiveWindow * ratioByStage[stage])
  return Math.max(1200, Math.min(capByStage[stage], scaled))
}

/**
 * 统一上下文包 token 预算：尊重 `novelConfig.contextTokenBudget`，按模型窗口封顶并扣除技能已占预算。
 */
export function computeEffectiveContextTokenBudget(
  novelConfig: Pick<NovelConfig, "contextTokenBudget"> | undefined,
  llmConfig: Pick<LlmConfig, "maxContextSize"> | undefined,
  skillUsedTokens: number,
  fallbackBudget = 32000,
): number {
  const configured =
    typeof novelConfig?.contextTokenBudget === "number"
    && Number.isFinite(novelConfig.contextTokenBudget)
    && novelConfig.contextTokenBudget > 0
      ? Math.floor(novelConfig.contextTokenBudget)
      : fallbackBudget
  const maxCtx =
    typeof llmConfig?.maxContextSize === "number"
    && Number.isFinite(llmConfig.maxContextSize)
    && llmConfig.maxContextSize > 0
      ? Math.floor(llmConfig.maxContextSize)
      : 0
  // 留足大纲/系统指令/输出余量：上下文包最多占模型窗口的 65%
  const windowCap = maxCtx > 0 ? Math.max(4000, Math.floor(maxCtx * 0.65)) : configured
  const bounded = Math.min(configured, windowCap)
  const deducted = bounded - Math.max(0, Math.floor(skillUsedTokens))
  return Math.max(2000, deducted)
}

function stripSkillFrontmatter(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ""
  const parsed = parseFrontmatter(trimmed)
  const body = parsed.body.trim()
  return body || trimmed
}

function compareSkillCandidates(a: UserSkill, b: UserSkill): number {
  const sourceDiff = (SOURCE_PRECEDENCE[b.source] ?? 0) - (SOURCE_PRECEDENCE[a.source] ?? 0)
  if (sourceDiff !== 0) return sourceDiff
  const priorityDiff = (b.priority ?? 50) - (a.priority ?? 50)
  if (priorityDiff !== 0) return priorityDiff
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
}

function truncateTextToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return ""
  if (estimateTokens(text) <= maxTokens) return text
  const suffixTokens = estimateTokens(TRUNCATION_SUFFIX)
  const targetTokens = Math.max(16, maxTokens - suffixTokens)
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (estimateTokens(text.slice(0, mid)) <= targetTokens) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  const kept = text.slice(0, lo).trimEnd()
  return kept ? `${kept}${TRUNCATION_SUFFIX}` : ""
}

function appendGapsToPack(pack: Pick<ContextPack, "gaps"> | undefined, gaps: ContextGap[]): void {
  if (!pack || !Array.isArray(pack.gaps) || gaps.length === 0) return
  for (const gap of gaps) {
    pack.gaps.push(gap)
  }
}

export async function resolveRuntimeSkillsForStage(
  input: ResolveRuntimeSkillsInput,
): Promise<ResolveRuntimeSkillsResult> {
  const budgetTokens = computeRuntimeSkillBudgetTokens(
    input.stage,
    input.windowTokens,
    input.maxSkillBudgetTokens,
  )
  const emptyResult: ResolveRuntimeSkillsResult = {
    skills: [],
    missingNames: [],
    renderedText: "",
    usedTokens: 0,
    budgetTokens,
    truncatedNames: [],
    droppedNames: [],
    gaps: [],
  }

  const taskKey = mapRuntimeStageToTaskKey(input.stage, input.taskIntent)
  const configuredNames = resolveTaskSkillNames(input.novelConfig, taskKey)
  const explicitRefs = (input.explicitReferences ?? []).filter(
    (ref) => Boolean(ref.skillId?.trim() || ref.title?.trim()),
  )

  // 零配置字节等价短路：未配置任务技能且无显式引用时不触发任何 IO，返回空串
  if (configuredNames.length === 0 && explicitRefs.length === 0) {
    return emptyResult
  }

  let pool: UserSkillConfig
  try {
    pool = input.skillConfigOverride ?? await loadUserSkillConfig(input.projectPath)
  } catch (err) {
    logger.warn("RuntimeSkillResolver", `技能池加载失败（非阻断，已降级为空）: ${toErrorMessage(err)}`)
    const gap: ContextGap = {
      type: "load_failed",
      ref: `runtime_skills:${input.stage}`,
      reason: "datasource_error",
      originalLength: 0,
      retainedLength: 0,
    }
    appendGapsToPack(input.pack, [gap])
    return { ...emptyResult, gaps: [gap] }
  }

  const enabledSkills = resolveEnabledWritingSkills(pool)
  const byName = new Map<string, UserSkill[]>()
  const byId = new Map<string, UserSkill>()
  for (const skill of enabledSkills) {
    byId.set(skill.id, skill)
    const key = skill.name.trim()
    if (!key) continue
    const list = byName.get(key)
    if (list) list.push(skill)
    else byName.set(key, [skill])
  }
  for (const list of byName.values()) {
    list.sort(compareSkillCandidates)
  }

  // 构建待水合请求序列（显式引用优先，随后是任务配置名单，按 skill.id 去重保序）
  const requestedTargets: Array<{ label: string; candidates: UserSkill[] }> = []
  const seenLabels = new Set<string>()

  for (const ref of explicitRefs) {
    const id = ref.skillId?.trim()
    const title = ref.title?.trim()
    if (id && byId.has(id)) {
      const target = byId.get(id)!
      const label = target.name
      if (!seenLabels.has(label)) {
        seenLabels.add(label)
        requestedTargets.push({ label, candidates: [target] })
      }
      continue
    }
    if (title && !seenLabels.has(title)) {
      seenLabels.add(title)
      requestedTargets.push({ label: title, candidates: byName.get(title) ?? [] })
    }
  }

  for (const name of configuredNames) {
    if (seenLabels.has(name)) continue
    seenLabels.add(name)
    requestedTargets.push({ label: name, candidates: byName.get(name) ?? [] })
  }

  const hydratedSkills: UserSkill[] = []
  const missingNames: string[] = []
  const gaps: ContextGap[] = []
  const selectedIds = new Set<string>()

  for (const target of requestedTargets) {
    if (target.candidates.length === 0) {
      missingNames.push(target.label)
      gaps.push({
        type: "unavailable",
        ref: `runtime_skill:${target.label}`,
        reason: "datasource_error",
        originalLength: 0,
        retainedLength: 0,
      })
      continue
    }

    let picked: UserSkill | null = null
    let linkedFallbackUsed = false
    for (const candidate of target.candidates) {
      if (selectedIds.has(candidate.id)) {
        picked = candidate
        break
      }
      let rawContent = candidate.content
      if (candidate.source === "linked" && candidate.linkedPath) {
        try {
          rawContent = await loadLinkedSkillContent(candidate, {
            projectPath: input.projectPath ?? undefined,
          })
        } catch (err) {
          logger.warn("RuntimeSkillResolver", `链接技能读取失败（尝试回退同名技能）: ${candidate.name} (${toErrorMessage(err)})`)
          rawContent = ""
        }
      }
      const cleanBody = stripSkillFrontmatter(rawContent)
      if (cleanBody) {
        picked = { ...candidate, content: cleanBody }
        break
      }
      if (candidate.source === "linked") {
        linkedFallbackUsed = true
      }
    }

    if (!picked) {
      missingNames.push(target.label)
      gaps.push({
        type: "unavailable",
        ref: `runtime_skill:${target.label}`,
        reason: "datasource_error",
        originalLength: 0,
        retainedLength: 0,
      })
      continue
    }

    if (linkedFallbackUsed) {
      gaps.push({
        type: "load_failed",
        ref: `runtime_skill_linked_fallback:${target.label}`,
        reason: "datasource_error",
        originalLength: 0,
        retainedLength: picked.content.length,
      })
    }

    if (!selectedIds.has(picked.id)) {
      selectedIds.add(picked.id)
      hydratedSkills.push(picked)
    }
  }

  if (hydratedSkills.length === 0) {
    appendGapsToPack(input.pack, gaps)
    return {
      skills: [],
      missingNames,
      renderedText: "",
      usedTokens: 0,
      budgetTokens,
      truncatedNames: [],
      droppedNames: [],
      gaps,
    }
  }

  const heading = input.heading ?? DEFAULT_STAGE_HEADING
  const headingTokens = estimateTokens(`${heading}\n\n`)
  let remainingTokens = Math.max(0, budgetTokens - headingTokens)

  const includedSkills: UserSkill[] = []
  const renderedBlocks: string[] = []
  const truncatedNames: string[] = []
  const droppedNames: string[] = []

  for (const skill of hydratedSkills) {
    const sectionHeader = `### ${skill.name}\n`
    const fullBlock = `${sectionHeader}${skill.content}`
    const blockTokens = estimateTokens(fullBlock)

    if (blockTokens <= remainingTokens) {
      includedSkills.push(skill)
      renderedBlocks.push(fullBlock)
      remainingTokens -= blockTokens
      continue
    }

    const headerTokens = estimateTokens(sectionHeader)
    const bodyBudget = remainingTokens - headerTokens
    if (bodyBudget >= MIN_TRUNCATED_SKILL_TOKENS) {
      const truncatedBody = truncateTextToTokenBudget(skill.content, bodyBudget)
      if (truncatedBody) {
        const truncatedBlock = `${sectionHeader}${truncatedBody}`
        includedSkills.push({ ...skill, content: truncatedBody })
        renderedBlocks.push(truncatedBlock)
        truncatedNames.push(skill.name)
        remainingTokens = Math.max(0, remainingTokens - estimateTokens(truncatedBlock))
        gaps.push({
          type: "truncated",
          ref: `runtime_skill:${skill.name}`,
          reason: "budget_exceeded",
          originalLength: skill.content.length,
          retainedLength: truncatedBody.length,
        })
        continue
      }
    }

    droppedNames.push(skill.name)
    gaps.push({
      type: "truncated",
      ref: `runtime_skill:${skill.name}`,
      reason: "budget_exceeded",
      originalLength: skill.content.length,
      retainedLength: 0,
    })
  }

  appendGapsToPack(input.pack, gaps)

  if (renderedBlocks.length === 0) {
    return {
      skills: [],
      missingNames,
      renderedText: "",
      usedTokens: 0,
      budgetTokens,
      truncatedNames,
      droppedNames,
      gaps,
    }
  }

  const renderedText = [heading, ...renderedBlocks].join("\n\n")
  const usedTokens = estimateTokens(renderedText)

  return {
    skills: includedSkills,
    missingNames,
    renderedText,
    usedTokens,
    budgetTokens,
    truncatedNames,
    droppedNames,
    gaps,
  }
}
