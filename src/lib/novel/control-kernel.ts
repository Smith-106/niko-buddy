/**
 * control-kernel.ts — T08 确定性 Route 内核 (F-10 / A-02.3)
 *
 * 蓝图 §4 接口签名终版:
 *   export function route(state: ControlState): Instruction   // 纯函数, 13 分支互斥
 *
 * 职责 (蓝图 §10.1 / §10.4):
 *   route() 只决定『下一步做什么』——纯函数 13 分支互斥, 可 720k 穷举;
 *   『这一步怎么做』由执行层绑定角色模型完成 (T10 stage executor 预留
 *   role→model 解析点, 默认全角色单模型 = 现状, A-35 位级等价不破)。
 *
 * 硬不变式 (蓝图 §10.4 五条):
 *   ① route() 永不为协作加分支 (720k 穷举 / grep 无 IO 原样绿)
 *   ② 模型绑定 = 执行前纯函数解析, 不在本内核内
 *   ③ 三开关不动, premium_mode 是执行层项目配置 (非第 4 个 shell 值)
 *   ④ Draft-first: 本内核只产出决策, 不写任何正文/记忆
 *   ⑤ status.json 唯一真源: 本内核不读写任何状态文件
 *
 * 机械层零模型调用 (ADR-19): 本文件无 IO / 无网络 / 无模型调用 / 无 Tauri 命令调用,
 * 同输入必同输出。收敛校验见 control-kernel.spec.ts 的 ADR-19 grep 测试。
 *
 * 优先级链 (自上而下第一个命中, 与 control-sentinels.ts ROUTE_ACTIONS 一一对应):
 *   1. halt             — 终态 (phase=complete / 写作期无进度)
 *   2. foundation_fill  — 规划期缺设定且规划师 tier 已知
 *   3. arbitrate        — 人工介入标记 (僵局/干预, 压过一切自动派单)
 *   4. rewrite          — 重写队列非空 (队列头绝对优先)
 *   5. arc_transition   — 弧末边界 (子步: 弧评审→弧摘要→卷摘要→展开→新卷)
 *   6. global_review    — 周期全局审阅 (每 reviewInterval 章, lastGlobalReviewChapter 去重)
 *   7-13. 阶段机        — context→scene_breakdown→task_brief→draft→review→revision→done
 *                          (stage=review 时按门控 P0>P1>P2 + anti_ai_mode 三档裁定)
 *
 * @license MIT © QMAI
 */

import {
  ANTI_AI_MODES,
  ARC_TRANSITION_STEPS,
  GATE_PRIORITY,
  GATE_VERDICTS,
  ROUTE_ACTIONS,
  ROUTE_ROLES,
  ROUTE_SHELL_MODES,
  ROUTE_STAGES,
} from "./control-sentinels"

// ============================================================================
// 类型契约 (蓝图 §4 终版 + T02 type-only 契约收编)
// ============================================================================

/** 阶段: 规划期 / 写作期 / 终态。 */
export type RoutePhase = "planning" | "writing" | "complete"

/** 深章流水线位置 (7 值, 与 deep-chapter-generation resume stage 链同构)。 */
export type RouteStage = (typeof ROUTE_STAGES)[number]

/** 门控裁定: pending=未评估 / pass=通过 / fail=失败。 */
export type GateVerdict = (typeof GATE_VERDICTS)[number]

/** 三开关 shell 模式 (默认全 legacy)。 */
export type RouteShellMode = (typeof ROUTE_SHELL_MODES)[number]

/** 三档反 AI 模式 (T21): off=不挡 / warn=警告不挡 / block=硬挡。 */
export type AntiAiMode = (typeof ANTI_AI_MODES)[number]

/**
 * T21 warn 档注解: 来自 T19 候选池的四统计因子检测结果,
 * 仅在 antiAiMode="warn" 且 gates.anti_ai="fail" 时注入 reason。
 * 纯数据字段, 不触发 IO/模型调用。
 */
