import type { LlmConfig } from "@/stores/wiki-store"
import type { AiWorkflowMode } from "@/lib/agent/workflow-mode"
import type { DeepChapterGenerationCallbacks, DeepChapterGenerationDeps, DeepChapterGenerationInput, DeepChapterGenerationResult, StageJournalRuntime } from "@/lib/novel"
import type { ConsensusTrace } from "@/lib/novel"
import { saveConfirmedPlan } from "@/lib/novel/confirmed-plan-store"
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

/**
 * 兜底参数的结构化来源（RV-02）。
 *
 * 必调工具兜底（`executeRequiredToolFallback`）此前只传 `{ userRequest: taskGoal }`，
 * `chapterNumber` 与 `planBlueprint` 双双丢失：下游 `input.chapterNumber ?? 0` 让前情分析 /
 * 上下文包锚点失效，确定性路径会跑错章。这里把两者作为**结构化字段**显式带上，
 * 来源只有调用方注入的 getter，不做任何文本推断。
 */
export interface RunChapterWorkflowFallbackContext {
  chapterNumber?: number
  planBlueprint?: string
}

/** 计划文本可信上限（字符）。超过即视为不可信（可能是模型复述被截断的产物）。 */
export const PLAN_BLUEPRINT_MAX_CHARS = 20000

/**
 * 超长计划的显式标记：截断后**必须**让下游知道这不是可「原样执行」的权威计划，
 * 否则截断片段会被当成完整计划硬套（比不传更糟）。
 */
const PLAN_BLUEPRINT_TRUNCATION_MARKER =
  "\n\n[计划原文超长，已截断：以上内容不完整，不得作为「必须原样执行」的权威计划；请以任务书为准并自行补全。]"

/**
 * 计划文本来源校验（RV-03）：不超过 20000 字符原样返回；超长则截断至 20000 字符
 * （含显式标记）后返回。
 *
 * 为什么需要：`getPlanBlueprint` / 模型参数 / 兜底 getter 三条来源都可能拿到模型复述的
 * 计划，超长基本等价于「被截断的复述」，其内容不可信；直接透传会让下游把残缺文本
 * 标成「必须原样执行」。校验放在**消费点**，三条来源一次覆盖。
 */
export function normalizePlanBlueprint(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined
  if (raw.length <= PLAN_BLUEPRINT_MAX_CHARS) return raw
  const keep = PLAN_BLUEPRINT_MAX_CHARS - PLAN_BLUEPRINT_TRUNCATION_MARKER.length
  return `${raw.slice(0, keep)}${PLAN_BLUEPRINT_TRUNCATION_MARKER}`
}

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
   * 当 AI 未在工具调用参数中携带 planBlueprint 时，从这里兜底取已保存的章节计划原文
   * （`.novel/plans/chapter-<N>.md`）。**它不是「用户确认的计划」**：真源是模型上一次
   * 在 tool_call 里自带的散文（RVF-01），所以它只作为参考进入提示词，不得冒充强制约束。
   */
  getPlanBlueprint?: () => string | undefined
  /**
   * 必调工具兜底参数的结构化来源（RV-02）：章节号 + 已保存计划。
   * 缺省时兜底参数只含 `userRequest`（与旧行为一致）；提供时必须真的带进参数，
   * 不得只加形参不填值。
   * RVF-03：其中的 `chapterNumber` 同时是计划**落盘**的优先章号（写键与读键同源）。
   */
  getFallbackParams?: () => RunChapterWorkflowFallbackContext
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

/** 落盘章号合法性：正整数（与 confirmed-plan-store 的守卫同口径）。 */
function isValidPlanChapterNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

/**
 * RVF-03：计划**落盘章号**的解析（写键必须与读键同源）。
 *
 * 问题：写键此前只看模型 tool_call 的 `chapterNumber`（schema 允许省略 → 省略即完全不落盘），
 * 而读键是 UI 的 `currentChapterNumber`（`selectedFile` 文件名优先）经 `getFallbackParams`
 * 结构化传下来的值。两者不同时 `chapter-12.md` 与 `chapter-3.md` 会分叉，**回读恒 miss**，
 * 而 UI 只能说「本次不带计划」——用户无从诊断；更糟的是写错章会把另一章的旧计划顶成
 * 该章的计划被读走。因此：
 *   ① 装配层给的结构化值优先（它就是读键的来源，同一参数也传给 `buildRequiredToolFallbackParams`）；
 *   ② 拿不到再用模型参数；
 *   ③ 两者都在且不一致 → 不落盘并记诊断（写错章比不写更糟）。
 */
