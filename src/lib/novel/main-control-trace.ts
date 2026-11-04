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
import type { AgentActivityEvent, AgentActivityKind } from "@/lib/agent/types"
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
  /** 1 = 仅有工具步骤（旧快照）；2 = 增 activities 投影。读取端两者均接受。 */
  fileVersion: 1 | 2
  goal: string
  savedAt: number
  /**
   * 上次运行是否成功。
   *
   * 可选（RV-06）：写入端永远落这个键，但读回端可能拿到「没有该键」的旧快照/外部改写过的
   * 文件——那种情况是「未知」，不是「未成功」，因此类型上必须允许 undefined，
   * 展示端据此三态渲染（true / false / 未知）。
   */
  ok?: boolean
  stopReason?: string
  roundsUsed: number
  finalText: string
  entries: TraceEntry[]
  /** 阶段事件投影（只留 kind/title/summary/at，content 截断 240 字，R-08 体积纪律）。 */
  activities?: MainControlTraceActivity[]
}

/** 快照里的阶段事件投影（不存 content 全文，需全文查 status.json / stage journal）。 */
export interface MainControlTraceActivity {
  kind: AgentActivityKind
  title: string
  summary: string
  at: number
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

function truncate240(text: string): string {
  return text.length > 240 ? `${text.slice(0, 240)}…` : text
}

function summarizeParams(params: Record<string, unknown>): string {
  const keys = Object.keys(params)
  if (keys.length === 0) return "（无参数）"
  return truncate240(JSON.stringify(params))
}

/** 阶段事件 → 快照投影（summary 复用 240 字口径）。 */
function projectActivity(event: AgentActivityEvent): MainControlTraceActivity {
  return {
    kind: event.kind,
    title: event.title,
    summary: truncate240(event.content),
    at: event.timestamp,
  }
}

export function buildTraceSnapshot(input: {
  goal: string
  ok: boolean
  stopReason?: string
  roundsUsed: number
  finalText: string
  steps: readonly MainControlStep[]
  /** D5=A：阶段过程事件（可选；不传则快照不带 activities 键，与旧快照形态一致）。 */
  activities?: readonly AgentActivityEvent[]
  now: number
}): MainControlTraceSnapshot {
  return {
    fileVersion: 2,
    goal: input.goal,
    savedAt: input.now,
    ok: input.ok,
    stopReason: input.stopReason,
    roundsUsed: input.roundsUsed,
    finalText: input.finalText,
    entries: buildTraceEntries(input.steps),
    ...(input.activities?.length ? { activities: input.activities.map(projectActivity) } : {}),
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

/** 快照读回状态：三种「读回」必须说成三件事（RV-06）。 */
export type TraceSnapshotStatus = "missing" | "corrupt" | "ready"

/** 读不到 / 读坏了的稳定原因码（文案由展示层映射，本模块不造中文）。 */
export type TraceSnapshotIssue =
  | "not_found"
  | "read_failed"
  | "invalid_json"
  | "unknown_version"
  | "invalid_entries"

/**
 * 读回快照的判别式结果（RV-06）。
 *
 * 旧签名是 `MainControlTraceSnapshot | null`：文件缺失 / JSON 损坏 / fileVersion 不认识 /
 * entries 非数组 四种原因都返回 null，面板只能一律渲染「还没有轨迹——运行一次后…」，
 * 也就是把「读坏了」说成「没跑过」——与假空态同类，只是方向相反。
 *
 * 向后兼容：`snapshot` 是可选字段，因此「只读条目」的调用点只需把 `x?.entries`
 * 换成 `x?.snapshot?.entries`（live-execution-view / pipeline-motion-view，已同步）；
 * 语义不变——只有 ready 才有 entries，missing / corrupt 都等于「没有可回放条目」，
 * 与旧 null 分支逐字节一致。
 */
export interface TraceSnapshotLoad {
  status: TraceSnapshotStatus
  /** missing / corrupt 的原因码；ready 时不存在。 */
  reason?: TraceSnapshotIssue
  /** 仅 status === "ready" 时存在。 */
  snapshot?: MainControlTraceSnapshot
}

/** 读盘失败是否属于「文件不存在」（其余读失败是真损坏，不能算「没跑过」）。 */
function isNotFoundError(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    text.includes("no such file") ||
    text.includes("not found") ||
    text.includes("os error 2") ||
    text.includes("不存在")
  )
}

/**
 * 读轨迹快照（判别式：missing / corrupt / ready）。
 *
 * 只有「文件确实不存在」才是 missing；读失败、JSON 损坏、版本不认识、entries 非数组
 * 一律是 corrupt 并带上原因码——四种原因不再合并成一个 null。
 */
export async function loadTraceSnapshot(projectPath: string): Promise<TraceSnapshotLoad> {
  let raw: string
  try {
    raw = await readFile(traceSnapshotPath(projectPath))
  } catch (error) {
    return isNotFoundError(error)
      ? { status: "missing", reason: "not_found" }
      : { status: "corrupt", reason: "read_failed" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: "corrupt", reason: "invalid_json" }
  }
  const snapshot = parsed as MainControlTraceSnapshot | null
  // v1 旧快照必须仍可回放（升级后第一次回放不得显示空轨迹）。
  if (!snapshot || (snapshot.fileVersion !== 1 && snapshot.fileVersion !== 2)) {
    return { status: "corrupt", reason: "unknown_version" }
  }
  if (!Array.isArray(snapshot.entries)) {
    return { status: "corrupt", reason: "invalid_entries" }
  }
  return { status: "ready", snapshot }
}
