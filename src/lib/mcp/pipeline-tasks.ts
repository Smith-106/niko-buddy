/**
 * MCP 长任务登记表（方案 `d23eb1df` P2）。
 *
 * ## 为什么必须有它
 *
 * 深章管线跑一章要几分钟。MCP 是请求-响应协议，状态桥默认 15s 超时——同步等
 * 必然超时，超时后前端还在跑、调用方以为失败，是最糟的一种不一致。所以
 * `pipeline.run_chapter` **只负责起任务并立刻返回 taskId**，结果靠
 * `pipeline.status` 轮询。
 *
 * ## 为什么放在前端
 *
 * 深章管线的唯一实现在 `src/lib/novel/deep-chapter-generation.ts`（TypeScript）。
 * 在 Rust 侧重写一份就是第二套真源——两套管线迟早给出不同结果，而"哪个才是本章
 * 的门控结论"将无从判断。这里只做登记与转发，一行生成逻辑都不复制。
 *
 * ## 硬边界
 *
 * 任务只把结果留在内存里给调用方**看**。正式正文与正式记忆一律不在此落盘：
 * 落盘仍须走 `writeDraft` → 用户 accept（Draft-first）。
 */

import { advanceDirectorToStall, buildStageJournalRuntime, loadDirectorPersisted, runDeepChapterGeneration, saveDirectorPersisted } from "@/lib/novel"
import type { DeepChapterDecisionGates, DeepChapterGenerationResult } from "@/lib/novel"
import { generateOutlineFile, generateOutlineFileMultiAgent } from "@/lib/novel/outline-generation"
import { refreshProjectState } from "@/lib/project-refresh"
import { useWikiStore } from "@/stores/wiki-store"
import { toErrorMessage } from "@/lib/utils"

export type PipelineTaskStatus = "running" | "done" | "failed"

/**
 * 任务种类。
 *
 * 三种任务共用一张登记表与同一个 `pipeline.status` 轮询入口：对调用方来说
 * 「等一个长任务」只有一种形状，不该因为它跑的是章节、导演阶段还是大纲而换 API。
 */
export type PipelineTaskKind = "chapter" | "director" | "outline"

/** 对外快照。**不含正文**——正文经草稿/章节读取工具取，避免两套内容出口。 */
export interface PipelineTaskSnapshot {
  taskId: string
  /** 任务种类（additive：老调用方不看这个字段也能工作）。 */
  kind?: PipelineTaskKind
  status: PipelineTaskStatus
  /** 当前阶段。来自管线自己的 checkpoint stage，不另造阶段名。 */
  stage: string
  startedAt: number
  finishedAt?: number
  /** 失败原因（已转成可读文本）。 */
  error?: string
  /** 管线给出的门控结论；未完成时缺省。 */
  gates?: DeepChapterDecisionGates
  manualReviewRequired?: boolean
  /** 是否被传输超时截断（必须走续写路径，不能当完成品）。 */
  partial?: boolean
  /** 正文字符数，仅用于让调用方判断产出规模。 */
  contentChars?: number
  /** 任务自述的产出位置（大纲路径、导演阶段号等）。不含正文。 */
  artifactPath?: string
  /** 本次推进到的导演阶段（`director.advance` 用）。 */
  phase?: string
  /** 该阶段是否真的推进了（门未过时为 false）。 */
  advanced?: boolean
  /** 本次任务实际推进了几个阶段。 */
  advancedCount?: number
}

interface PipelineTaskRecord {
  snapshot: PipelineTaskSnapshot
  result?: DeepChapterGenerationResult
}

/**
 * 统一的「起长任务」登记入口。
 *
 * 三类任务共用它，装任务记录 → 跑 runner → 回写终态/失败。参数校验留给各自的
 * starter（校验失败不该留下一个注定失败的任务）。
 */
