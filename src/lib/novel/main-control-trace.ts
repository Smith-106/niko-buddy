/**
 * main-control-trace.ts — 主控 Agent 运行轨迹与工具证据（回放用）。
 *
 * 复用既有 `workflow-trace` 把工具调用规整成「步骤 + 明细」，并落一份最小轨迹快照
 * （`.novel/telemetry/main-control-trace.json`），使「任意一次运行」都能在面板里完整回放：
 * 输入摘要、结果、耗时、失败原因、原始证据全文。
 *
 * 纪律：遥测是过程产物，不是真源——读写失败一律 best-effort（不抛），覆盖写单文件。
 */
import { createDirectory, readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { buildAgentWorkflowSteps, type WorkflowToolCall } from "@/lib/agent/workflow-trace"
import type { MainControlStep } from "./main-control"

/** 轨迹快照相对路径（项目根下）。 */
export const MAIN_CONTROL_TRACE = ".novel/telemetry/main-control-trace.json"

export interface TraceEntry {
  callId: string
  name: string
  /** 输入摘要（参数 JSON 截断）。 */
  input: string
  /** 结果文本（完整保留，面板按需展开）。 */
  result?: string
  error?: string
  status: MainControlStep["status"]
  startedAt: number
  finishedAt?: number
  /** 耗时毫秒（缺 finishedAt 时省略）。 */
  durationMs?: number
  /** 该步在 workflow-trace 里的语义标题与摘要。 */
  title: string
  summary: string
  details: Array<{ label: string; value: string; tone?: string }>
}

export interface MainControlTraceSnapshot {
  fileVersion: 1
  goal: string
  savedAt: number
  ok: boolean
  stopReason?: string
  roundsUsed: number
  finalText: string
  entries: TraceEntry[]
}

export function traceSnapshotPath(projectPath: string): string {
  return `${normalizePath(projectPath).replace(/\/+$/, "")}/${MAIN_CONTROL_TRACE}`
}

/** 把主控步骤投影成 workflow-trace 认识的调用形态（补 startedAt/finishedAt）。 */
export function toWorkflowToolCalls(steps: readonly MainControlStep[]): WorkflowToolCall[] {
  return steps.map((step) => ({
    id: step.callId,
    name: step.name,
    params: step.params,
    result: step.error ?? step.result,
    status: step.status === "error" ? "error" : step.status === "running" ? "running" : "done",
    startedAt: step.at,
    finishedAt: step.finishedAt,
  }))
}

/** 生成可回放的轨迹条目（顺序 = 调用顺序）。 */
export function buildTraceEntries(steps: readonly MainControlStep[]): TraceEntry[] {
  const calls = toWorkflowToolCalls(steps)
  const semantic = buildAgentWorkflowSteps({ toolCalls: calls })
  return steps.map((step, index) => {
    const flow = semantic[index]
    const durationMs =
      step.finishedAt !== undefined ? Math.max(0, step.finishedAt - step.at) : undefined
    return {
      callId: step.callId,
      name: step.name,
      input: summarizeParams(step.params),
      result: step.result,
      error: step.error,
      status: step.status,
      startedAt: step.at,
      finishedAt: step.finishedAt,
      durationMs,
      title: flow?.title ?? step.name,
      summary: flow?.summary ?? "",
      details: (flow?.details ?? []).map((detail) => ({
        label: detail.label,
        value: detail.value,
        tone: detail.tone,
      })),
    }
  })
}

function summarizeParams(params: Record<string, unknown>): string {
  const keys = Object.keys(params)
  if (keys.length === 0) return "（无参数）"
  const text = JSON.stringify(params)
  return text.length > 240 ? `${text.slice(0, 240)}…` : text
}

export function buildTraceSnapshot(input: {
  goal: string
  ok: boolean
  stopReason?: string
  roundsUsed: number
  finalText: string
  steps: readonly MainControlStep[]
  now: number
}): MainControlTraceSnapshot {
  return {
    fileVersion: 1,
    goal: input.goal,
    savedAt: input.now,
    ok: input.ok,
    stopReason: input.stopReason,
    roundsUsed: input.roundsUsed,
    finalText: input.finalText,
    entries: buildTraceEntries(input.steps),
  }
}

/** 写轨迹快照；失败静默（遥测不得影响主流程）。 */
export async function saveTraceSnapshot(
  projectPath: string,
  snapshot: MainControlTraceSnapshot,
): Promise<boolean> {
  const path = traceSnapshotPath(projectPath)
  try {
    const dir = path.slice(0, path.lastIndexOf("/"))
    await createDirectory(dir)
    await writeFile(path, JSON.stringify(snapshot))
    return true
  } catch {
    return false
  }
}

/** 读轨迹快照；缺失/损坏返回 null。 */
export async function loadTraceSnapshot(
  projectPath: string,
): Promise<MainControlTraceSnapshot | null> {
  try {
    const raw = await readFile(traceSnapshotPath(projectPath))
    const parsed = JSON.parse(raw) as MainControlTraceSnapshot
    if (!parsed || parsed.fileVersion !== 1 || !Array.isArray(parsed.entries)) return null
    return parsed
  } catch {
    return null
  }
}
