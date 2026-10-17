/**
 * 主控 Agent（阶段 1）：一句话目标 → 规划 → 只读工具收集上下文 → 起草到草稿区。
 *
 * 硬边界：
 * - 只注册只读工具 + `write_chapter`（draftMode=true），正式正文与正式记忆一律不直写，
 *   落盘仍须走既有 accept 流程（Draft-first）。
 * - `run_chapter_workflow` 需要注入 `runDeepChapterGeneration`（深章流水线），阶段 1 不注入，
 *   该工具因此不会注册——质量迭代闭环在后续阶段接线。
 * - 不读时钟做逻辑判定，时间只用于轨迹展示；遥测走注入式 sink（未安装时 no-op）。
 */
import { buildAgentConfig } from "@/lib/agent/config"
import { ToolRegistry } from "@/lib/agent/registry"
import { AgentRunner } from "@/lib/agent/runner"
import type { AgentMessage, AgentRunCallbacks, AgentRunRecord } from "@/lib/agent/types"
import type { QualityToolDeps } from "@/lib/agent/tools/score-chapter"
import type { LlmConfig } from "@/stores/wiki-store"
import { recordModuleHit } from "./module-heat"

/** 阶段 1 允许的工具：只读 + 草稿写入。 */
/** 质量闭环工具（仅在调用方注入 scoreChapter/reviseChapter 时才注册）。 */
export const MAIN_CONTROL_QUALITY_TOOLS = ["score_chapter", "revise_chapter"] as const

export const MAIN_CONTROL_TOOLS = [
  "read_chapter",
  "list_chapters",
  "search_chapters",
  "read_memory",
  "list_memories",
  "read_deduction",
  "list_deductions",
  "read_outline",
  "list_outlines",
  "read_outline_history",
  "load_context",
  "route_task",
  "write_chapter",
] as const

export const MAIN_CONTROL_SYSTEM_PROMPT = `你是 Niko Buddy 的主控 Agent（阶段 1：只读 + 草稿）。

工作方式：
1. 先用只读工具把上下文取全（章节列表 → 相关章节正文 → 记忆/大纲/上下文包），不要凭想象写作。
2. 用两三句话给出执行计划，再动手。
3. 需要产出正文时，只能调用 write_chapter——它写入草稿区，等用户确认后才进正式库。绝不可声称已写入正式章节或正式记忆。
4. 拿不到的信息如实说明缺失，不要编造设定、人物或既定事实。
5. 收尾时用一段话汇报：做了哪些工具调用、产出草稿在哪、还有哪些需要用户确认。`

export interface MainControlStep {
  callId: string
  name: string
  params: Record<string, unknown>
  status: "running" | "done" | "error"
  result?: string
  error?: string
  at: number
}

export interface MainControlDraft {
  id: string
  chapterName: string
  words?: number
}

export interface MainControlResult {
  ok: boolean
  finalText: string
  steps: MainControlStep[]
  drafts: MainControlDraft[]
  roundsUsed: number
  error?: string
}

export interface MainControlDeps {
  /** 测试注入：替代真实 AgentRunner。 */
  runner?: { run: AgentRunner["run"] }
  /** 测试注入：替代真实工具注册（默认动态加载内置工具工厂）。 */
  registry?: ToolRegistry
  now?: () => number
}

export interface RunMainControlOptions {
  projectPath: string
  wikiPath: string
  goal: string
  llmConfig: LlmConfig
  /** 会话模型标识；缺省取 llmConfig.model。 */
  modelId?: string
  /** 注入后额外注册 score_chapter / revise_chapter，让 Agent 自己迭代到目标分。 */
  quality?: QualityToolDeps
  maxRounds?: number
  signal?: AbortSignal
  onStep?: (step: MainControlStep) => void
  deps?: MainControlDeps
}