function registerTask(
  kind: PipelineTaskKind,
  stage: string,
  runner: (record: PipelineTaskRecord) => Promise<Partial<PipelineTaskSnapshot>>,
): { taskId: string; stage: string } {
  const taskId = nextTaskId()
  const startedAt = Date.now()
  const record: PipelineTaskRecord = {
    snapshot: { taskId, kind, status: "running", stage, startedAt },
  }
  tasks.set(taskId, record)
  pruneIfNeeded()

  // 故意不 await：这是"起任务"而不是"跑任务"。任何同步等待都会撞上状态桥超时。
  void runner(record)
    .then((patch) => {
      record.snapshot = {
        ...record.snapshot,
        ...patch,
        status: "done",
        stage: "done",
        finishedAt: Date.now(),
      }
    })
    .catch((err: unknown) => {
      record.snapshot = {
        ...record.snapshot,
        status: "failed",
        stage: "failed",
        finishedAt: Date.now(),
        error: toErrorMessage(err),
      }
    })

  return { taskId, stage }
}

/**
 * 任务上限。超了丢最旧的**已完成**任务（运行中的永不丢——丢了就没法轮询）。
 * 定上限是为了让一个健忘的调用方不能把内存撑爆。
 */
const MAX_TASKS = 32

const tasks = new Map<string, PipelineTaskRecord>()

let seq = 0

function nextTaskId(): string {
  seq += 1
  return `ptask_${Date.now().toString(36)}_${seq.toString(36)}`
}

function pruneIfNeeded(): void {
  if (tasks.size <= MAX_TASKS) return
  for (const [id, rec] of tasks) {
    if (tasks.size <= MAX_TASKS) break
    if (rec.snapshot.status !== "running") tasks.delete(id)
  }
}

export interface StartPipelineTaskParams {
  userRequest?: unknown
  chapterNumber?: unknown
  workflowMode?: unknown
}

interface NormalizedChapterParams {
  userRequest: string
  chapterNumber?: number
  workflowMode?: "fast" | "standard" | "strict"
}

/**
 * 参数校验（不碰任何状态）。
 *
 * 抽出来是为了批量路径能「先全量校验、再统一起任务」：半个批次启动、半个批次
 * 报错是最难收拾的状态。
 */
function normalizeChapterParams(
  params: StartPipelineTaskParams,
): { ok: true; value: NormalizedChapterParams } | { ok: false; error: string } {
  const userRequest = typeof params.userRequest === "string" ? params.userRequest.trim() : ""
  if (!userRequest) {
    return { ok: false, error: "pipeline.run_chapter 需要非空字符串参数 userRequest" }
  }

  let chapterNumber: number | undefined
  if (params.chapterNumber !== undefined && params.chapterNumber !== null) {
    const n = typeof params.chapterNumber === "number" ? params.chapterNumber : Number(params.chapterNumber)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return { ok: false, error: `chapterNumber 必须是正整数，收到 ${JSON.stringify(params.chapterNumber)}` }
    }
    chapterNumber = n
  }

  let workflowMode: "fast" | "standard" | "strict" | undefined
  if (params.workflowMode !== undefined && params.workflowMode !== null) {
    const mode = params.workflowMode
    if (mode !== "fast" && mode !== "standard" && mode !== "strict") {
      return { ok: false, error: `workflowMode 只接受 fast / standard / strict，收到 ${JSON.stringify(mode)}` }
    }
    // 历史事实：深章管线（`DeepChapterGenerationInput`）没有深度参数，深度取自应用设置。
    // 这里仍接受并校验该字段（客户端契约不改），但不能声称它会影响生成长度。
    workflowMode = mode
  }

  return { ok: true, value: { userRequest, chapterNumber, workflowMode } }
}

/** 生成所需的两份配置（与 chat-panel / campaign-runner 同一来源）。 */
function requireGenerationContext():
  | { ok: true; projectPath: string; llmConfig: NonNullable<ReturnType<typeof useWikiStore.getState>["llmConfig"]>; novelConfig: ReturnType<typeof useWikiStore.getState>["novelConfig"] }
  | { ok: false; error: string } {
  const state = useWikiStore.getState()
  const projectPath = state.project?.path
  if (!projectPath) {
    return { ok: false, error: "没有打开的项目，无法生成章节" }
  }
  const llmConfig = state.llmConfig
  if (!llmConfig?.apiKey) {
    // 不打印 apiKey，也不判断它的内容——只判断"有没有"。
    return { ok: false, error: "尚未配置模型（缺少 apiKey），无法生成章节。请在应用设置里配置后再试。" }
  }
  return { ok: true, projectPath, llmConfig, novelConfig: state.novelConfig }
}

