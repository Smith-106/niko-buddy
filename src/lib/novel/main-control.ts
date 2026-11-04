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
import type { RunDeepChapterGeneration } from "@/lib/agent/tools/run-chapter-workflow"
import type { AiWorkflowMode } from "@/lib/agent/workflow-mode"
import type { LlmConfig } from "@/stores/wiki-store"
import type { StageJournalRuntime } from "./stage-output-journal"
import { recordModuleHit } from "./module-heat"
import { routeTask } from "./task-router"
import type { NovelTaskIntent, TaskRouteResult } from "./task-router"
import { useOutlineChatStore } from "@/stores/outline-chat-store"
import { useWikiStore } from "@/stores/wiki-store"
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

/**
 * 装配层就地推导主控的 `taskRoute`（F04）。
 *
 * 为什么不是从 chat 侧传：chat 的 `effectiveTaskRoute` 是 `handleSend` 里的局部常量，
 * 没有任何 prop 链路能到达主控入口（`MainControlView` 只收 projectId），而两边共用同一个
 * 纯函数 `routeTask`，就地推导等价且不另立第二套判定。
 *
 * 归一化（实测缺口）：`routeTask` 在无意图命中时走 early return，会把已提取的章号丢掉——
 * 只留在 `extractedParams.chapterNumber`，`chapterNumber` 字段为 undefined。章节页交接的真实
 * 文案「为「第12章 旧梦」生成本章草稿」正好落在这条分支（intent=general_chat）。
 * 装配层补回该字段，否则 `load_context` / `list_outlines` 拿到的章号仍是空，F04 的预期收益
 * 对主入口不成立。不改 `task-router.ts`：chat 侧共用它，改路由契约是独立决策。
 */
function buildMainControlTaskRoute(goal: string): TaskRouteResult {
  const routed = routeTask(goal)
  if (routed.chapterNumber !== undefined) return routed
  const fromParams = Number.parseInt(routed.extractedParams.chapterNumber ?? "", 10)
  return Number.isFinite(fromParams) && fromParams > 0
    ? { ...routed, chapterNumber: fromParams }
    : routed
}

/**
 * 草稿生成动词：`生成/写/撰写/起草/产出/输出` 之后 0~12 个非句读字符内出现「草稿」。
 *
 * 只认「动词在前、名词在后」的顺序：`把草稿区清空`、`本章草稿在哪` 这类
 * 名词在前的提及不命中（动词不作用于草稿）。
 */
const DRAFT_GENERATION_RE = /(生成|写|撰写|起草|产出|输出)[^。！？；!?;\n]{0,12}?草稿/

/**
 * 无章号时的章节指代：章节页交接文案在章节文件名没有「第N章」前缀时正是这种形态
 * （`buildChapterDraftGoal("旧梦")` → `为「旧梦」生成本章草稿`，routeTask 拿不到章号）。
 */
const CHAPTER_REFERENCE_RE = /本章|这一?章|当前章|该章/

/** 否定前缀：`不要生成本章草稿` 不算生成请求（与 task-router 的逐处否定守卫同向）。 */
const DRAFT_NEGATION_RE = /(不要|不用|不必|无需|别|甭|暂不|先别)[^。！？；!?;\n]{0,4}$/

/**
 * 是否为「给指定章节生成草稿」类目标（结构判定，只用于门控武装）。
 *
 * 两半都必须成立：**草稿生成动词** + **章节引用**（路由出的章号，或「本章」类指代）。
 * 缺任一半即不成立——这正是「读第 3 章」「第 12 章的大纲是什么」这类只有章号、
 * 没有生成动词的目标不会误武装的原因。
 */
function isChapterDraftGoal(goal: string, taskRoute: TaskRouteResult): boolean {
  const text = goal.replace(/\s+/g, " ")
  const match = DRAFT_GENERATION_RE.exec(text)
  if (!match) return false
  // 动词被否定（`不要生成…草稿`）：不当生成请求。
  if (match.index > 0 && DRAFT_NEGATION_RE.test(text.slice(0, match.index))) return false
  const chapterNumber =
    taskRoute.chapterNumber ?? Number.parseInt(taskRoute.extractedParams.chapterNumber ?? "", 10)
  if (Number.isFinite(chapterNumber) && chapterNumber > 0) return true
  return CHAPTER_REFERENCE_RE.test(text)
}

