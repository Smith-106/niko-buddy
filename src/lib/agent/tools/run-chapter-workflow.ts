import type { LlmConfig } from "@/stores/wiki-store"
import type { AiWorkflowMode } from "@/lib/agent/workflow-mode"
import type { DeepChapterGenerationCallbacks, DeepChapterGenerationDeps, DeepChapterGenerationInput, DeepChapterGenerationResult, StageJournalRuntime } from "@/lib/novel"
import type { ConsensusTrace } from "@/lib/novel"
import i18n from "@/i18n"
import type { AgentActivityEvent, AgentToolEvent, Tool, ToolExecutionContext } from "../types"

export type RunDeepChapterGeneration = (
  input: DeepChapterGenerationInput,
  callbacks?: DeepChapterGenerationCallbacks,
  deps?: DeepChapterGenerationDeps,
  signal?: AbortSignal,
  /**
   * 共识写作轨迹回调（RV-002 ①）。仅共识版 runner 会真的调用它；
   * 单模型版 runner 忽略第 5 参（签名兼容，行为零变更）。
   */
  onConsensusTrace?: (trace: ConsensusTrace) => void,
) => Promise<DeepChapterGenerationResult>

interface RunChapterWorkflowToolOptions {
  projectPath: string
  llmConfig: LlmConfig
  aiWorkflowMode: AiWorkflowMode
  runDeepChapterGeneration: RunDeepChapterGeneration
  onToolEvent?: (event: AgentToolEvent) => void
  onActivityEvent?: (event: AgentActivityEvent) => void
  /**
   * 阶段工件缓存运行时（G3）。缺省 undefined = 不写缓存，chat 路径行为逐字节不变（R-07）。
   */
  stageJournal?: StageJournalRuntime
  /**
   * 当 AI 未在工具调用参数中携带 planBlueprint 时，从这里兜底取已确认的章节计划。
   * 保证用户确认的计划为强制约束，不依赖模型是否遵守自然语言提示。
   */
  getPlanBlueprint?: () => string | undefined
  /**
   * 本轮已选定的写作 Skill 提示。不作为工具参数，避免模型漏传。
   */
  getSelectedSkillsPrompt?: () => string | undefined
  /**
   * ISS-20260709-033: novelConfig 显式注入通道。提供时优先使用，
   * 缺省回退惰性读 UI store（向后兼容，行为等价）。
   */
  getNovelConfig?: () => import("@/stores/wiki-store").NovelConfig
}

