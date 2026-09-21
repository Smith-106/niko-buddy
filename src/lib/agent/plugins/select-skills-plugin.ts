import type { PrePlugin, PrePluginInput, PrePluginOutput } from "../pipeline"
import { resolveAiWorkflowMode, type AiWorkflowMode } from "../workflow-mode"
import { filterSkillsForSkillRoute, filterSkillsForSkillRoutes, inferSkillRoute, collectExplicitSkills, getOutlineSkillNames, getWritingSkillNames, resolveAvailableSkillsByNames, uniqueSkillsById } from "@/lib/novel"
import { applyTaskSkillOverride, resolveTaskSkillNames } from "@/lib/novel/task-customization"
import type { NovelTaskIntent, SkillKind, SkillStage, UserSkill, SkillRoute } from "@/lib/novel"
import { retrieveCapabilities } from "../capability-retrieval"
import { buildCapabilityPlannerPrompt, parseCapabilityPlan } from "../capability-planner"
import { appendCapabilityTrace } from "../capability-trace-store"
import { resolveNovelModel } from "@/lib/novel"
import { streamChat } from "@/lib/llm-client"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { useWikiStore } from "@/stores/wiki-store"

const WRITING_INTENTS = new Set<NovelTaskIntent>([
  "write_chapter",
  "continue_chapter",
  "rewrite_chapter",
  "polish_chapter",
])

const REVIEW_INTENTS = new Set<NovelTaskIntent>(["review_chapter", "lint_chapter"])
const QUERY_INTENTS = new Set<NovelTaskIntent>([
  "search_plot",
  "character_query",
  "foreshadowing_query",
  "timeline_query",
  "setting_query",
])

const STANDARD_WRITING_SKILL_NAMES = [
  "章节承接",
  "下一章计划",
  "人物动机",
  "冲突升级",
  "剧情自检",
  "正文输出协议",
]

const STRICT_WRITING_SKILL_NAMES = [
  ...STANDARD_WRITING_SKILL_NAMES,
  "主线检查",
  "伏笔管理",
  "节奏检查",
  "结尾钩子",
]

const FAST_WRITING_SKILL_NAMES = ["正文输出协议", "基础去AI味"]

const EXCLUDED_FROM_FALLBACK = ["去AI味"]
const OUTLINE_SUPPORT_ROUTES: SkillRoute[] = [
  "character",
  "setting",
  "worldbuilding",
  "faction",
  "foreshadowing",
  "map",
  "topic",
]