/**
 * 起一个深章生成任务，立刻返回 taskId。
 *
 * 参数校验在**起任务之前**完成：非法参数不应该留下一个注定失败的任务，
 * 那会让调用方以为"任务起来了，只是失败了"。
 */
export function startPipelineTask(
  params: StartPipelineTaskParams,
): { ok: true; taskId: string; stage: string } | { ok: false; error: string } {
  const normalized = normalizeChapterParams(params)
  if (!normalized.ok) return normalized
  const { userRequest, chapterNumber } = normalized.value
  const context = requireGenerationContext()
  if (!context.ok) return context
  const { projectPath, llmConfig, novelConfig } = context

  const { taskId, stage } = registerTask("chapter", "queued", (record) =>
    runDeepChapterGeneration(
      {
        projectPath,
        userRequest,
        chapterNumber,
        llmConfig,
        novelConfig,
      },
      {
        onCheckpoint: (checkpoint) => {
          record.snapshot.stage = String(checkpoint?.stage ?? record.snapshot.stage)
        },
      },
    ).then((result) => {
      record.result = result
      return {
        gates: result.decisionGates,
        manualReviewRequired: result.manualReviewRequired,
        partial: result.partial,
        contentChars: result.finalContent.length,
      }
    }),
  )

  return { ok: true, taskId, stage }
}

/** 一次批量最多起多少章（与 `chapter.batch` 工具的上限一致）。 */
export const MAX_BATCH_CHAPTERS = 10

/**
 * 一次起多章深章生成。
 *
 * 两阶段：先全量参数校验 + 生成上下文（项目/模型）校验，再逐个起任务。任何一项
 * 不过就整批不启动——半批启动、半批报错是最难收拾的状态。
 */
export function startPipelineBatch(
  params: { requests?: unknown },
):
  | { ok: true; tasks: { taskId: string; chapterNumber: number | null }[]; started: number }
  | { ok: false; error: string } {
  const requests = Array.isArray(params.requests) ? params.requests : []
  if (requests.length === 0) {
    return { ok: false, error: "pipeline-start-batch 需要非空数组 params.requests" }
  }
  if (requests.length > MAX_BATCH_CHAPTERS) {
    return { ok: false, error: `一次最多 ${MAX_BATCH_CHAPTERS} 章，收到 ${requests.length}` }
  }

  const normalized: NormalizedChapterParams[] = []
  for (let index = 0; index < requests.length; index += 1) {
    const item = requests[index]
    const candidate = (typeof item === "object" && item !== null ? item : {}) as StartPipelineTaskParams
    const checked = normalizeChapterParams(candidate)
    if (!checked.ok) {
      return { ok: false, error: `requests[${index}]: ${checked.error}` }
    }
    normalized.push(checked.value)
  }

  const context = requireGenerationContext()
  if (!context.ok) return context

  const tasks: { taskId: string; chapterNumber: number | null }[] = []
  for (const item of normalized) {
    const started = startPipelineTask(item)
    if (!started.ok) {
      // 到这一步只剩上下文类错误，它对整批是一样的：如实报出已启动几个。
      return { ok: false, error: `${started.error}（已启动 ${tasks.length} 个，其余未启动）` }
    }
    tasks.push({ taskId: started.taskId, chapterNumber: item.chapterNumber ?? null })
  }
  return { ok: true, tasks, started: tasks.length }
}

/**
 * 起一个导演阶段推进任务（一阶段或连续多阶段）。
 *
 * 生成与门判全部复用 `advanceDirectorAutomatically` / `saveDirectorPersisted`——
 * 与导演面板同一个函数，因此阶段产物、门输入与不可逆断言在两条路径上完全一致。
 * 面板能做的「等门未过」在这里表现为任务失败（error 里是原因），不会偷偷绕过门。
 */
