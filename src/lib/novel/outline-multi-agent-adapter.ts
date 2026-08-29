/**
 * v2 适配器：把大纲多智能体编排（outline-multi-agent-orchestrator，自 v3 提取的模式）
 * 接入 v2 现有 streamChat 与 deep-outline-generation 流水线。
 *
 * 纪律：编排核心为纯逻辑（依赖注入），本文件只做 v2 侧接线——
 * runSubAgent = 单次 streamChat（注入 scoped context + skill 提示词）；
 * mergeResults = 一次合并 streamChat；runSingleAgentFallback = 现有 runDeepOutlineGeneration。
 */
import { streamChat, type StreamCallbacks } from "@/lib/llm-client"
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

export interface OutlineMultiAgentAdapterInput {
  llmConfig: LlmConfig
  userRequest: string
  contextPack: ContextPack
  plan: OutlineSubAgentPlan[]
  maxConcurrency?: number
  onStatusChange?: (event: OutlineSubAgentStatusEvent) => void
  signal?: AbortSignal
}

export interface OutlineMultiAgentAdapterResult {
  mode: "multi-agent" | "single-agent-fallback"
  finalText: string
  successfulAgents: string[]
  failedAgents: string[]
  fallbackReason?: string
  failureDetails?: string[]
}

function buildSubAgentPrompt(plan: OutlineSubAgentPlan, scopedContext: string): string {
  const skills = plan.skillNames.length > 0 ? `\n可用技能：${plan.skillNames.join("、")}` : ""
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
  const { llmConfig, userRequest, contextPack, plan, maxConcurrency, onStatusChange, signal } = input

  const runSubAgent = async (subPlan: OutlineSubAgentPlan): Promise<string> => {
    const scoped = buildScopedOutlineSubAgentContext(contextPack, subPlan.kind)
    const prompt = buildSubAgentPrompt(subPlan, scoped)
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