export function createSelectSkillsPlugin(): PrePlugin {
  return {
    name: "select_skills",
    priority: 35,
    run: async (input: PrePluginInput): Promise<PrePluginOutput> => {
      if (!input.novelMode) return { selectedSkills: [] }

      const route = input.effectiveTaskRoute || input.taskRoute
      if (!route) return { selectedSkills: [] }

      const availableSkills = input.availableSkills ?? []
      const mode = resolveAiWorkflowMode(input.aiWorkflowMode)
      const deterministicNames = route.intent === "generate_outline"
        ? getOutlineSkillNames(input.userMessage)
        : getWritingSkillNames(route.intent, input.userMessage)
      const explicitSkills = uniqueSkillsById([
        ...(input.selectedSkills ?? []),
        ...collectExplicitSkills(availableSkills, input.userMessage),
      ])
      const routedSkills = selectSkillsForRoute(availableSkills, route.intent, mode, input.userMessage)
      let selectedSkills = uniqueSkillsById([...explicitSkills, ...routedSkills])

      // ── 能力规划器（Commander·decide）────────────────────────────────
      // 灰度：planExecuteEnabled && 非 fast 模式时，把查表结果之外的可用技能
      // 经 BM25 召回 + Rule Filter 交给 LLM 规划成能力 DAG，再把 DAG 引用的
      // 技能并入 selectedSkills。规划器失败/超时/无可用 LLM → 静默回退到
      // 上面的查表结果（Draft-first 边界：不阻断主链）。
      let plannedTraces: import("../capabilities/types").SelectedCapabilityTrace[] = []
      if (input.planExecuteEnabled && mode !== "fast") {
        try {
          const planned = await planCapabilitySelection({
            userMessage: input.userMessage,
            intent: route.intent,
            mode,
            availableSkills,
            novelConfig: input.novelConfig,
            projectPath: input.projectPath,
          })
          if (planned.skills.length > 0) {
            selectedSkills = uniqueSkillsById([...selectedSkills, ...planned.skills])
            plannedTraces = planned.traces
          }
        } catch {
          // 规划器异常 → 保持查表结果，不阻断主链
        }
      }

      const missingSkillNames = deterministicNames.length > 0
        ? resolveAvailableSkillsByNames(mode === "fast"
            ? availableSkills
            : availableSkills.filter((skill) => skill.modes.includes(mode)), deterministicNames).missingNames
        : []

      // 任务级技能名单覆盖（task customization）：novelConfig 缺省/名单空 = 现状逻辑不变
      const overrideKey = resolveOverrideKey(route.intent)
      const userNames = input.novelConfig && overrideKey
        ? resolveTaskSkillNamesForOverride(input.novelConfig, overrideKey)
        : []
      if (userNames.length > 0) {
        const override = applyTaskSkillOverride(
          selectedSkills.map((skill) => skill.name),
          userNames,
          new Set(availableSkills.map((skill) => skill.name)),
        )
        if (override.applied) {
          const byName = resolveAvailableSkillsByNames(availableSkills, override.names).skills
          selectedSkills = uniqueSkillsById([...byName, ...selectedSkills])
        }
        if (override.missing.length > 0) missingSkillNames.push(...override.missing)
      }

      return {
        selectedSkills,
        missingSkillNames,
        // 能力规划器 trace：reason=规划器为何选它，供 SelectedCapabilityTrace 观测
        ...(plannedTraces.length > 0
          ? { selectedCapabilities: [...(input.selectedCapabilities ?? []), ...plannedTraces] }
          : {}),
      }
    },
  }
}

export function selectSkillsForRoute(
  skills: UserSkill[],
  intent: NovelTaskIntent,
  mode: AiWorkflowMode,
  requestText = "",
): UserSkill[] {
  if (mode === "fast") return []

  const modeSkills = skills.filter((skill) => skill.modes.includes(mode))
  if (modeSkills.length === 0) return []

  if (WRITING_INTENTS.has(intent)) {
    return selectWritingSkills(modeSkills, mode, intent, requestText)
  }

  if (intent === "generate_outline") {
    const routedNames = getOutlineSkillNames(requestText)
    if (routedNames.length > 0) {
      const routed = resolveAvailableSkillsByNames(modeSkills, routedNames).skills
      if (routed.length > 0) return routed
    }
    return selectOutlineSkills(modeSkills, mode)
  }

  if (REVIEW_INTENTS.has(intent)) {
    return selectByShape(modeSkills, mode, {
      kinds: ["review", "knowledge", "output"],
      stages: ["review", "output"],
      limit: mode === "strict" ? 8 : 5,
    })
  }

  if (QUERY_INTENTS.has(intent)) {
    return selectByShape(modeSkills, mode, {
      kinds: ["knowledge", "review", "output"],
      stages: ["planning", "review", "output"],
      limit: mode === "strict" ? 6 : 3,
    })
  }

  return []
}