export function startDirectorAdvanceTask(
  params: DirectorAdvanceTaskParams,
): { ok: true; taskId: string; stage: string } | { ok: false; error: string } {
  let maxPhases = 1
  if (params.maxPhases !== undefined && params.maxPhases !== null) {
    const n = typeof params.maxPhases === "number" ? params.maxPhases : Number(params.maxPhases)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 4) {
      return { ok: false, error: `maxPhases 必须是 1-4 的整数，收到 ${JSON.stringify(params.maxPhases)}` }
    }
    maxPhases = n
  }

  const brief =
    typeof params.brief === "string" && params.brief.trim() !== "" ? params.brief.trim() : undefined
  let targetVolumes: number | undefined
  if (params.targetVolumes !== undefined && params.targetVolumes !== null) {
    const n = typeof params.targetVolumes === "number" ? params.targetVolumes : Number(params.targetVolumes)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 30) {
      return { ok: false, error: `targetVolumes 必须是 1-30 的整数，收到 ${JSON.stringify(params.targetVolumes)}` }
    }
    targetVolumes = n
  }

  const state = useWikiStore.getState()
  const projectPath = state.project?.path
  if (!projectPath) {
    return { ok: false, error: "没有打开的项目，无法推进导演管线" }
  }
  const llmConfig = state.llmConfig
  if (!llmConfig?.apiKey) {
    return { ok: false, error: "尚未配置模型（缺少 apiKey），无法推进导演管线。" }
  }

  const { taskId, stage } = registerTask("director", "loading", async () => {
    const persisted = await loadDirectorPersisted(projectPath)
    const journal = buildStageJournalRuntime(projectPath, true)
    const { state, steps } = await advanceDirectorToStall(
      projectPath,
      persisted.ideaInput,
      {
        llmConfig,
        journal,
        ...(brief ? { brief } : {}),
        ...(targetVolumes ? { targetVolumes } : {}),
      },
      { state: persisted.state, maxSteps: maxPhases },
    )
    // 先落盘再判结果：失败也要把最后一个好阶段存下，否则面板与外部看到的状态不一致。
    await saveDirectorPersisted(projectPath, { ...persisted, state })
    const advancedCount = steps.filter((step) => step.advanced).length
    const last = steps[steps.length - 1]
    if (advancedCount === 0 && last && !last.completed) {
      throw new Error(last.error ?? last.blockedReason ?? last.gap ?? "阶段门未通过")
    }
    return { phase: state.currentPhase, advanced: advancedCount > 0, advancedCount }
  })

  return { ok: true, taskId, stage }
}

/**
 * 起一个大纲生成任务。
 *
 * 复用设置页大纲生成器的同一个 `generateOutlineFile`（多智能体时走
 * `generateOutlineFileMultiAgent`）：大纲是规划产物，落 `wiki/outlines`。
 */
export function startOutlineGenerationTask(
  params: OutlineGenerationTaskParams,
): { ok: true; taskId: string; stage: string } | { ok: false; error: string } {
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : ""
  if (!prompt) {
    return { ok: false, error: "outline.generate 需要非空字符串参数 prompt" }
  }

  const state = useWikiStore.getState()
  const projectPath = state.project?.path
  if (!projectPath) {
    return { ok: false, error: "没有打开的项目，无法生成大纲" }
  }
  const llmConfig = state.llmConfig
  if (!llmConfig?.apiKey) {
    return { ok: false, error: "尚未配置模型（缺少 apiKey），无法生成大纲。" }
  }

  const { taskId, stage } = registerTask("outline", "generating", async () => {
    const generated = params.multiAgent
      ? await generateOutlineFileMultiAgent(projectPath, llmConfig, prompt, new AbortController().signal)
      : await generateOutlineFile(projectPath, llmConfig, prompt, new AbortController().signal)
    await refreshProjectState(projectPath)
    return { artifactPath: generated.outlinePath, contentChars: generated.content.length }
  })

  return { ok: true, taskId, stage }
}

export interface DirectorAdvanceTaskParams {
  maxPhases?: unknown
  brief?: unknown
  targetVolumes?: unknown
}

export interface OutlineGenerationTaskParams {
  prompt?: unknown
  multiAgent?: unknown
}

/** 查任务快照。未知 id 返回 `null`（调用方据此报"未知 taskId"，不猜）。 */
export function getPipelineTask(taskId: string): PipelineTaskSnapshot | null {
  return tasks.get(taskId)?.snapshot ?? null
}

/** 清空登记表（测试用）。 */
export function resetPipelineTasks(): void {
  tasks.clear()
  seq = 0
}
