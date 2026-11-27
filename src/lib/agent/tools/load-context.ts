import type { Tool } from "../types"
import { buildContextPack, contextPackToPrompt } from "@/lib/novel"
import type { ContextPack, TaskRouteResult } from "@/lib/novel"
import { toErrorMessage } from "@/lib/utils"

export interface LoadContextToolOptions {
  /** ContextPack 渲染 token 预算上限（默认 6000）。 */
  tokenBudget?: number
  /** 单分段字符软上限（默认 1600）。 */
  sectionCharBudget?: number
}

const DEFAULT_LOAD_CONTEXT_TOKEN_BUDGET = 6000
const DEFAULT_LOAD_CONTEXT_SECTION_CHAR_BUDGET = 1600

/** 非正文数据源的元数据/遥测字段，不计入非空数据源摘要。 */
const CONTEXT_PACK_METADATA_KEYS = new Set<string>([
  "task",
  "gaps",
  "hardInjectUsage",
  "kbRoutingGaps",
  "contextUsage",
  "sourceTimingsMs",
  "kbMetrics",
])

function resolvePositiveBudget(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

function listNonEmptySourceKeys(pack: ContextPack): string[] {
  const sources: string[] = []
  for (const [key, value] of Object.entries(pack)) {
    if (CONTEXT_PACK_METADATA_KEYS.has(key)) continue
    if (typeof value === "string") {
      if (value.trim().length > 0) sources.push(key)
    } else if (Array.isArray(value)) {
      if (value.length > 0) sources.push(key)
    } else if (value !== null && value !== undefined) {
      if (typeof value !== "object" || Object.keys(value as Record<string, unknown>).length > 0) {
        sources.push(key)
      }
    }
  }
  return sources
}

export function createLoadContextTool(
  projectPath: string,
  userMessage: string,
  taskRoute: TaskRouteResult,
  options?: LoadContextToolOptions,
): Tool {
  const tokenBudget = resolvePositiveBudget(options?.tokenBudget, DEFAULT_LOAD_CONTEXT_TOKEN_BUDGET)
  const sectionCharBudget = resolvePositiveBudget(
    options?.sectionCharBudget,
    DEFAULT_LOAD_CONTEXT_SECTION_CHAR_BUDGET,
  )

  return {
    name: "load_context",
    description:
      "虚拟工具：根据意图路由加载项目上下文（大纲、最近章节、记忆、伏笔等 21 个数据源）。由管道前置链自动执行，LLM 不直接调用。",
    category: "virtual",
    parameters: {},
    execute: async () => {
      try {
        const pack = await buildContextPack(projectPath, userMessage, taskRoute?.chapterNumber)
        const rendered = contextPackToPrompt(pack, tokenBudget, { sectionCharBudget }).trim()
        const nonEmptySources = listNonEmptySourceKeys(pack)
        const summary = nonEmptySources.length > 0
          ? `【上下文数据源摘要】已加载 ${nonEmptySources.length} 个非空数据源：${nonEmptySources.join("、")}`
          : "【上下文数据源摘要】当前项目暂无可用非空上下文数据源"
        return rendered ? `${rendered}\n\n${summary}` : summary
      } catch (e) {
        return `错误：加载上下文失败 - ${toErrorMessage(e)}`
      }
    },
  }
}
