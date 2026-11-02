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

import { runDeepChapterGeneration } from "@/lib/novel"
import type { DeepChapterDecisionGates, DeepChapterGenerationResult } from "@/lib/novel"
import { useWikiStore } from "@/stores/wiki-store"
import { toErrorMessage } from "@/lib/utils"

export type PipelineTaskStatus = "running" | "done" | "failed"

/** 对外快照。**不含正文**——正文经草稿/章节读取工具取，避免两套内容出口。 */
export interface PipelineTaskSnapshot {
  taskId: string
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
}

interface PipelineTaskRecord {
  snapshot: PipelineTaskSnapshot
  result?: DeepChapterGenerationResult
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

/**
 * 起一个深章生成任务，立刻返回 taskId。
 *
 * 参数校验在**起任务之前**完成：非法参数不应该留下一个注定失败的任务，
 * 那会让调用方以为"任务起来了，只是失败了"。
 */
export function startPipelineTask(
  params: StartPipelineTaskParams,
): { ok: true; taskId: string; stage: string } | { ok: false; error: string } {
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

  if (params.workflowMode !== undefined && params.workflowMode !== null) {
    const mode = params.workflowMode
    if (mode !== "fast" && mode !== "standard" && mode !== "strict") {
      return { ok: false, error: `workflowMode 只接受 fast / standard / strict，收到 ${JSON.stringify(mode)}` }
    }
  }

  // 生成所需的两份配置取自 store（与 chat-panel / campaign-runner 同一来源）。
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

  const taskId = nextTaskId()
  const startedAt = Date.now()
  const record: PipelineTaskRecord = {
    snapshot: { taskId, status: "running", stage: "queued", startedAt },
  }
  tasks.set(taskId, record)
  pruneIfNeeded()

  // 故意不 await：这是"起任务"而不是"跑任务"。任何同步等待都会撞上状态桥超时。
  void runDeepChapterGeneration(
    {
      projectPath,
      userRequest,
      chapterNumber,
      llmConfig,
      novelConfig: state.novelConfig,
    },
    {
      onCheckpoint: (checkpoint) => {
        record.snapshot.stage = String(checkpoint?.stage ?? record.snapshot.stage)
      },
    },
  )
    .then((result) => {
      record.result = result
      record.snapshot = {
        ...record.snapshot,
        status: "done",
        stage: "done",
        finishedAt: Date.now(),
        gates: result.decisionGates,
        manualReviewRequired: result.manualReviewRequired,
        partial: result.partial,
        contentChars: result.finalContent.length,
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

  return { ok: true, taskId, stage: "queued" }
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