export interface WarnAnnotation {
  /** 触发 warn 的因子名列表 */
  triggeredFactors: string[]
  /** 综合建议 (纯文本, 执行层消费) */
  summary: string
  /** 标定语料来源 (synthetic-degraded / pending-real-corpus) */
  calibrationSource: string
}

/** 规划师 tier: 空=未定 / short / long。 */
export type PlanningTier = "" | "short" | "long"

/** 门控三键 (P0>P1>P2, GATE_PRIORITY)。 */
export interface RouteGates {
  consistency: GateVerdict
  anti_ai: GateVerdict
  quality: GateVerdict
}

/** 弧末边界事实 (与 ainovel-cli ArcBoundary 同构)。 */
export interface ArcBoundary {
  isArcEnd: boolean
  isVolumeEnd: boolean
  needsExpansion: boolean
  needsNewVolume: boolean
  nextArc: number
}

/**
 * 控制态 (route 内核输入, 蓝图 §4 ControlState)。
 *
 * 字段语义:
 *   - phase / stage:        流水线位置 (stage=review 时 gates 已评估, 由 route 裁定)
 *   - chapterNumber:        下一章序号 (1-based; 写作期 ≤0 视为无进度 → halt)
 *   - completedChapters:    已完成章数 (global_review 触发用)
 *   - pendingRewrites:      重写队列 (头 = 绝对优先)
 *   - gates:                门控裁定 (stage=review 时消费; 其余阶段不消费)
 *   - antiAiMode:           三档反 AI 模式 (仅 stage=review 的 anti_ai 门控消费)
 *   - manualReviewRequired: 人工介入标记 (僵局/干预 → arbitrate)
 *   - foundationMissing:    规划期缺设定清单
 *   - planningTier:         规划师 tier ("" = 未定)
 *   - reviewInterval:       周期全局审阅间隔 (0 = 关闭)
 *   - lastGlobalReviewChapter: 上次全局审阅的章号 (去重)
 *   - arcBoundary / hasArcReview / hasArcSummary / hasVolumeSummary: 弧末事务事实
 *   - shellMode:            三开关回显 (route 不分支, 执行层消费)
 */
export interface ControlState {
  phase: RoutePhase
  stage: RouteStage
  chapterNumber: number
  completedChapters: number
  pendingRewrites: number[]
  gates: RouteGates
  antiAiMode: AntiAiMode
  manualReviewRequired: boolean
  foundationMissing: string[]
  planningTier: PlanningTier
  reviewInterval: number
  lastGlobalReviewChapter: number
  arcBoundary?: ArcBoundary
  hasArcReview: boolean
  hasArcSummary: boolean
  hasVolumeSummary: boolean
  shellMode: RouteShellMode
  /**
   * T21: warn 档注解（来自 T19 候选池）
   * 仅在 antiAiMode="warn" 且门控评估后由执行层注入,
   * route() 纯函数只读传递, 不解释不消费。
   */
  warnAnnotation?: WarnAnnotation
  /**
   * T21: block 档阈值标记（来自 T20 标定）
   * pending-real-corpus 语义: 真实语料未到, 阈值暂不生效,
   * 标记仅用于审计追踪, 不阻塞 warn 行为。
   */
  blockThresholdApplied?: boolean
}

/** 13 个互斥分支 (与 ROUTE_ACTIONS 一一对应)。 */
export type RouteAction = (typeof ROUTE_ACTIONS)[number]

/** arc_transition 子步 (弧末事务顺序)。 */
export type ArcTransitionStep = (typeof ARC_TRANSITION_STEPS)[number]

/** 执行角色 (T33 注册表接入点; halt 无角色)。 */
export type RouteRole = (typeof ROUTE_ROLES)[number]

/**
 * 路由指令 (route 输出, 蓝图 §4 Instruction)。
 *
 *   - action:   13 分支之一 (互斥)
 *   - arcStep:  action=arc_transition 时的子步
 *   - chapter:  章级动作的目标章 (write_draft/rewrite/revise/review/judge 等)
 *   - role:     执行角色 (halt 缺省; 执行层据此解析 role→model, 默认全角色单模型)
 *   - reason:   决策理由 (非空, 审计/离线回放用)
 *   - shellMode: 三开关回显 (route 不分支)
 */