function resolvePlanChapterNumber(
  modelChapterNumber: number | undefined,
  structuredChapterNumber: number | undefined,
): number | undefined {
  const model = isValidPlanChapterNumber(modelChapterNumber) ? modelChapterNumber : undefined
  const structured = isValidPlanChapterNumber(structuredChapterNumber) ? structuredChapterNumber : undefined
  if (model !== undefined && structured !== undefined && model !== structured) {
    console.warn(
      `[run-chapter-workflow] 章号不一致：模型参数=${model}、装配层结构化值=${structured}，本次不落盘计划（避免写错章后回读恒 miss）。`,
    )
    return undefined
  }
  return structured ?? model
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
    // RV-02：第二参是结构化兜底上下文（章节号 + 已确认计划）。
    // 缺省来源是 `options.getFallbackParams`；装配层也可以显式传入（见 main-control 的接线），
    // 两条路都不做文本推断。缺上下文时形状与旧行为逐字段相同（只有 userRequest）。
    buildRequiredToolFallbackParams: (
      { taskGoal },
      fallbackContext?: RunChapterWorkflowFallbackContext,
    ) => {
      const context = fallbackContext ?? options.getFallbackParams?.()
      const params: Record<string, unknown> = { userRequest: taskGoal }
      const chapterNumber = toNumber(context?.chapterNumber)
      if (chapterNumber !== undefined && chapterNumber > 0) params.chapterNumber = chapterNumber
      const planBlueprint = normalizePlanBlueprint(context?.planBlueprint)
      if (planBlueprint) params.planBlueprint = planBlueprint
      return params
    },
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
          "本轮/上一轮的章节计划原文（模型自拟，未经用户确认）。若存在，可完整透传作为写作参考；它不是用户确认的强制约束，与正文或大纲冲突时以大纲与用户请求为准。",
      },
    },
    async execute(rawParams, signal, context?: ToolExecutionContext) {
      const params = normalizeParams(rawParams)
      const rawUserRequest = params.userRequest
      const userRequest = typeof rawUserRequest === "string" ? rawUserRequest.trim() : undefined
      if (!userRequest) {
        return "错误：缺少 userRequest，无法运行章节工作流。"
      }

      // F07（R04=a）+ RVF-01：章节计划原文进生成链，优先级：
      //   显式工具参数 params.planBlueprint > options.getPlanBlueprint?.()（会话层兜底）。
      // 两者都缺 → undefined（生成链零行为变更）；不 trim、不改写。
      // 它是**模型自拟**的文本（未经用户确认）：提示词侧来源缺省也是 "model"，
      // 因此它不会被标成「用户已确认的强制约束」（RVF-01）。
      // RV-03：唯一的「改写」是来源校验——超过 PLAN_BLUEPRINT_MAX_CHARS 视为不可信，
      // 截断并加显式标记，保证传给生成链（deep-chapter-prompts 的 planBlueprintSection）
      // 的计划永不超长，也不会被标成「必须原样执行」的残缺权威文本。
      const planBlueprint = normalizePlanBlueprint(params.planBlueprint ?? options.getPlanBlueprint?.())
      // TASK-004（DEC-R4=A）：把「模型这次带过来的计划」落一份供后续复用/审计。
      // 这是「深章工具零写盘」边界里唯一一处**受控元数据写入例外**：只写计划原文
      // （外加 source/savedAt 两个标记），不写任何运行状态（无 ok/status/rounds/正文/
      // 审稿结论），也不参与本轮的生成决策——写的是下面同一个 planBlueprint 值，
      // 写盘与否都不改变 runDeepChapterGeneration 的入参。
      // 降级：写盘失败**不致命**，只记 warn 后继续生成（计划持久化是旁路，不是前置条件）。
      if (planBlueprint) {
        // RVF-03：写键优先取装配层结构化值（= 读键来源）；两值冲突则不落盘 + 记诊断。
        const planChapterNumber = resolvePlanChapterNumber(
          toNumber(params.chapterNumber),
          toNumber(options.getFallbackParams?.().chapterNumber),
        )
        if (planChapterNumber !== undefined) {
          try {
            // source 缺省 "model"：本工具写入的永远是模型自拟文本，不得升格成用户确认。
            await saveConfirmedPlan(options.projectPath, planChapterNumber, planBlueprint)
          } catch (error) {
            console.warn("[run-chapter-workflow] 计划持久化失败（非致命，不阻断生成）:", error)
          }
        }
      }
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
          // F07: 已保存的章节计划原文（缺省 undefined → 生成链行为零变更；
          // 它是模型自拟文本，提示词侧按中性口径呈现，不冒充用户确认约束）。
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
