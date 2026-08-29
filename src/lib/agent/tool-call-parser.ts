import type { ToolCallDelta } from "./types"
import type { ToolCall } from "../llm-providers"

export function accumulateToolCalls(deltas: ToolCallDelta[]): ToolCall[] {
  const groups = new Map<number, { id: string; name: string; argsChunks: string[] }>()

  for (const delta of deltas) {
    const group = groups.get(delta.index) || { id: "", name: "", argsChunks: [] }
    if (delta.id) group.id = delta.id
    if (delta.name) group.name = delta.name
    if (delta.arguments) group.argsChunks.push(delta.arguments)
    groups.set(delta.index, group)
  }

  return Array.from(groups.values()).map((g) => {
    const argsStr = g.argsChunks.join("")
    return {
      id: g.id,
      type: "function" as const,
      function: {
        name: g.name,
        arguments: argsStr,
      },
    }
  })
}

function extractJsonCandidates(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  const candidates: string[] = []
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]?.trim()) {
    candidates.push(fenced[1].trim())
  }

  const firstObj = trimmed.indexOf("{")
  const lastObj = trimmed.lastIndexOf("}")
  if (firstObj >= 0 && lastObj > firstObj) {
    candidates.push(trimmed.slice(firstObj, lastObj + 1))
  }

  const firstArr = trimmed.indexOf("[")
  const lastArr = trimmed.lastIndexOf("]")
  if (firstArr >= 0 && lastArr > firstArr) {
    candidates.push(trimmed.slice(firstArr, lastArr + 1))
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    candidates.unshift(trimmed)
  }

  return [...new Set(candidates)]
}

function stringifyArguments(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return "{}"
    try {
      JSON.parse(trimmed)
      return trimmed
    } catch {
      return JSON.stringify(value)
    }
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value)
  }
  return "{}"
}

function toolCallFromObject(
  raw: Record<string, unknown>,
  allowedToolNames: ReadonlySet<string>,
  index: number,
): ToolCall | null {
  const nestedFunction =
    raw.function && typeof raw.function === "object"
      ? (raw.function as Record<string, unknown>)
      : null

  const nameCandidate = [
    raw.name,
    raw.tool,
    raw.tool_name,
    nestedFunction?.name,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0)

  if (!nameCandidate) return null
  const name = nameCandidate.trim()
  if (!allowedToolNames.has(name)) return null

  const args =
    raw.arguments ??
    raw.parameters ??
    raw.input ??
    nestedFunction?.arguments ??
    nestedFunction?.parameters ??
    {}

  const id =
    (typeof raw.id === "string" && raw.id.trim()) ||
    (typeof nestedFunction?.id === "string" && nestedFunction.id.trim()) ||
    `text_call_${index}_${Date.now()}`

  return {
    id,
    type: "function",
    function: {
      name,
      arguments: stringifyArguments(args),
    },
  }
}

function collectToolCallsFromParsed(
  parsed: unknown,
  allowedToolNames: ReadonlySet<string>,
): ToolCall[] {
  if (Array.isArray(parsed)) {
    return parsed.flatMap((item, index) => {
      if (!item || typeof item !== "object") return []
      const call = toolCallFromObject(item as Record<string, unknown>, allowedToolNames, index)
      return call ? [call] : []
    })
  }

  if (!parsed || typeof parsed !== "object") return []
  const obj = parsed as Record<string, unknown>

  if (Array.isArray(obj.tool_calls)) {
    return collectToolCallsFromParsed(obj.tool_calls, allowedToolNames)
  }

  if (Array.isArray(obj.tools)) {
    return collectToolCallsFromParsed(obj.tools, allowedToolNames)
  }

  const single = toolCallFromObject(obj, allowedToolNames, 0)
  return single ? [single] : []
}

/**
 * cursor-api-proxy 等桥接层只能把 tools schema 注入 prompt，无法返回原生
 * tool_calls delta。从模型文本里解析 JSON 工具调用。
 */
export function parseTextToolCalls(
  text: string,
  allowedToolNames: ReadonlySet<string>,
): { toolCalls: ToolCall[]; residualText: string } {
  if (!text.trim() || allowedToolNames.size === 0) {
    return { toolCalls: [], residualText: text }
  }

  for (const candidate of extractJsonCandidates(text)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }

    const toolCalls = collectToolCallsFromParsed(parsed, allowedToolNames)
    if (toolCalls.length === 0) continue

    const residualText = text.includes(candidate)
      ? text.replace(candidate, "").replace(/```(?:json)?\s*```/gi, "").trim()
      : ""

    return { toolCalls, residualText }
  }

  return { toolCalls: [], residualText: text }
}
