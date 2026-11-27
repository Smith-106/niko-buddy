/**
 * v2 适配器：把大纲多智能体编排（outline-multi-agent-orchestrator，自 v3 提取的模式）
 * 接入 v2 现有 streamChat 与 deep-outline-generation 流水线。
 *
 * 纪律：编排核心为纯逻辑（依赖注入），本文件只做 v2 侧接线——
 * runSubAgent = 单次 streamChat（注入 scoped context + skill 提示词）；
 * mergeResults = 一次合并 streamChat；runSingleAgentFallback = 现有 runDeepOutlineGeneration。
 */
import { streamChat, type StreamCallbacks } from "@/lib/llm-client"
import { parseFrontmatter } from "@/lib/frontmatter"
import type { LlmConfig } from "@/stores/wiki-store"
import { runDeepOutlineGeneration } from "./deep-outline-generation"
import {
  buildBoundedSubAgentMergePayload,
  runOutlineMultiAgentWorkflow,
  type OutlineSubAgentPlan,
  type OutlineSubAgentResult,
  type OutlineSubAgentStatusEvent,
} from "./outline-multi-agent-orchestrator"
import { buildScopedOutlineSubAgentContext } from "./outline-agent-context"
import type { ContextPack } from "./context-engine"
import type { UserSkill } from "./skill-library"
import { resolveSkillReference } from "./skill-route-registry"
import { runMcpToolLoop } from "@/lib/mcp/agent-consumer"
import type { McpToolLike } from "@/lib/mcp/agent-consumer"

export type ResolvedOutlineSkill = Pick<UserSkill, "id" | "name" | "content">

export const DEFAULT_MAX_SKILL_CHARS_PER_AGENT = 4_000
export const DEFAULT_MAX_CHARS_PER_SKILL = 1_800

export interface OutlineMultiAgentAdapterInput {
  llmConfig: LlmConfig
  userRequest: string
  contextPack: ContextPack
  plan: OutlineSubAgentPlan[]
  maxConcurrency?: number
  onStatusChange?: (event: OutlineSubAgentStatusEvent) => void
  signal?: AbortSignal
  /** 可选的 MCP 工具集：子智能体可通过文本协议工具循环真实调用外部工具。 */
  mcpTools?: McpToolLike[]
  /** 可选：已过滤禁用项的真实技能列表，供子智能体注入剥离 frontmatter 的技能正文。 */
  resolvedSkills?: ReadonlyArray<ResolvedOutlineSkill>
  /** 单个子智能体注入的技能正文总字符上限（默认 4000）。 */
  maxSkillCharsPerAgent?: number
  /** 单条技能正文字符上限（默认 1800）。 */
  maxCharsPerSkill?: number
}

export interface OutlineMultiAgentAdapterResult {
  mode: "multi-agent" | "single-agent-fallback"
  finalText: string
  successfulAgents: string[]
  failedAgents: string[]
  fallbackReason?: string
  failureDetails?: string[]
}

function normalizeBudget(raw: number | undefined, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw)
  }
  return fallback
}

function resolveAssignedSkills(
  skillRefs: readonly string[],
  resolvedSkills: ReadonlyArray<ResolvedOutlineSkill>,
): ResolvedOutlineSkill[] {
  const matched: ResolvedOutlineSkill[] = []
  const seen = new Set<string>()
  for (const rawRef of skillRefs) {
    const ref = rawRef.trim()
    if (!ref) continue
    const skill =
      resolvedSkills.find((item) => item.id === ref || item.name === ref)
      ?? resolveSkillReference(resolvedSkills, { id: ref })
      ?? resolveSkillReference(resolvedSkills, { name: ref })
    if (skill && !seen.has(skill.id)) {
      seen.add(skill.id)
      matched.push(skill)
    }
  }
  return matched
}

/**
 * 纯函数：为单个大纲子智能体拼装真实技能正文指引块。
 *
 * - 未传 `resolvedSkills` 时平滑回退为旧版名称行（兼容存量调用与单测）；
 * - 传入 `resolvedSkills` 时按 `id`/`name`（含路由别名）解析技能，经 `parseFrontmatter`
 *   安全剥离 YAML frontmatter，并严格遵守单条（`maxCharsPerSkill`）与单子智能体总量
 *   （`maxSkillCharsPerAgent`）字符预算，超限时附显式截断标记。
 */
