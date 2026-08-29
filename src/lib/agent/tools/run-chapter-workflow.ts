import type { LlmConfig } from "@/stores/wiki-store"
import type { AiWorkflowMode } from "@/lib/agent/workflow-mode"
import type {
  DeepChapterGenerationCallbacks,
  DeepChapterGenerationDeps,
  DeepChapterGenerationInput,
  DeepChapterGenerationResult,
} from "@/lib/novel/deep-chapter-generation"
import type { AgentActivityEvent, AgentToolEvent, Tool, ToolExecutionContext } from "../types"

export type RunDeepChapterGeneration = (
  input: DeepChapterGenerationInput,
  callbacks?: DeepChapterGenerationCallbacks,
  deps?: DeepChapterGenerationDeps,
  signal?: AbortSignal,
) => Promise<DeepChapterGenerationResult>

interface RunChapterWorkflowToolOptions {
  projectPath: string
  llmConfig: LlmConfig
  aiWorkflowMode: AiWorkflowMode
  runDeepChapterGeneration: RunDeepChapterGeneration
  onToolEvent?: (event: AgentToolEvent) => void
  onActivityEvent?: (event: AgentActivityEvent) => void
  /**
   * 当 AI 未在工具调用参数中携带 planBlueprint 时，从这里兜底取已确认的章节计划。
   * 保证用户确认的计划为强制约束，不依赖模型是否遵守自然语言提示。
   */
  getPlanBlueprint?: () => string | undefined
  /**
   * 本轮已选定的写作 Skill 提示。不作为工具参数，避免模型漏传。
   */
  getSelectedSkillsPrompt?: () => string | undefined
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
      const params = normalizeParams(rawParams) as Record<string, unknown>
      const rawUserRequest = params.userRequest
      const userRequest = typeof rawUserRequest === "string" ? rawUserRequest.trim() : undefined
      if (!userRequest) {
        return "错误：缺少 userRequest，无法运行章节工作流。"
      }

      // 兜底：AI 未在工具调用参数中携带 planBlueprint 时，从外部 getter 补上，
      // 保证用户确认的计划一定进入章节生成链路，不依赖模型是否遵守自然语言提示。
      const rawChapterNumber = params.chapterNumber
      const result = await options.runDeepChapterGeneration(
        {
          projectPath: options.projectPath,
          userRequest,
          chapterNumber: typeof rawChapterNumber === "number" ? rawChapterNumber : undefined,
          llmConfig: options.llmConfig,
          novelConfig: (await import("@/stores/wiki-store")).useWikiStore.getState().novelConfig,
        },
        {
          // 终稿直接交付给会话，避免外层模型再复述一遍正文。
          // 履约修复会再次触发，后一次覆盖前一次。
          onFinalContent: (content) => {
            const body = content.trim()
            if (body) context?.onFinalContent?.(body)
          },
        },
        undefined,
        signal,
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