export interface Instruction {
  action: RouteAction
  arcStep?: ArcTransitionStep
  chapter?: number
  role?: RouteRole
  reason: string
  shellMode: RouteShellMode
}

// ============================================================================
// 纯函数 route() — 13 分支互斥, 无 IO / 无模型调用
// ============================================================================

/** 终态判定: phase=complete 或写作期无进度 (chapterNumber ≤ 0)。 */
function isTerminal(state: ControlState): boolean {
  return state.phase === "complete" || (state.phase === "writing" && state.chapterNumber <= 0)
}

/** 规划期缺设定且规划师 tier 已知 → 可派规划师补齐。 */
function needsFoundationFill(state: ControlState): boolean {
  return state.foundationMissing.length > 0 && state.planningTier !== ""
}

/** 周期全局审阅到期: 间隔开启 + 已完成章数命中间隔 + 上次审阅早于当前章。 */
function isGlobalReviewDue(state: ControlState): boolean {
  return (
    state.reviewInterval > 0 &&
    state.completedChapters > 0 &&
    state.completedChapters % state.reviewInterval === 0 &&
    state.lastGlobalReviewChapter < state.completedChapters
  )
}

/** 弧末未决子步 (无未决事务返回 undefined → 落入常规流程)。 */
function pendingArcStep(state: ControlState): ArcTransitionStep | undefined {
  const arc = state.arcBoundary
  if (arc === undefined || !arc.isArcEnd) return undefined
  if (!state.hasArcReview) return "arc_review"
  if (!state.hasArcSummary) return "arc_summary"
  if (arc.isVolumeEnd && !state.hasVolumeSummary) return "volume_summary"
  if (arc.needsExpansion && arc.nextArc > 0) return "expand_arc"
  if (arc.needsNewVolume) return "new_volume"
  return undefined
}

/** 门控裁定 (仅 stage=review 消费): P0 硬挡 → 修订; P1 仅 block 档硬挡; P2 永不挡。 */
function gateRouting(state: ControlState): "revise" | "judge" {
  if (state.gates.consistency === "fail") return "revise"
  if (state.gates.anti_ai === "fail" && state.antiAiMode === "block") return "revise"
  return "judge"
}

/** 构建 anti_ai 门控理由 (含 T21 三档语境)。 */
function antiAiReason(state: ControlState): string {
  const mode = state.antiAiMode
  const verdict = state.gates.anti_ai
  if (verdict !== "fail") return ""
  if (mode === "off") return "anti_ai fail 但 mode=off: 不阻塞"
  if (mode === "warn") {
    const base = "anti_ai fail 但 mode=warn: 警告不阻塞"
    if (state.warnAnnotation) {
      const factors = state.warnAnnotation.triggeredFactors.join(", ")
      return `${base} (T19 候选池触发: ${factors}; 标定: ${state.warnAnnotation.calibrationSource})`
    }
    return `${base} (T19 候选池未触发或未加载)`
  }
  // mode === "block"
  const thresholdNote = state.blockThresholdApplied
    ? "T20 阈值已接线"
    : "T20 阈值 pending-real-corpus (标定超期, 仍 allow warn 不卡)"
  return `anti_ai fail 且 mode=block: 硬挡 (${thresholdNote})`
}

/**
 * 确定性路由: 给定控制态, 返回唯一『下一步做什么』指令。
 *
 * 纯函数 (ADR-19): 不修改输入, 无 IO, 无模型调用, 同输入必同输出。
 * 13 分支互斥: 优先级链自上而下第一个命中, 任意状态恰好命中一个分支。
 */