function selectOutlineSkills(skills: UserSkill[], mode: Exclude<AiWorkflowMode, "fast">): UserSkill[] {
  const limit = mode === "strict" ? 8 : 5
  const options = {
      kinds: ["planning", "structure", "output"],
      stages: ["planning", "output"],
      limit,
    } satisfies { kinds: SkillKind[]; stages: SkillStage[]; limit: number }
  const outlineSkills = selectByShape(filterSkillsForSkillRoute(skills, "outline"), mode, options)
  const supportSkills = selectByShape(filterSkillsForSkillRoutes(skills, OUTLINE_SUPPORT_ROUTES), mode, options)
  const selected: UserSkill[] = []
  for (const skill of [...outlineSkills, ...supportSkills]) {
    if (selected.length >= limit) break
    if (!selected.some((item) => item.id === skill.id)) {
      selected.push(skill)
    }
  }
  if (selected.length > 0) {
    return selected
  }
  return selectByShape(skills, mode, options)
}

function selectWritingSkills(
  skills: UserSkill[],
  mode: Exclude<AiWorkflowMode, "fast">,
  intent: NovelTaskIntent,
  requestText: string,
): UserSkill[] {
  const writingSkills = skills.filter((skill) => {
    const route = inferSkillRoute(skill)
    return route === "writing" || route === null
  })
  const scopedSkills = writingSkills.length > 0 ? writingSkills : skills
  const primaryNames = getWritingSkillNames(intent, requestText)
  const supportNames = mode === "strict" ? STRICT_WRITING_SKILL_NAMES : FAST_WRITING_SKILL_NAMES
  const preferredNames = [...primaryNames, ...supportNames]
  if (mode === "standard") {
    return selectPreferredNames(scopedSkills, preferredNames, Math.max(3, primaryNames.length + 2), false)
  }
  if (mode === "strict") {
    return selectPreferredNames(scopedSkills, preferredNames, 14)
  }
  return []
}

function selectPreferredNames(skills: UserSkill[], names: string[], limit: number, fillWithRelevant = true): UserSkill[] {
  const selected: UserSkill[] = []
  for (const name of names) {
    const skill = skills.find((item) => item.name === name || item.id === name)
    if (skill && !selected.some((item) => item.id === skill.id)) {
      selected.push(skill)
    }
  }

  const fallback = skills
    .filter((skill) => isWritingSkill(skill))
    .filter((skill) => !EXCLUDED_FROM_FALLBACK.some((name) => skill.name === name))
    .sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50))

  if (selected.length > 0) {
    if (!fillWithRelevant) return selected.slice(0, limit)
    for (const skill of fallback) {
      if (selected.length >= limit) break
      if (!selected.some((item) => item.id === skill.id)) {
        selected.push(skill)
      }
    }
    return selected.slice(0, limit)
  }

  return fallback.slice(0, limit)
}

function selectByShape(
  skills: UserSkill[],
  mode: Exclude<AiWorkflowMode, "fast">,
  options: { kinds: SkillKind[]; stages: SkillStage[]; limit: number },
): UserSkill[] {
  return skills
    .filter((skill) =>
      skill.kind.some((kind) => options.kinds.includes(kind))
      || skill.stages.some((stage) => options.stages.includes(stage)),
    )
    .sort((a, b) => scoreSkill(b, mode, options) - scoreSkill(a, mode, options))
    .slice(0, options.limit)
}

function isWritingSkill(skill: UserSkill): boolean {
  return skill.kind.some((kind) => kind === "planning" || kind === "structure" || kind === "review" || kind === "output" || kind === "style")
    || skill.stages.some((stage) => stage === "planning" || stage === "drafting" || stage === "review" || stage === "output" || stage === "rewrite")
}

function scoreSkill(
  skill: UserSkill,
  mode: Exclude<AiWorkflowMode, "fast">,
  options: { kinds: SkillKind[]; stages: SkillStage[] },
): number {
  let score = 0
  score += skill.kind.filter((kind) => options.kinds.includes(kind)).length * 3
  score += skill.stages.filter((stage) => options.stages.includes(stage)).length * 2
  if (skill.modes.includes(mode)) score += 1
  if (skill.source === "built-in") score += 0.5
  score += (100 - (skill.priority ?? 50)) * 0.1
  return score
}

