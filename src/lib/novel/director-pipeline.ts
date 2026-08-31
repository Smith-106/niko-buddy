/**
 * R-anwa-2 (26 审计落地): DirectorPipeline — 开书级导演阶段门.
 *
 * 吸收来源：reference/AI-Novel-Writing-Assistant server/src/services/novel/
 * director/（三层架构：TaskDispatcher+DirectorTaskQueue lease/renew/complete/
 * fail、DirectorWorker 消费循环、phases/ 阶段级质量策略、recovery/ 恢复游标）。
 * 26 号审计 ds value 9 / hy3 value 7 全票 worth_absorbing：niko 仅有 outline
 * 级编排，无开书级「阶段推进 + 出口质量门」。
 *
 * 定位：确定性阶段状态机——把 ANWA 的 lease/worker/恢复收缩为纯函数阶段
 * 门（PhaseGate）：阶段序列固定、每阶段出口条件确定性校验、失败可重试、
 * 完成态不可逆。不引入后台队列/进程模型（桌面单用户场景不需要）。
 */

export const DIRECTOR_PHASES = [
  "idea", // 创意立意：书名/题材/核心冲突齐备
  "world", // 世界骨架：world-blueprint complete
  "character", // 角色账本：主角+对手齐备
  "outline", // 大纲：plot-framework 选型 + 分卷
  "chapters", // 章节：首章就绪
] as const

export type DirectorPhase = (typeof DIRECTOR_PHASES)[number]

export type PhaseStatus = "pending" | "running" | "done" | "failed"

export interface DirectorPipelineState {
  version: string
  currentPhase: DirectorPhase
  statuses: Record<DirectorPhase, PhaseStatus>
  /** failed 时的重试计数（按阶段）。 */
  retryCount: Partial<Record<DirectorPhase, number>>
  lastUpdated: string
}

export function createDirectorPipeline(): DirectorPipelineState {
  const statuses = Object.fromEntries(DIRECTOR_PHASES.map((p) => [p, "pending"])) as Record<
    DirectorPhase,
    PhaseStatus
  >
  statuses.idea = "running"
  return {
    version: "1.0",
    currentPhase: "idea",
    statuses,
    retryCount: {},
    lastUpdated: new Date().toISOString(),
  }
}

export interface PhaseGateInput {
  idea: { title: string; genre: string; coreConflict: string }
  worldComplete: boolean
  protagonistNamed: boolean
  antagonistNamed: boolean
  frameworkChosen: boolean
  volumesPlanned: boolean
  firstChapterReady: boolean
}

/** 每阶段出口条件的确定性校验（ANWA phases/ 阶段质量策略的收缩态）。 */
export function phaseGateOutput(phase: DirectorPhase, input: PhaseGateInput): string | null {
  switch (phase) {
    case "idea":
      if (!input.idea.title.trim()) return "书名缺失"
      if (!input.idea.genre.trim()) return "题材缺失"
      if (!input.idea.coreConflict.trim()) return "核心冲突缺失"
      return null
    case "world":
      if (!input.worldComplete) return "世界骨架未完备（world-blueprint incomplete）"
      return null
    case "character":
      if (!input.protagonistNamed) return "主角未建立"
      if (!input.antagonistNamed) return "对手未建立"
      return null
    case "outline":
      if (!input.frameworkChosen) return "情节框架未选型"
      if (!input.volumesPlanned) return "分卷未规划"
      return null
    case "chapters":
      if (!input.firstChapterReady) return "首章未就绪"
      return null
  }
}

export interface PhaseAdvanceResult {
  state: DirectorPipelineState
  advanced: boolean
  /** 未过门原因（advanced=false 时非空）。 */
  blockedReason?: string
  /** 全管线完成。 */
  completed: boolean
}

/**
 * 推进当前阶段：过门 → done 并启动下一阶段（末阶段过门 → completed）；
 * 未过门 → failed + 重试计数 +1，currentPhase 不变。确定性：同输入同输出。
 */
export function advanceDirectorPhase(
  state: DirectorPipelineState,
  input: PhaseGateInput,
): PhaseAdvanceResult {
  const phase = state.currentPhase
  const blockedReason = phaseGateOutput(phase, input)
  const statuses = { ...state.statuses }
  const retryCount = { ...state.retryCount }

  if (blockedReason !== null) {
    statuses[phase] = "failed"
    retryCount[phase] = (retryCount[phase] ?? 0) + 1
    return { state: { ...state, statuses, retryCount, lastUpdated: new Date().toISOString() }, advanced: false, blockedReason, completed: false }
  }

  statuses[phase] = "done"
  const idx = DIRECTOR_PHASES.indexOf(phase)
  if (idx === DIRECTOR_PHASES.length - 1) {
    return { state: { ...state, statuses, retryCount, lastUpdated: new Date().toISOString() }, advanced: true, completed: true }
  }
  const next = DIRECTOR_PHASES[idx + 1]
  statuses[next] = "running"
  return {
    state: { ...state, currentPhase: next, statuses, retryCount, lastUpdated: new Date().toISOString() },
    advanced: true,
    completed: false,
  }
}

/** 重试失败阶段（failed → running），不动其他阶段。 */
export function retryDirectorPhase(state: DirectorPipelineState): DirectorPipelineState {
  const phase = state.currentPhase
  if (state.statuses[phase] !== "failed") return state
  return {
    ...state,
    statuses: { ...state.statuses, [phase]: "running" },
    lastUpdated: new Date().toISOString(),
  }
}

/** 渲染管线进度摘要（ANWA projections/ 进度展示的收缩态）。 */
export function directorPipelineSummary(state: DirectorPipelineState): string {
  const lines = DIRECTOR_PHASES.map((p) => {
    const mark = { pending: "○", running: "◐", done: "●", failed: "✗" }[state.statuses[p]]
    const retry = state.retryCount[p] ? `（重试 ${state.retryCount[p]}）` : ""
    return `${mark} ${p}${retry}`
  })
  return [`导演管线 @ ${state.currentPhase}`, ...lines].join("\n")
}