interface RunChapterWorkflowParams {
  intent?: string
  userRequest?: string
  chapterNumber?: number
  workflowMode?: AiWorkflowMode
  planBlueprint?: string
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function normalizeParams(params: Record<string, unknown>): RunChapterWorkflowParams {
  return {
    intent: typeof params.intent === "string" ? params.intent : undefined,
    userRequest: typeof params.userRequest === "string" ? params.userRequest : undefined,
    chapterNumber: toNumber(params.chapterNumber),
    workflowMode:
      params.workflowMode === "fast" || params.workflowMode === "standard" || params.workflowMode === "strict"
        ? params.workflowMode
        : undefined,
    planBlueprint: typeof params.planBlueprint === "string" ? params.planBlueprint : undefined,
  }
}

/**
 * 共识轨迹 → 阶段事件（RV-002 ①）。
 *
 * 与深章阶段产出（stage_output）走同一个 `onActivityEvent` 通道；标题与字段名全走
 * i18n 键。不重算胜者/分数：胜者由 consensus-aggregate 定，本函数只搬运。
 */
function buildConsensusActivity(trace: ConsensusTrace): AgentActivityEvent {
  const timestamp = Date.now()
  const parts = [
    `${i18n.t("mainControl.consensusSeatCount")}: ${trace.seatCount}`,
    `${i18n.t("mainControl.consensusDebateRounds")}: ${trace.debateRounds}`,
    `${i18n.t("mainControl.consensusWinner")}: ${trace.winner}`,
  ]
  if (trace.failedSeats.length > 0) {
    parts.push(`${i18n.t("mainControl.consensusFailedSeats")}: ${trace.failedSeats.join(", ")}`)
  }
  return {
    id: `consensus_writing:${timestamp}`,
    stageId: "consensus_writing",
    kind: "analysis",
    title: i18n.t("mainControl.consensusTitle"),
    content: parts.join(" · "),
    timestamp,
  }
}

export function createRunChapterWorkflowTool(options: RunChapterWorkflowToolOptions): Tool {
  return {
    name: "run_chapter_workflow",
    description: [
      "运行小说章节写作工作流。用于生成、续写、改写或润色章节。",
      "调用后会读取项目上下文、生成写作任务书、生成正文，并按当前模式执行审稿、返修和去AI味。",
      "正文由本工具直接交付给用户，调用成功后本轮任务即结束：不要复述、改写或补充正文。",
      "一次调用只处理一章；保存到项目文件仍需要写入工具和用户确认。",
    ].join("\n"),
    category: "action",
    permission: "auto",
    executeTimeoutMs: 0,
    finalizesRun: true,
    buildRequiredToolFallbackParams: ({ taskGoal }) => ({
      userRequest: taskGoal,
    }),
    parameters: {
      intent: {
        type: "string",
        description: "章节任务类型：write_chapter、continue_chapter、rewrite_chapter 或 polish_chapter。",
        enum: ["write_chapter", "continue_chapter", "rewrite_chapter", "polish_chapter"],
      },
      userRequest: {
        type: "string",
        description: "用户原始章节写作请求，必须完整保留。",
        required: true,
      },
      chapterNumber: {
        type: "integer",
        description: "目标章节号，无法确定时可以省略。",
      },
      workflowMode: {
        type: "string",
        description: "执行强度：fast、standard 或 strict。省略时使用当前 AI 会话模式。",
        enum: ["fast", "standard", "strict"],
      },
      planBlueprint: {
        type: "string",
        description:
          "用户在会话层已确认的章节计划原文。若存在，必须完整透传，作为写作任务书的权威依据；不得改写或省略。",
      },
    },
    async execute(rawParams, signal, context?: ToolExecutionContext) {
      const params = normalizeParams(rawParams)
      const rawUserRequest = params.userRequest
      const userRequest = typeof rawUserRequest === "string" ? rawUserRequest.trim() : undefined
      if (!userRequest) {
        return "错误：缺少 userRequest，无法运行章节工作流。"
      }

      // F07（R04=a）：用户确认的章节计划必须进入生成链，优先级：
      //   显式工具参数 params.planBlueprint > options.getPlanBlueprint?.()（会话层兜底）。
      // 两者都缺 → undefined（生成链零行为变更）；原样透传，不 trim/不截断/不改写。
      const planBlueprint = params.planBlueprint ?? options.getPlanBlueprint?.()
      // 本轮未接线（无消费点，保持现状，避免造第二个静默丢弃）：
      //   - params.intent / params.workflowMode 仍只被 normalizeParams 解析、不传入生成链。
      //     DeepChapterGenerationInput 无对应字段，也没有任何阶段读它们；
      //     若将来接线，需同时提供消费点，不得只透传到结构体。
      const rawChapterNumber = params.chapterNumber
      // ISS-20260709-033: novelConfig 注入优先（getNovelConfig），缺省回退原惰性
      // store 读取（向后兼容，行为等价）。
      const novelConfig = options.getNovelConfig
        ? options.getNovelConfig()
        : (await import("@/stores/wiki-store")).useWikiStore.getState().novelConfig
      const result = await options.runDeepChapterGeneration(
        {
          projectPath: options.projectPath,
          userRequest,
          chapterNumber: typeof rawChapterNumber === "number" ? rawChapterNumber : undefined,
          // F07: 用户确认的章节计划（缺省 undefined → 生成链行为零变更）。
          planBlueprint,
          llmConfig: options.llmConfig,
          novelConfig,
          // 55 号设计 W1-1 (54⑧ 收尾): 题材透传 (undefined → 生成链零行为变更)。
          genre: novelConfig.genre,
          // G3：阶段日志条件展开（缺省不含该键 → chat 路径行为逐字节不变，R-07）。
          ...(options.stageJournal ? { stageJournal: options.stageJournal } : {}),
        },
        {
          // 终稿直接交付给会话，避免外层模型再复述一遍正文。
          // 履约修复会再次触发，后一次覆盖前一次。
          onFinalContent: (content) => {
            const body = content.trim()
            if (body) context?.onFinalContent?.(body)
          },
          // G3：深章阶段产出进主控阶段观测（content 截断 240 字，与 trace 同口径，R-08）。
          // 未注入 onActivityEvent 时 optional chaining 直接跳过，零副作用。
          onThinking: (content) => {
            const body = content.trim()
            if (!body) return
            const timestamp = Date.now()
            options.onActivityEvent?.({
              id: `run_chapter_workflow:thinking:${timestamp}`,
              stageId: "run_chapter_workflow",
              kind: "stage_output",
              title: "深章阶段产出",
              content: body.length > 240 ? `${body.slice(0, 240)}…` : body,
              timestamp,
            })
          },
        },
        undefined,
        signal,
        // RV-002 ①：共识轨迹也进同一 activities 通道（单模型 runner 忽略此参）。
        (trace) => {
          options.onActivityEvent?.(buildConsensusActivity(trace))
        },
      )

      return [
        "章节工作流完成。",
        `是否返修：${result.revised ? "是" : "否"}`,
        `任务书：${result.taskBrief}`,
        "executionReport" in result && (result as { executionReport?: string }).executionReport
          ? `执行报告：\n${(result as { executionReport?: string }).executionReport}`
          : "",
        "planCompliance" in result && (result as { planCompliance?: string }).planCompliance
          ? `计划履约度：\n${(result as { planCompliance?: string }).planCompliance}`
          : "",
        "",
        "最终正文：",
        result.finalContent,
      ].filter((line) => line !== "").join("\n")
    },
  }
}