export function buildSelectedSkillsPrompt(skills: UserSkill[] | undefined): string {
  if (!skills || skills.length === 0) return ""

  const blocks = skills.map((skill, index) => [
    `### ${index + 1}. ${skill.name}`,
    `类型：${skill.kind.join(", ")}`,
    `阶段：${skill.stages.join(", ")}`,
    skill.description ? `说明：${skill.description}` : "",
    "规则：",
    skill.content,
  ].filter(Boolean).join("\n"))

  return [
    "## 本次启用 Skill",
    "以下 Skill 只用于本次任务的内部写作决策和输出约束。不要在最终回复中解释 Skill、列出 Skill 分析过程，除非用户明确要求。",
    ...blocks,
  ].join("\n\n")
}


function resolveOverrideKey(intent: NovelTaskIntent): "writing" | "outline" | "review" | null {
  if (WRITING_INTENTS.has(intent)) return "writing"
  if (intent === "generate_outline") return "outline"
  if (REVIEW_INTENTS.has(intent)) return "review"
  return null
}

function resolveTaskSkillNamesForOverride(
  novelConfig: import("@/stores/wiki-store").NovelConfig,
  key: "writing" | "outline" | "review",
): string[] {
  return resolveTaskSkillNames(novelConfig, key)
}

// ---------------------------------------------------------------------------
// 能力规划器接入（L2 Commander·decide）
// ---------------------------------------------------------------------------

const CAPABILITY_PLANNER_TIMEOUT_MS = 20_000
const CAPABILITY_RETRIEVAL_LIMIT = 8

interface PlanCapabilitySelectionInput {
  userMessage: string
  intent: NovelTaskIntent
  mode: Exclude<AiWorkflowMode, "fast">
  availableSkills: UserSkill[]
  novelConfig?: import("@/stores/wiki-store").NovelConfig
  /** .novel/ trace 落盘用；缺省则只规划不持久化 */
  projectPath?: string
}

interface PlanCapabilitySelectionResult {
  skills: UserSkill[]
  traces: import("../capabilities/types").SelectedCapabilityTrace[]
}

/**
 * BM25 召回 → Rule Filter → LLM 能力规划 → 映射回 UserSkill + trace。
 *
 * 返回空 skills 表示「规划器无可贡献」——调用方静默回退查表。任何 LLM/解析
 * 失败也返回空（由调用方的 try/catch 兑底）。
 */