export function buildInjectedSkillsBlock(
  skillRefs: readonly string[],
  resolvedSkills?: ReadonlyArray<ResolvedOutlineSkill>,
  options?: {
    maxSkillCharsPerAgent?: number
    maxCharsPerSkill?: number
  },
): string {
  if (skillRefs.length === 0) return ""
  if (!resolvedSkills) {
    return `\n可用技能：${skillRefs.join("、")}`
  }

  const assigned = resolveAssignedSkills(skillRefs, resolvedSkills)
  if (assigned.length === 0) return ""

  const totalBudget = normalizeBudget(options?.maxSkillCharsPerAgent, DEFAULT_MAX_SKILL_CHARS_PER_AGENT)
  const perSkillBudget = normalizeBudget(options?.maxCharsPerSkill, DEFAULT_MAX_CHARS_PER_SKILL)
  const marker = "\n...[已截断]"

  const sections: string[] = []
  const omittedNames: string[] = []
  let usedChars = 0

  for (const skill of assigned) {
    const parsed = parseFrontmatter(skill.content)
    const body = (parsed?.body ?? skill.content).trim()
    if (!body) continue

    const remaining = totalBudget - usedChars
    if (remaining <= 0) {
      omittedNames.push(skill.name)
      continue
    }

    const cap = Math.min(perSkillBudget, remaining)
    let injectedBody: string
    if (body.length <= cap) {
      injectedBody = body
    } else if (cap > marker.length) {
      injectedBody = `${body.slice(0, cap - marker.length)}${marker}`
    } else {
      injectedBody = body.slice(0, cap)
    }
    usedChars += injectedBody.length
    sections.push(`### 技能：${skill.name}\n${injectedBody}`)
  }

  if (sections.length === 0) return ""

  const lines = [
    "\n以下为本子智能体分配的写作技能指引（已剥离 frontmatter 并按预算裁剪）：",
    ...sections,
  ]
  if (omittedNames.length > 0) {
    lines.push(
      `[已截断：超出单子智能体技能总预算 ${totalBudget} 字符，省略 ${omittedNames.length} 项技能（${omittedNames.join("、")}）]`,
    )
  }
  return lines.join("\n\n")
}

function buildSubAgentPrompt(
  plan: OutlineSubAgentPlan,
  scopedContext: string,
  resolvedSkills?: ReadonlyArray<ResolvedOutlineSkill>,
  skillBudget?: {
    maxSkillCharsPerAgent?: number
    maxCharsPerSkill?: number
  },
): string {
  const skills = buildInjectedSkillsBlock(plan.skillNames, resolvedSkills, skillBudget)
  return [
    `你是大纲子智能体「${plan.name}」（维度：${plan.kind}）。`,
    `任务：${plan.taskPrompt}`,
    skills,
    `\n以下为本子智能体专属上下文（已裁剪）：\n${scopedContext}`,
    `\n请直接输出该维度的大纲内容（Markdown），不要输出 JSON 包装。`,
  ].join("\n")
}

function buildMergePrompt(payload: string): string {
  return [
    "以下为多个大纲子智能体的产出，请合并为一份完整、连贯、无重复的大纲（Markdown）：",
    "\n" + payload,
    "\n合并要求：保留各维度有效内容；消除冲突与重复；按 卷→章 结构组织；直接输出最终大纲。",
  ].join("\n")
}

export async function runOutlineMultiAgentGeneration(
  input: OutlineMultiAgentAdapterInput,
): Promise<OutlineMultiAgentAdapterResult> {
  const {
    llmConfig,
    userRequest,
    contextPack,
    plan,
    maxConcurrency,
    onStatusChange,
    signal,
    mcpTools,
    resolvedSkills,
    maxSkillCharsPerAgent,
    maxCharsPerSkill,
  } = input

  const runSubAgent = async (subPlan: OutlineSubAgentPlan): Promise<string> => {
    const scoped = buildScopedOutlineSubAgentContext(contextPack, subPlan.kind)
    const prompt = buildSubAgentPrompt(subPlan, scoped, resolvedSkills, {
      maxSkillCharsPerAgent,
      maxCharsPerSkill,
    })
    if (mcpTools && mcpTools.length > 0) {
      // MCP 消费：子智能体可调用外部工具，结果回填后生成该维度内容
      const loopResult = await runMcpToolLoop({
        llmConfig,
        prompt,
        mcpTools,
        signal,
        maxTurns: 2,
      })
      return loopResult.finalText
    }
    let text = ""
    const callbacks: StreamCallbacks = {
      onToken: (token) => {
        text += token
      },
      onDone: () => {},
      onError: () => {},
    }
    await streamChat(
      llmConfig,
      [{ role: "user", content: prompt }],
      callbacks,
      signal,
    )
    return text
  }

  const mergeResults = async (results: OutlineSubAgentResult[]): Promise<string> => {
    const payload = buildBoundedSubAgentMergePayload(results)
    let text = ""
    const callbacks: StreamCallbacks = {
      onToken: (token) => {
        text += token
      },
      onDone: () => {},
      onError: () => {},
    }
    await streamChat(
      llmConfig,
      [{ role: "user", content: buildMergePrompt(payload) }],
      callbacks,
      signal,
    )
    return text
  }

  const runSingleAgentFallback = async (): Promise<string> => {
    const result = await runDeepOutlineGeneration(
      {
        llmConfig,
        userRequest,
        context: [
          contextPack.outline,
          contextPack.soulDoc,
          contextPack.characterStates,
          contextPack.canonRules,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      {},
      undefined,
      signal,
    )
    return result.finalContent
  }

  return runOutlineMultiAgentWorkflow({
    plan,
    maxConcurrency,
    runSubAgent,
    runSingleAgentFallback,
    mergeResults,
    onStatusChange,
  })
}
