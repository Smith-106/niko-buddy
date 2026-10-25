/**
 * skills × 提示词 对齐覆盖表 —— 只读投影（EPIC「skills 与提示词对齐覆盖表」，**零新真源**）。
 *
 * 真源（全部既有，只读）：
 * 1. 去AI味技能库 `de-ai-skill-library.ts`：`BUILT_IN_DE_AI_SKILLS`(:467)、
 *    `getAllDeAiSkills`(:597)、`resolveAvailableDeAiSkills`(:603)、
 *    `DEFAULT_DE_AI_SKILL_ID`(:27)、`deAiSkillToUserSkill`(:624) 的 stage 声明。
 * 2. 提示词键 `prompt-templates.ts` 的 `PROMPTS`(:4) —— **只取键**，不复制提示词正文。
 * 3. 钩子 `novel-skill-hooks.ts` 的进程内注册表 `getNovelSkillHookRegistry()`(:61)。
 *
 * 本模块**不新建任何状态**：不写盘、不调 LLM、不执行钩子、不读项目配置
 * （`loadDeAiSkillConfig` 需要 projectPath + 异步 IO，只读投影不调用）。
 * 纯函数 + 码点排序（**不用** `localeCompare`：locale/ICU 会影响顺序，覆盖表必须可复现）。
 *
 * 诚实边界（每一条都是「没有真源就说没有」）：
 * - **skill → PROMPTS 键 的关联真源不存在**：`DeAiSkill`（de-ai-skill-library.ts:7-16）
 *   没有任何 prompt 键字段，`NovelSkillHook`（novel-skill-hooks.ts:34-48）只有生命周期
 *   `stages`，两个真源都不声明「谁关联哪个 PROMPTS 键」。故默认投影下
 *   `uncoveredPromptKeys` = **全部键**、`coveredPromptKeyCount` = 0。这是如实标注，
 *   **不是**用关键词（`chapter` / `outline` 之类）猜出来的关联。
 * - **每个 skill 的 prompt 键数恒 `null`**：没有声明字段就没有数字可数；`null` = 无真源，
 *   **不是** 0（0 会谎称「确定没有关联」）。只有调用方**显式**注入关联源
 *   （`options.links`）时才会出现数字 —— 该参数是注入缝（测试 / 未来真源接入），
 *   不是新真源，默认 `[]` 即「既有真源没有任何关联声明」。
 * - **每个 skill 各自的 stage 不是逐 skill 真源**：`DeAiSkill` 没有 `stages` 字段，
 *   只能取 `deAiSkillToUserSkill()`(:624-635) 的固定映射 `rewrite` / `output`，全体一致。
 * - **PROMPTS 键的调用点/使用位置**：无「谁在何处调用」真源，不提供、不估算。
 * - **项目盘配置 `.niko-buddy/de-ai-skills.json`**：默认投影
 *   `normalizeDeAiSkillConfig(null)`（会话默认：内建技能 + 无项目技能 + 无停用），不读盘。
 */

import {
  BUILT_IN_DE_AI_SKILLS,
  DEFAULT_DE_AI_SKILL_ID,
  deAiSkillToUserSkill,
  getAllDeAiSkills,
  normalizeDeAiSkillConfig,
  resolveAvailableDeAiSkills,
  type DeAiSkillConfig,
  type DeAiSkillSource,
} from "./de-ai-skill-library"
import { getNovelSkillHookRegistry, type NovelSkillHook } from "./novel-skill-hooks"
import { PROMPTS } from "./prompt-templates"