/** 从 write_chapter 的回执里解析草稿（草稿 ID / 章节名 / 字数）。 */
export function parseDraftReceipts(texts: readonly string[]): MainControlDraft[] {
  const drafts: MainControlDraft[] = []
  for (const text of texts) {
    const id = text.match(/草稿ID[:：]\s*(\S+)/)?.[1]
    if (!id) continue
    const chapterName = text.match(/草稿[「"]([^」"]+)[」"]/)?.[1] ?? ""
    const words = Number(text.match(/字数[:：]\s*(\d+)/)?.[1] ?? Number.NaN)
    drafts.push({ id, chapterName, words: Number.isFinite(words) ? words : undefined })
  }
  return drafts
}

/** 项目 wiki 根：优先 `<project>/wiki`，否则退回项目根（单目录布局）。 */
export function resolveWikiPath(
  projectPath: string,
  exists: (path: string) => Promise<boolean>,
): Promise<string> {
  const root = projectPath.replace(/[\/]+$/, "")
  const candidate = `${root}/wiki`
  return exists(candidate).then((ok) => (ok ? candidate : root))
}

export async function runMainControlAgent(options: RunMainControlOptions): Promise<MainControlResult> {
  const goal = options.goal.trim()
  if (!goal) {
    return { ok: false, finalText: "", steps: [], drafts: [], roundsUsed: 0, error: "目标为空" }
  }
  const now = options.deps?.now ?? Date.now
  const steps: MainControlStep[] = []
  const running = new Map<string, MainControlStep>()

  const emit = (step: MainControlStep) => {
    options.onStep?.({ ...step })
  }

  let finalText = ""
  let runError: string | undefined
  let fatal: Error | undefined

  const callbacks: AgentRunCallbacks = {
    onText: (chunk) => {
      finalText += chunk
    },
    onToolCall: (call) => {
      const step: MainControlStep = {
        callId: call.id,
        name: call.name,
        params: call.arguments ?? {},
        status: "running",
        at: now(),
      }
      running.set(call.id, step)
      steps.push(step)
      emit(step)
    },
    onToolResult: (callId, result) => {
      const step = running.get(callId)
      if (!step) return
      step.status = "done"
      step.result = result
      emit(step)
    },
    onToolError: (callId, error) => {
      const step = running.get(callId)
      if (!step) return
      step.status = "error"
      step.error = error
      emit(step)
    },
    onDone: () => {},
    onError: (error) => {
      runError = error.message
      fatal = error
    },
  }

  const registry = options.deps?.registry ?? new ToolRegistry()
  const runner = options.deps?.runner ?? new AgentRunner()
  // 走既有 agent 配置装配：清空并注册内置工具（尊重 function-calling 开关与 provider 差异），
  // 主控阶段 1 只用 enabledToolNames 白名单里的只读工具 + 草稿写入。
  const config = buildAgentConfig(
    options.modelId ?? options.llmConfig.model,
    MAIN_CONTROL_SYSTEM_PROMPT,
    registry,
    {
      wikiPath: options.wikiPath,
      projectPath: options.projectPath,
      draftMode: true,
      qualityIteration: options.quality,
      enabledToolNames: options.quality
        ? [...MAIN_CONTROL_TOOLS, ...MAIN_CONTROL_QUALITY_TOOLS]
        : [...MAIN_CONTROL_TOOLS],
      llmConfig: options.llmConfig,
      getSkillConfig: () => null,
      getChatConversations: () => [],
      getOutlineConversations: () => [],
      virtualToolContext: { userMessage: goal, projectPath: options.projectPath },
    },
  )
  config.maxRounds = options.maxRounds ?? 8
  config.taskGoal = goal

  const messages: AgentMessage[] = [
    { role: "system", content: MAIN_CONTROL_SYSTEM_PROMPT },
    { role: "user", content: goal },
  ]

  let record: AgentRunRecord | undefined
  try {
    record = await runner.run(config, registry, messages, callbacks, options.signal)
  } catch (err) {
    if (!fatal) runError = err instanceof Error ? err.message : String(err)
  }

  const steps2 = record?.toolCalls?.length
    ? record.toolCalls.map((call) => ({
        callId: call.id,
        name: call.name,
        params: call.params ?? {},
        status: (call.status === "error" ? "error" : "done") as MainControlStep["status"],
        result: call.result,
        at: running.get(call.id)?.at ?? now(),
      }))
    : steps

  const drafts = parseDraftReceipts(steps2.map((s) => s.result ?? ""))
  const final = (record?.finalText || finalText).trim()
  const ok = !runError && (final.length > 0 || drafts.length > 0)

  recordModuleHit({
    path: "src/lib/novel/main-control.ts",
    at: now(),
    ok,
    detail: `主控 Agent：${steps2.length} 次工具调用 · ${drafts.length} 份草稿`,
  })

  return {
    ok,
    finalText: final,
    steps: steps2,
    drafts,
    roundsUsed: record?.roundsUsed ?? 0,
    error: runError,
  }
}