/**
 * 门控武装用的意图（NF-01 补口）：**仅**用于 `resolveRequiredToolsOnce` 的 intent 入参，
 * 不改 `taskRoute.intent` 本身。
 *
 * 为什么需要这一层：章节页「生成本章草稿」交接的目标文案
 * （`为「第N章 X」生成本章草稿`，见 `buildChapterDraftGoal`）不含 `write_chapter` 的
 * 触发式（`^(写|生成)\s*第N章` 要求动词在前、章号在后），`routeTask` 因此走 early return
 * 判成 `general_chat`，门控 `resolveRequiredToolsOnce` 直接返回 undefined —— 最典型的真实
 * 写作场景反而不武装（R03：8 个组件无确定性触发的主战场）。
 *
 * 为什么不从 handoff 取结构化意图：交接对象是**纯字符串**（`main-control-handoff.ts` 的
 * `pendingGoal: string | null`），且 `MainControlView` 挂载时就 `clearMainControlGoalHandoff()`，
 * 用户点「开始执行」时早已清空；唯一能带上结构化意图的入口是 `main-control-view.tsx`，
 * 本轮禁止改它。因此只能在装配层用 goal 文本 + 已算出的路由结果做**结构判定**
 * （动词 + 章节引用两半，见 `isChapterDraftGoal`），而不是自由的文本启发式。
 *
 * 收窄边界（只放大到 `general_chat → write_chapter` 一条边）：
 * - 已有意图一律原样返回——`review_chapter`（检查第 3 章有没有矛盾）、`polish_chapter`、
 *   `continue_chapter` 等既有判定不受影响，`routeTask` 的权重体系不被这一层改写。
 * - 只覆盖「草稿生成动词 + 章节引用」，因此「读第 3 章」「第12章 旧梦」「把第12章翻译成英文」
 *   「本章草稿在哪」都不命中。
 * 已知局限（有意不处理）：`生成本章草稿的步骤是什么` 这种把生成当名词的提问也会命中——
 * 装配层没有句法分析，主控侧代价只是「要求先跑一次工作流」，不伪造结论。
 */
export function resolveMainControlGateIntent(goal: string, taskRoute: TaskRouteResult): NovelTaskIntent {
  if (taskRoute.intent !== "general_chat") return taskRoute.intent
  return isChapterDraftGoal(goal, taskRoute) ? "write_chapter" : taskRoute.intent
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
  // F04：主控入口与 chat 侧之间没有 prop 链路（见 buildMainControlTaskRoute 注释），
  // 用与 chat 同一个纯函数就地推导，并补回路由 early return 丢掉的章号。
  // 后果（预期收益）：`load_context` 真正注册（依赖 `vtc.taskRoute`），`list_outlines` 的
  // `getDefaultChapterNumber` 也复活（读 `vtc.taskRoute.chapterNumber`）。
  const taskRoute = buildMainControlTaskRoute(goal)
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
  // NF-01：武装确定性门控。runner 侧四道接线（nudge / 拒绝终稿 / 兜底重试 / 诊断记录）
  // 早已就绪，缺的一直是这里的输入——`config.requiredToolsOnce` 此前全仓无赋值点。
  //
  // 必须走 `resolveRequiredToolsOnce()` 而不是硬编码 ["run_chapter_workflow"]：
  // 该函数负责 intent（只认 OUTLINE_FIND_CHAPTER_INTENTS 四类章节写作意图）/ mode
  // （fast 不要求）/ enabledToolNames（工具没注册就不要求）/ novelMode / 计划阶段
  // 的折算，硬编码会把「审稿」「读第 3 章」这类非写作目标也一并拦住。
  //
  // 入参来源（全部就地取，不新增 prop 链，理由同 buildMainControlTaskRoute）：
  // - intent：`resolveMainControlGateIntent(goal, taskRoute)`——taskRoute.intent 的**门控专用**
  //   归一化（把「草稿生成动词 + 章节引用」的 general_chat 视为 write_chapter）。注入
  //   virtualToolContext 的 taskRoute 保持路由原值，只有这一处入参被归一化。
  // - mode：调用方传入的 aiWorkflowMode（main-control-view 传 resolveAiWorkflowMode）。
  // - enabledToolNames：上面算出的白名单；未注入 runDeepChapterGeneration 时它不含
  //   run_chapter_workflow，折算结果为 undefined，门控自然不武装。
  // - novelMode：wiki store 的同一份状态——main-control-view 正是用它决定是否注入深章
  //   流水线（主控 props 只有 projectId，没有第二条链路可传）。
  // - planExecuteActive：本路径没有计划确认阶段（主控是执行侧，计划阶段禁止调用该工具，
  //   主控不在该阶段），恒为 false。
  const requiredToolsOnce = resolveRequiredToolsOnce({
    novelMode: useWikiStore.getState().novelMode,
    intent: resolveMainControlGateIntent(goal, taskRoute),
    mode: options.aiWorkflowMode ?? null,
    planExecuteActive: false,
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
      llmConfig: options.llmConfig,
      getSkillConfig: () => null,
      getChatConversations: () => [],
      getOutlineConversations: () => outlineConversations,
      virtualToolContext: { userMessage: goal, projectPath: options.projectPath, taskRoute },
    },
  )
  config.maxRounds = options.maxRounds ?? 8
  config.taskGoal = goal
  config.requiredToolsOnce = requiredToolsOnce

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