export function route(state: ControlState): Instruction {
  const shellMode = state.shellMode

  // 1. halt — 终态
  if (isTerminal(state)) {
    return { action: "halt", reason: "终态: 全书完成或无进度, 无下一步", shellMode }
  }

  // 2. foundation_fill — 规划期缺设定
  if (state.phase === "planning") {
    if (needsFoundationFill(state)) {
      return {
        action: "foundation_fill",
        role: "architect",
        reason: `规划期缺设定 ${state.foundationMissing.join("/")}, 派规划师补齐`,
        shellMode,
      }
    }
    return { action: "halt", reason: "规划期无缺项或规划师未定, 等待裁定", shellMode }
  }

  // 3. arbitrate — 人工介入 (压过一切自动派单)
  if (state.manualReviewRequired) {
    return { action: "arbitrate", role: "arbiter", reason: "人工介入标记: 僵局或干预需仲裁", shellMode }
  }

  // 4. rewrite — 重写队列绝对优先
  if (state.pendingRewrites.length > 0) {
    return {
      action: "rewrite",
      role: "writer",
      chapter: state.pendingRewrites[0],
      reason: `重写队列头 ${state.pendingRewrites[0]}`,
      shellMode,
    }
  }

  // 5. arc_transition — 弧末边界 (子步按事务顺序)
  const arcStep = pendingArcStep(state)
  if (arcStep !== undefined) {
    const role: RouteRole = arcStep === "expand_arc" || arcStep === "new_volume" ? "architect" : "editor"
    return { action: "arc_transition", arcStep, role, reason: `弧末事务: ${arcStep}`, shellMode }
  }

  // 6. global_review — 周期全局审阅
  if (isGlobalReviewDue(state)) {
    return {
      action: "global_review",
      role: "reviewer",
      reason: `每 ${state.reviewInterval} 章全局审阅到期 (已完成 ${state.completedChapters} 章)`,
      shellMode,
    }
  }

  // 7-13. 阶段机
  switch (state.stage) {
    case "context":
      return { action: "context_assembly", role: "writer", chapter: state.chapterNumber, reason: "装配上下文包", shellMode }
    case "scene_breakdown":
      return { action: "scene_breakdown", role: "writer", chapter: state.chapterNumber, reason: "场景拆解", shellMode }
    case "task_brief":
      return { action: "task_brief", role: "writer", chapter: state.chapterNumber, reason: "生成任务简报", shellMode }
    case "draft":
      return { action: "write_draft", role: "writer", chapter: state.chapterNumber, reason: `写第 ${state.chapterNumber} 章草稿`, shellMode }
    case "review": {
      const allPending =
        state.gates.consistency === "pending" &&
        state.gates.anti_ai === "pending" &&
        state.gates.quality === "pending"
      if (allPending) {
        return { action: "review", role: "reviewer", chapter: state.chapterNumber, reason: `评审第 ${state.chapterNumber} 章草稿`, shellMode }
      }
      const verdict = gateRouting(state)
      if (verdict === "revise") {
        const antiNote = antiAiReason(state)
        return { action: "revise", role: "writer", chapter: state.chapterNumber, reason: antiNote || "门控失败, 必须修订", shellMode }
      }
      const antiNote = antiAiReason(state)
      return { action: "judge", role: "judge", chapter: state.chapterNumber, reason: antiNote || "评审通过, 进入终审", shellMode }
    }
    case "revision":
      return { action: "revise", role: "writer", chapter: state.chapterNumber, reason: `修订第 ${state.chapterNumber} 章`, shellMode }
    case "done":
      return { action: "judge", role: "judge", chapter: state.chapterNumber, reason: "终审/接受", shellMode }
  }
}

// ============================================================================
// 门控优先级辅助 (P0>P1>P2, 供执行层/测试消费, 纯函数)
// ============================================================================

/**
 * 门控优先级序 (P0>P1>P2): 返回第一个失败的门控键; 全通过返回 undefined。
 * Quality(P2) 永不覆盖 Consistency(P0)/Anti-AI(P1) 的失败 (CLAUDE.md 硬约束 3)。
 */
export function firstFailedGate(gates: RouteGates): (typeof GATE_PRIORITY)[number] | undefined {
  for (const key of GATE_PRIORITY) {
    if (gates[key] === "fail") return key
  }
  return undefined
}