/** 码点稳定比较（**不用** `localeCompare`）。 */
function compareCodePoint(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** 关联来源种类：`skill` = 去AI味技能，`hook` = Track B 钩子。 */
export type SkillPromptCoverageLinkSource = "skill" | "hook"

/**
 * 一条「关联来源 → PROMPTS 键」声明。
 *
 * 既有真源里**没有**任何字段承载它（见文件头诚实边界），所以默认关联集为空；
 * 本类型只作为注入缝存在：测试可注入假声明验证差集逻辑，未来若出现真源可在此接入。
 */
export interface SkillPromptCoverageLink {
  readonly source: SkillPromptCoverageLinkSource
  readonly sourceId: string
  readonly promptKeys: readonly string[]
}

/** 一个去AI味 skill 一行。 */
export interface SkillPromptCoverageRow {
  readonly id: string
  readonly name: string
  /** 是否内建（真源字段 `DeAiSkill.source === "built-in"`）。 */
  readonly builtIn: boolean
  readonly sourceKind: DeAiSkillSource
  readonly templateId: string
  /** 是否可用（`resolveAvailableDeAiSkills` 未排除）；`false` = 被 `disabledSkillIds` 停用。 */
  readonly enabled: boolean
  /** 是否为当前配置的默认 skill（`config.defaultSkillId`）。 */
  readonly isDefault: boolean
  /** 是否为出厂默认 skill（`DEFAULT_DE_AI_SKILL_ID`）。 */
  readonly isFactoryDefault: boolean
  /**
   * 声明的 stage（码点升序）。取自 `deAiSkillToUserSkill()` 的固定映射 ——
   * `DeAiSkill` 本身没有 `stages` 字段，故这是「去AI味 skill 这一类」的声明，不是逐 skill 真源。
   */
  readonly declaredStages: readonly string[]
  /** 覆盖的 stage 数量（= `declaredStages.length`）。 */
  readonly coveredStageCount: number
  /**
   * 关联的 PROMPTS 键数量：默认 **恒 `null`** —— 无真源（`DeAiSkill` 无 prompt 键字段）。
   * `null` = 不知道，**不是** 0。仅当调用方显式注入 `options.links` 时才给出数字。
   */
  readonly promptKeyCount: number | null
}

/** 一个钩子一行（钩子也是「skill 侧」的关联来源）。 */
export interface SkillPromptCoverageHookRow {
  readonly id: string
  readonly title: string
  /** `enabled !== false`（与 `listNovelSkillHooksForStage` 同口径）。 */
  readonly enabled: boolean
  /** 声明的挂载 stage（码点升序）。 */
  readonly stages: readonly string[]
  /** 同 `SkillPromptCoverageRow.promptKeyCount`：默认恒 `null`（无真源）。 */
  readonly promptKeyCount: number | null
}

/** 一个 PROMPTS 键一行。 */
export interface SkillPromptCoveragePromptKeyRow {
  readonly key: string
  /** 关联该键的 skill id（码点升序）。默认空：无关联真源。 */
  readonly associatedSkillIds: readonly string[]
  /** 关联该键的 hook id（码点升序）。默认空：无关联真源。 */
  readonly associatedHookIds: readonly string[]
  /** 没有任何 skill/hook 关联（无关联真源时恒 `true`）。 */
  readonly uncovered: boolean
}

/** 只读覆盖表。 */
export interface SkillPromptCoverage {
  /** 每个 skill 一行（含被停用的；码点升序，不隐藏行）。 */
  readonly skills: readonly SkillPromptCoverageRow[]
  /** 注册表声明的钩子（含 `enabled: false`；码点升序；空注册表 → 空数组，不造行）。 */
  readonly hooks: readonly SkillPromptCoverageHookRow[]
  /** 每个 PROMPTS 键一行（码点升序）。 */
  readonly promptKeys: readonly SkillPromptCoveragePromptKeyRow[]
  /** 没有任何 skill/hook 关联的提示词键（码点升序）。 */
  readonly uncoveredPromptKeys: readonly string[]
  /** 有至少一个 skill/hook 关联的提示词键数量。 */
  readonly coveredPromptKeyCount: number
  /**
   * 是否有「关联」真源被显式声明。
   * false 时 `coveredPromptKeyCount` / `uncoveredPromptKeys` 只是空链接集的算术结果，
   * UI 必须显示 N/A（不能把"没测过"说成"确认没有覆盖"）。
   */
  readonly associationSourceDeclared: boolean
  readonly builtInSkillCount: number
  readonly projectSkillCount: number
  readonly disabledSkillCount: number
  /** 内建 skill id 全集（真源 `BUILT_IN_DE_AI_SKILLS`；码点升序）。 */
  readonly builtInSkillIds: readonly string[]
  /** 当前配置的默认 skill id。 */
  readonly defaultSkillId: string
  /** 缺的真源清单（面板据此渲染显式 N/A，不伪装成已有功能）。 */
  readonly missingSources: readonly string[]
}

/** 构建选项：全部可选，缺省即读真源默认面（不读盘）。 */
export interface SkillPromptCoverageOptions {
  /** 去AI味配置；缺省 = `normalizeDeAiSkillConfig(null)`（会话默认，不读盘）。 */
  readonly config?: DeAiSkillConfig | null
  /** 钩子清单；缺省 = 进程内注册表 `getNovelSkillHookRegistry().hooks`。 */
  readonly hooks?: readonly NovelSkillHook[]
  /** 提示词键全集；缺省 = `Object.keys(PROMPTS)`。 */
  readonly promptKeys?: readonly string[]
  /**
   * skill/hook → PROMPTS 键 的关联**注入缝**。
   * 缺省（`undefined`）＝ 既有真源没有任何关联声明 → 关联集为空、`promptKeyCount` 恒 `null`。
   * 显式传（含空数组）＝ 调用方声明「关联源存在」，此时 `promptKeyCount` 为数字。
   * **不得**用关键词猜测填充。
   */
  readonly links?: readonly SkillPromptCoverageLink[]
}

/** 本投影**缺**的真源清单（面板逐条渲染 `N/A：…`）。 */
export const SKILL_PROMPT_COVERAGE_MISSING_SOURCES = [
  "skill → PROMPTS 键 的关联声明（DeAiSkill 无 prompt 键字段；NovelSkillHook 只有生命周期 stage）",
  "每个 skill 各自的 stage（DeAiSkill 无 stages 字段，只能取 deAiSkillToUserSkill() 的固定映射 rewrite/output，全体一致）",
  "PROMPTS 键的调用点/使用位置（无「谁在何处调用」真源，不估算）",
  "项目盘配置 .niko-buddy/de-ai-skills.json（只读面板不读盘，默认投影会话默认配置）",
] as const

/** 把真源投影成覆盖表。纯读，无副作用（不执行钩子、不改注册表、不读盘）。 */
export function buildSkillPromptCoverage(options: SkillPromptCoverageOptions = {}): SkillPromptCoverage {
  const config = options.config ?? normalizeDeAiSkillConfig(null)
  const associationSourceDeclared = options.links !== undefined
  const links = options.links ?? []
  const hooks = [...(options.hooks ?? getNovelSkillHookRegistry().hooks)].sort((a, b) =>
    compareCodePoint(a.id, b.id),
  )
  const promptKeys = [...(options.promptKeys ?? Object.keys(PROMPTS))].sort(compareCodePoint)
  const promptKeySet = new Set(promptKeys)

  // 关联索引：key 侧与来源侧各存一份（都只来自显式 links；真源本身不声明关联）。
  // ISS-20260709-051: 去重桶改 Set（插入 O(1)，改前 includes+push O(n²)）；
  // 读取侧统一按 Set 消费（size/展开+排序），首见序由 Set 插入序天然保持。
  const skillIdsByKey = new Map<string, Set<string>>()
  const hookIdsByKey = new Map<string, Set<string>>()
  const keysBySkillId = new Map<string, Set<string>>()
  const keysByHookId = new Map<string, Set<string>>()

  const pushUnique = (bucket: Map<string, Set<string>>, bucketKey: string, value: string) => {
    let existing = bucket.get(bucketKey)
    if (!existing) {
      existing = new Set<string>()
      bucket.set(bucketKey, existing)
    }
    existing.add(value)
  }

  for (const link of links) {
    for (const key of link.promptKeys) {
      // 不存在的键不计入（覆盖表只对真实 PROMPTS 键负责）。
      if (!promptKeySet.has(key)) continue
      if (link.source === "skill") {
        pushUnique(keysBySkillId, link.sourceId, key)
        pushUnique(skillIdsByKey, key, link.sourceId)
      } else {
        pushUnique(keysByHookId, link.sourceId, key)
        pushUnique(hookIdsByKey, key, link.sourceId)
      }
    }
  }

  const enabledSkillIds = new Set(resolveAvailableDeAiSkills(config).map((skill) => skill.id))
  const skills = [...getAllDeAiSkills(config)]
    .sort((a, b) => compareCodePoint(a.id, b.id))
    .map((skill): SkillPromptCoverageRow => {
      const declaredStages = [...deAiSkillToUserSkill(skill).stages].sort(compareCodePoint)
      const linkedKeys = keysBySkillId.get(skill.id)
      return {
        id: skill.id,
        name: skill.name,
        builtIn: skill.source === "built-in",
        sourceKind: skill.source,
        templateId: skill.templateId,
        enabled: enabledSkillIds.has(skill.id),
        isDefault: config.defaultSkillId === skill.id,
        isFactoryDefault: skill.id === DEFAULT_DE_AI_SKILL_ID,
        declaredStages,
        coveredStageCount: declaredStages.length,
        promptKeyCount: associationSourceDeclared ? (linkedKeys?.size ?? 0) : null,
      }
    })

  const hookRows = hooks.map((hook): SkillPromptCoverageHookRow => {
    const linkedKeys = keysByHookId.get(hook.id)
    return {
      id: hook.id,
      title: hook.title,
      enabled: hook.enabled !== false,
      stages: [...hook.stages].sort(compareCodePoint),
      promptKeyCount: associationSourceDeclared ? (linkedKeys?.size ?? 0) : null,
    }
  })

  const promptKeyRows = promptKeys.map((key): SkillPromptCoveragePromptKeyRow => {
    const associatedSkillIds = [...(skillIdsByKey.get(key) ?? [])].sort(compareCodePoint)
    const associatedHookIds = [...(hookIdsByKey.get(key) ?? [])].sort(compareCodePoint)
    return {
      key,
      associatedSkillIds,
      associatedHookIds,
      uncovered: associatedSkillIds.length === 0 && associatedHookIds.length === 0,
    }
  })

  const uncoveredPromptKeys = promptKeyRows.filter((row) => row.uncovered).map((row) => row.key)
  const builtInSkillIds = BUILT_IN_DE_AI_SKILLS.map((skill) => skill.id).sort(compareCodePoint)

  return {
    skills,
    hooks: hookRows,
    promptKeys: promptKeyRows,
    uncoveredPromptKeys,
    coveredPromptKeyCount: promptKeyRows.length - uncoveredPromptKeys.length,
    associationSourceDeclared,
    builtInSkillCount: skills.filter((row) => row.builtIn).length,
    projectSkillCount: skills.filter((row) => !row.builtIn).length,
    disabledSkillCount: skills.filter((row) => !row.enabled).length,
    builtInSkillIds,
    defaultSkillId: config.defaultSkillId,
    missingSources: [...SKILL_PROMPT_COVERAGE_MISSING_SOURCES],
  }
}