async function planCapabilitySelection(input: PlanCapabilitySelectionInput): Promise<PlanCapabilitySelectionResult> {
  const empty: PlanCapabilitySelectionResult = { skills: [], traces: [] }
  const { providerConfigs, llmConfig, novelConfig: storeNovelConfig } = useWikiStore.getState()
  if (!hasUsableLlm(llmConfig, providerConfigs)) {
    await recordTrace(input, empty, "fallback", "无可用 LLM")
    return empty
  }

  // L1：召回 + Rule Filter（mode 对齐 + 仅 auto 权限技能——技能本是 prompt 约束）
  const retrieval = retrieveCapabilities(input.userMessage, input.availableSkills, {
    mode: input.mode,
    intent: input.intent,
    autoOnly: true,
  }, { limit: CAPABILITY_RETRIEVAL_LIMIT })
  const candidates = retrieval.candidates
  if (candidates.length === 0) {
    await recordTrace(input, empty, "empty", "召回无候选", retrieval.filteredOut)
    return empty
  }

  // L2：LLM 规划能力 DAG
  const resolvedConfig = resolveNovelModel(llmConfig, input.novelConfig ?? storeNovelConfig, "review")
  const prompt = buildCapabilityPlannerPrompt({
    userMessage: input.userMessage,
    candidates,
    intent: input.intent,
  })

  const timeoutSignal = AbortSignal.timeout(CAPABILITY_PLANNER_TIMEOUT_MS)
  let responseText = ""
  // 可变容器：onError 回调内赋值、await 后读取——直接 let 会被 CFA 收窄为 never
  const streamErrorRef: { current: Error | null } = { current: null }
  await streamChat(
    resolvedConfig,
    [
      { role: "system", content: "你是写作能力规划器。只输出 JSON，不要输出解释。" },
      { role: "user", content: prompt },
    ],
    {
      onToken: (chunk: string) => { responseText += chunk },
      onDone: () => {},
      onError: (err: Error) => { streamErrorRef.current = err },
    },
    timeoutSignal,
  )
  const streamError = streamErrorRef.current
  if (streamError) {
    await recordTrace(input, empty, "error", streamError.message, retrieval.filteredOut, candidates)
    throw streamError
  }

  // 解析 + 校验（capabilityId 必须在召回候选集内——防幻觉）
  const allowedIds = new Set(candidates.map((c) => c.doc.id))
  const parsed = parseCapabilityPlan(responseText, allowedIds)
  if (!parsed.ok) {
    await recordTrace(input, empty, "empty", parsed.error, retrieval.filteredOut, candidates)
    return empty
  }

  // 能力 DAG → UserSkill 列表（按拓扑序：dependsOn 靠前者先排）+ trace
  const skillById = new Map(candidates.map((c) => [c.doc.id, c.doc.ref as UserSkill]))
  const docById = new Map(candidates.map((c) => [c.doc.id, c.doc]))
  const ordered = topoOrderPlan(parsed.plan)
  const selected: UserSkill[] = []
  const traces: import("../capabilities/types").SelectedCapabilityTrace[] = []
  for (const id of ordered) {
    const planNode = parsed.plan.find((n) => n.id === id)
    const skill = planNode ? skillById.get(planNode.capabilityId) : undefined
    const doc = planNode ? docById.get(planNode.capabilityId) : undefined
    if (skill && !selected.some((s) => s.id === skill.id)) {
      selected.push(skill)
      traces.push({
        id: planNode!.capabilityId,
        name: doc?.name ?? planNode!.capabilityId,
        kind: "user_skill",
        permission: doc?.permission ?? "auto",
        source: doc?.source,
        reason: planNode!.reason || "能力规划器选中",
        skillId: skill.id,
      })
    }
  }
  const result: PlanCapabilitySelectionResult = { skills: selected, traces }
  await recordTrace(input, result, "success", undefined, retrieval.filteredOut, candidates)
  return result
}

/** 旁路 trace 落盘：projectPath 缺省时跳过；IO 失败吞错（由 store 内部保证）。 */
async function recordTrace(
  input: PlanCapabilitySelectionInput,
  result: PlanCapabilitySelectionResult,
  outcome: "success" | "empty" | "fallback" | "error",
  detail?: string,
  filteredOut: Array<{ id: string; reason: string }> = [],
  candidates: { doc: { id: string } }[] = [],
): Promise<void> {
  if (!input.projectPath) return
  await appendCapabilityTrace(input.projectPath, {
    query: input.userMessage,
    intent: input.intent,
    mode: input.mode,
    retrieved: candidates.map((c) => c.doc.id),
    filteredOut,
    planned: result.traces,
    outcome,
    detail,
  })
}

/** 拓扑排序（Kahn）：dependsOn 全满足的节点先出，环已由 validate 拦截。 */
function topoOrderPlan(plan: { id: string; dependsOn: string[] }[]): string[] {
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const n of plan) {
    indegree.set(n.id, 0)
    dependents.set(n.id, [])
  }
  for (const n of plan) {
    for (const dep of n.dependsOn) {
      if (dependents.has(dep)) {
        dependents.get(dep)!.push(n.id)
        indegree.set(n.id, (indegree.get(n.id) ?? 0) + 1)
      }
    }
  }
  const queue = plan.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const next of dependents.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1
      indegree.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  // 残留节点（理论上有环才被拦，防御性补齐防漏选）
  for (const n of plan) if (!order.includes(n.id)) order.push(n.id)
  return order
}
