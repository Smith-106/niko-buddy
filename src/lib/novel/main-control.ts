/**
 * 主控 Agent（阶段 1）：一句话目标 → 规划 → 只读工具收集上下文 → 起草到草稿区。
 *
 * 硬边界：
 * - 只注册只读工具 + `write_chapter`（draftMode=true）+ 两类「不落盘」的生成工具：
 *   `score_chapter`/`revise_chapter`（quality 注入）与 `run_chapter_workflow`（深章流水线注入）。
 *   正式正文与正式记忆一律不直写，落盘仍须走既有 accept 流程（Draft-first）——
 *   `run_chapter_workflow` 自身只把正文交回调用方，保存仍需写入工具 + 用户确认。
 * - 未注入依赖的工具不注册（quality / 深章流水线各自独立开关）。
 * - 不读时钟做逻辑判定，时间只用于轨迹展示；遥测走注入式 sink（未安装时 no-op）。
 */
import { buildAgentConfig } from "@/lib/agent/config"
import { ToolRegistry } from "@/lib/agent/registry"
import { resolveRequiredToolsOnce } from "@/lib/agent/required-tools-gate"
import { AgentRunner } from "@/lib/agent/runner"
import type { AgentActivityEvent, AgentMessage, AgentRunCallbacks, AgentRunRecord } from "@/lib/agent/types"
import type { QualityToolDeps } from "@/lib/agent/tools/score-chapter"
import type { RunChapterWorkflowFallbackContext, RunDeepChapterGeneration } from "@/lib/agent/tools/run-chapter-workflow"
import type { AiWorkflowMode } from "@/lib/agent/workflow-mode"
import type { LlmConfig } from "@/stores/wiki-store"
import type { StageJournalRuntime } from "./stage-output-journal"
import { recordModuleHit } from "./module-heat"
import { routeTask } from "./task-router"
import type { NovelTaskIntent } from "./task-router"
import { useOutlineChatStore } from "@/stores/outline-chat-store"
import { toErrorMessage } from "@/lib/utils"

/** 质量闭环工具（仅在调用方注入 scoreChapter/reviseChapter 时才注册）。 */
export const MAIN_CONTROL_QUALITY_TOOLS = ["score_chapter", "revise_chapter"] as const

/** 深章流水线工具（仅在调用方注入 runDeepChapterGeneration 时才注册）。 */
export const MAIN_CONTROL_DEEP_TOOLS = ["run_chapter_workflow"] as const

/**
 * 主控工具白名单（只收窄不放大）。
 *
 * - `load_context` 保留：装配层已注入 `virtualToolContext.taskRoute`，它现在会真正注册
 *   （`registerAllBuiltInTools` 要求 `vtc.taskRoute` 存在），不再是一个永不出现的名字。
 * - `route_task` 已移出：主控内它的返回结果零消费者（模型自己调一次路由没有下游），
 *   意图路由由装配层直接算出并注入 `taskRoute`，不需要再让模型自己问一遍。
 * - `trim_context` 从未在此名单内：它要求 `vtc.contextPack`，而主控不构建 contextPack，
 *   注册条件永远不成立；因此「从白名单移除」对它而言是空操作（现状即不含）。
 */
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
  /** 结束时间（分析耗时用；缺省表示未结束）。 */
  finishedAt?: number
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
  /**
   * D5=A：阶段过程事件独立通道（不伪造 MainControlStep，不污染 steps/toolCalls 语义）。
   * 仅在本次运行确实收到 onActivityEvent 时出现；缺失时调用方应显示「无阶段事件」而非伪造。
   */
  activities?: AgentActivityEvent[]
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
  /** 可选：本次运行只用其中列出的工具（交集于允许集合；未注入依赖的工具自动剔除）。 */
  enabledToolNames?: readonly string[]
  /** 注入后额外注册 score_chapter / revise_chapter，让 Agent 自己迭代到目标分。 */
  quality?: QualityToolDeps
  /** 注入后额外注册 run_chapter_workflow（深章流水线；正文仍不落盘）。 */
  runDeepChapterGeneration?: RunDeepChapterGeneration
  /** 深章流水线所需工作流模式；与 runDeepChapterGeneration 同时提供才会注册工具。 */
  aiWorkflowMode?: AiWorkflowMode
  /** 章节正文专用模型（缺省回退 llmConfig）。 */
  chapterWritingLlmConfig?: LlmConfig
  maxRounds?: number
  signal?: AbortSignal
  onStep?: (step: MainControlStep) => void
  /**
   * 阶段工件缓存运行时（G3）。缺省 undefined 时深章阶段不写工件缓存，
   * 行为与未接入前一致（R-07：可选注入，chat 路径零变更）。
   */
  stageJournal?: StageJournalRuntime
  /**
   * 门控武装用的结构化意图（RV-01）。**由调用方按来源显式给出**，装配层不做任何
   * 文本推断（旧的正则/否定词表/疑问句启发式已删除）。
   *
   * 缺省回落到 `taskRoute.intent`（`routeTask` 的结构化路由结果）。因此「写第 3 章」这类
   * 路由本身能判出的写作意图会武装；章节页交接模板「为「第N章 X」生成本章草稿」自 TASK-001
   * 起也由路由本体识别（锚定模板形状的正则），同样无需本字段。
   *
   * 本字段保留的意义：调用方**已经知道**写作意图、而路由本体判不出时（例如自由文本形态的
   * 交接/编排指令），可以显式给出，仍然不做任何文本猜测——不给就不武装。
   */
  gateIntent?: NovelTaskIntent
  /**
   * 已确认的章节计划来源（RV-03）。透传给 `run_chapter_workflow`，
   * 用于模型漏传 `planBlueprint` 时的会话层兜底。超长（>20000 字符）由工具侧
   * `normalizePlanBlueprint` 截断并加显式标记，装配层不改写文本。
   */
  getPlanBlueprint?: () => string | undefined
  /**
   * 必调工具兜底参数的结构化来源（RV-02）：章节号 + 已确认计划。
   * 缺省时章号回落到装配层已算出的 `taskRoute.chapterNumber`（结构化值，非文本推断），
   * 计划回落到 `getPlanBlueprint`。
   */
  getFallbackParams?: () => RunChapterWorkflowFallbackContext
  /**
   * 是否处于计划确认/收集阶段（RV-07）。该阶段禁止调用章节工作流，门控不武装。
   * 缺省 false：主控当前无计划确认阶段。**接线计划链时必须同时接线此字段**，
   * 否则计划收集阶段会被错误武装。
   */
  planExecuteActive?: boolean
  /**
   * 小说模式真源（RV-08）。门控与「是否注册深章工具」必须同源。
   * 缺省回落到 `Boolean(runDeepChapterGeneration)`——即「注入了深章流水线就是小说模式」，
   * 不再另读全局 store（两份状态可不一致）。
   */
  novelMode?: boolean
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

/**
 * F08：`read_outline_history` 的真实数据源——大纲对话 store
 * （`outline-chat-panel` 同一份状态，落盘在 `<project>/.niko-buddy/outline-chats.json`）。
 *
 * 存储路径由 store 自己从「当前打开的项目」解析（与应用内其它调用方同源），因此这里不另收
 * projectPath 参数，避免造一个「传了也没用」的形参。面板未打开过时 store 还没 hydrate
 * （`loaded === false`），这里补一次读盘：语义与面板挂载时的 `loadFromDisk` 完全一致
 * （无项目 / 文件缺失 / JSON 损坏一律留空，不伪造会话）。
 */
export async function loadOutlineConversations(): Promise<
  { id: string; title: string; messages: { role: string; content: string }[] }[]
> {
  if (!useOutlineChatStore.getState().loaded) {
    await useOutlineChatStore.getState().loadFromDisk()
  }
  return useOutlineChatStore.getState().conversations.map((conv) => ({
    id: conv.id,
    title: conv.title,
    messages: conv.messages.map((message) => ({ role: message.role, content: message.content })),
  }))
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
  // F04：主控入口与 chat 侧之间没有 prop 链路——chat 的 `effectiveTaskRoute` 是 `handleSend`
  // 里的局部常量，`MainControlView` 只收 projectId，没有任何 prop 能传到这里；而两边共用同一个
  // 纯函数 `routeTask`，就地推导等价且不另立第二套判定。
  // TASK-002：此前这里还套了一层 `buildMainControlTaskRoute`，用于补回 `routeTask` 早退分支
  // 丢掉的顶层章号。TASK-001 已让 general_chat 早退同样带顶层 `chapterNumber`，该补丁成为
  // no-op，已删除，装配层直接使用路由结果。
  // 后果（预期收益）：`load_context` 真正注册（依赖 `vtc.taskRoute`），`list_outlines` 的
  // `getDefaultChapterNumber` 也复活（读 `vtc.taskRoute.chapterNumber`）。
  const taskRoute = routeTask(goal)
  const outlineConversations = await loadOutlineConversations()
  const steps: MainControlStep[] = []
  const running = new Map<string, MainControlStep>()
  const activities: AgentActivityEvent[] = []

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
      step.finishedAt = now()
      emit(step)
    },
    onToolError: (callId, error) => {
      const step = running.get(callId)
      if (!step) return
      step.status = "error"
      step.error = error
      step.finishedAt = now()
      emit(step)
    },
    // D5=A：阶段事件只收集，不转成 step（toolCalls 语义与热力图统计不得被污染）。
    onActivityEvent: (event) => {
      activities.push(event)
    },
    onDone: () => {},
    onError: (error) => {
      runError = error.message
      fatal = error
    },
  }

  const registry = options.deps?.registry ?? new ToolRegistry()
  const runner = options.deps?.runner ?? new AgentRunner()
  const deepTools = options.runDeepChapterGeneration ? [...MAIN_CONTROL_DEEP_TOOLS] : []
  const qualityTools = options.quality ? [...MAIN_CONTROL_QUALITY_TOOLS] : []
  const allowed = new Set<string>([...MAIN_CONTROL_TOOLS, ...qualityTools, ...deepTools])
  // 可选收窄（不扩大）：调用方点名要用的工具子集，未注册的依赖工具自动剔除，
  // 因此 Draft-first 边界不会被这个参数放宽。目标写入体较小时能显著降低上下文压力。
  const requested = options.enabledToolNames?.filter((name) => allowed.has(name))
  const enabledToolNames = requested && requested.length > 0 ? requested : [...allowed]
  /**
   * RV-02：必调兜底的**结构化**来源。
   *
   * - 章号：`getFallbackParams().chapterNumber` 优先，缺省回落到装配层已算出的
   *   `taskRoute.chapterNumber`（路由结构化值，不是文本推断）。
   * - 计划：`getFallbackParams().planBlueprint` 优先，缺省回落到 `getPlanBlueprint`。
   * 两个字段都只在有值时才带，避免用 `undefined`/`0` 假填（下游 `chapterNumber ?? 0` 会跑错章）。
   */
  const resolveFallbackContext = (): RunChapterWorkflowFallbackContext => {
    const explicit = options.getFallbackParams?.()
    const chapterNumber = explicit?.chapterNumber ?? taskRoute.chapterNumber
    const planBlueprint = explicit?.planBlueprint ?? options.getPlanBlueprint?.()
    return {
      ...(typeof chapterNumber === "number" && Number.isFinite(chapterNumber) && chapterNumber > 0
        ? { chapterNumber }
        : {}),
      ...(typeof planBlueprint === "string" && planBlueprint ? { planBlueprint } : {}),
    }
  }
  // NF-01：武装确定性门控。runner 侧四道接线（nudge / 拒绝终稿 / 兜底重试 / 诊断记录）
  // 早已就绪，缺的一直是这里的输入——`config.requiredToolsOnce` 此前全仓无赋值点。
  //
  // 必须走 `resolveRequiredToolsOnce()` 而不是硬编码 ["run_chapter_workflow"]：
  // 该函数负责 intent（只认 OUTLINE_FIND_CHAPTER_INTENTS 四类章节写作意图）/ mode
  // （fast 不要求）/ enabledToolNames（工具没注册就不要求）/ novelMode / 计划阶段
  // 的折算，硬编码会把「审稿」「读第 3 章」这类非写作目标也一并拦住。
  //
  // RV-01：intent **只认结构化输入**——`options.gateIntent ?? taskRoute.intent`。
  // 旧实现在装配层用正则（草稿生成动词 + 章节引用 + 否定前缀）猜自由文本，实测 13/30 反例误命中
  // （「不需要生成本章草稿」「为什么要生成本章草稿？」等），一旦误武装，兜底会真的跑完整条
  // 深章流水线并把正文当答案交付。本层不再做任何形式的文本意图推断（正则/关键词表/启发式均无）。
  // TASK-002：章节页交接模板「为「第N章 X」生成本章草稿」自 TASK-001 起由路由本体识别
  // （`write_chapter.patterns` 里锚定模板形状的那条正则），不再需要调用方替路由补意图；
  // `gateIntent` 仍然保留——路由判不出、而调用方确知意图时用它显式给，不改变「不做文本推断」。
  //
  // 入参来源：
  // - intent：`options.gateIntent ?? taskRoute.intent`（结构化；不改写 taskRoute 本身）。
  // - mode：调用方传入的 aiWorkflowMode（main-control-view 传 resolveAiWorkflowMode）。
  // - enabledToolNames：上面算出的白名单；未注入 runDeepChapterGeneration 时它不含
  //   run_chapter_workflow，折算结果为 undefined，门控自然不武装。
  // - novelMode（RV-08）：单一真源。显式选项优先，缺省回落到「是否注入深章流水线」——
  //   工具是否注册与门控是否武装从此同一个信号，不再另读全局 wiki store（两份状态可不一致）。
  // - planExecuteActive（RV-07）：透传调用方给的阶段状态。主控当前无计划确认阶段（缺省 false）；
  //   接线计划链时必须同时接线此字段，否则计划收集阶段会被错误武装。
  const requiredToolsOnce = resolveRequiredToolsOnce({
    novelMode: options.novelMode ?? Boolean(options.runDeepChapterGeneration),
    intent: options.gateIntent ?? taskRoute.intent,
    mode: options.aiWorkflowMode ?? null,
    planExecuteActive: options.planExecuteActive ?? false,
    enabledToolNames,
  })
  // 走既有 agent 配置装配：清空并注册内置工具（尊重 function-calling 开关与 provider 差异），
  // 主控阶段只用 enabledToolNames 白名单里的只读工具 + 草稿写入（+ 不落盘的生成/评分工具）。
  const config = buildAgentConfig(
    options.modelId ?? options.llmConfig.model,
    MAIN_CONTROL_SYSTEM_PROMPT,
    registry,
    {
      wikiPath: options.wikiPath,
      projectPath: options.projectPath,
      draftMode: true,
      qualityIteration: options.quality,
      runDeepChapterGeneration: options.runDeepChapterGeneration,
      aiWorkflowMode: options.aiWorkflowMode,
      chapterWritingLlmConfig: options.chapterWritingLlmConfig ?? options.llmConfig,
      enabledToolNames,
      // G3：深章工具与主控共用同一个 activities 收集器（callbacks 早于本处定义）。
      onActivityEvent: callbacks.onActivityEvent,
      stageJournal: options.stageJournal,
      // RV-03：接通会话层兜底计划。此前全仓零生产赋值 → run-chapter-workflow 的
      // `options.getPlanBlueprint?.()` 恒 undefined，兜底是死代码。长度来源校验在工具侧
      // `normalizePlanBlueprint`（>20000 字符截断 + 显式标记），三条来源一次覆盖。
      getPlanBlueprint: options.getPlanBlueprint,
      // RVF-03：计划**落盘键**走装配层的结构化章号（`resolveFallbackContext` 已把
      // 显式选项 > 路由结构化值兜好），而不是只信模型 tool_call 里的 chapterNumber。
      // 否则写键（模型参数，可省略）与读键（UI 当前章）会分叉成两个文件，
      // 表现为「写了永远读不回」且用户无法诊断。
      getFallbackParams: resolveFallbackContext,
      llmConfig: options.llmConfig,
      /* v8 ignore next -- 台账 main-control.ts L376-377：白名单 12 项不含 read_chat_history/apply_skill，两桩无工具实例调用 */
      getSkillConfig: () => null,
      getChatConversations: () => [],
      getOutlineConversations: () => outlineConversations,
      virtualToolContext: { userMessage: goal, projectPath: options.projectPath, taskRoute },
    },
  )
  config.maxRounds = options.maxRounds ?? 8
  config.taskGoal = goal
  config.requiredToolsOnce = requiredToolsOnce

  // RV-02：把结构化兜底上下文（章号 + 已确认计划）接到已注册的 run_chapter_workflow 上。
  //
  // 为什么在注册后接线、而不是经 buildAgentConfig 透传：`ToolFactoryOptions`
  // （src/lib/agent/tools/index.ts）没有这个通道，本任务不允许改该文件；而必调兜底执行走
  // `registry.get(toolName)`（required-tool-fallback.ts），所以替换注册表里的工具实例即可让
  // `buildRequiredToolFallbackParams` 的第二参真正带上值。`config.tools` 同步替换，
  // 保证注册表与模型可见的工具表是同一个对象（参数 schema 由展开保留）。
  const fallbackTool = registry.get("run_chapter_workflow")
  const buildFallbackParams = fallbackTool?.buildRequiredToolFallbackParams as
    | ((input: { taskGoal: string }, context?: RunChapterWorkflowFallbackContext) => Record<string, unknown>)
    | undefined
  if (fallbackTool && buildFallbackParams) {
    const withFallbackContext = {
      ...fallbackTool,
      buildRequiredToolFallbackParams: (input: { taskGoal: string }) =>
        buildFallbackParams(input, resolveFallbackContext()),
    }
    registry.register(withFallbackContext)
    config.tools = config.tools.map((tool) =>
      tool.name === "run_chapter_workflow" ? withFallbackContext : tool,
    )
  }

  const messages: AgentMessage[] = [
    { role: "system", content: MAIN_CONTROL_SYSTEM_PROMPT },
    { role: "user", content: goal },
  ]

  let record: AgentRunRecord | undefined
  try {
    record = await runner.run(config, registry, messages, callbacks, options.signal)
  } catch (err) {
    if (!fatal) runError = toErrorMessage(err)
  }

  const steps2 = record?.toolCalls?.length
    ? record.toolCalls.map((call) => ({
        callId: call.id,
        name: call.name,
        params: call.params ?? {},
        status: (call.status === "error" ? "error" : "done") as MainControlStep["status"],
        result: call.result,
        at: running.get(call.id)?.at ?? now(),
        finishedAt: running.get(call.id)?.finishedAt ?? call.finishedAt,
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
    ...(activities.length > 0 ? { activities } : {}),
  }
}
