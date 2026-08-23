/**
 * arc-tracker.ts — 弧光阶段推进检测（T27 / F-21 人物弧光）。
 *
 * 职责（蓝图 §4 ArcStage 推演，U-04 提案口径）：
 *   根据实体摄取数据（entity craft fields）检测弧光阶段是否推进，
 *   输出推进结果与置信度。
 *
 * 推进规则（纯机械状态机，U-04 提案口径）：
 *   null → ghost_exposed：  存在 mckee_ghost 或 significant_details
 *   ghost_exposed → refusal：  存在拒绝型 wma_action 或 visible_action
 *   refusal → commitment：  存在 mckee_conscious_desire 或 mckee_unconscious_need
 *   commitment → active：    存在 wma_action 且 arc_fundamentals 有进步
 *   active → crisis：        arc_fundamentals 下降或 visible_actions 显示冲突升级
 *   crisis → climax：        visible_actions 显示正面对抗
 *   climax → resolution：    closure_state 转为 closed 或 arc_closure 有记录
 *
 * 确定性=超越轴(ADR-19)：零 IO、零 LLM、零 Tauri invoke；同输入同输出。
 *
 * Draft-first(ADR-08)：纯机械模块，不写运行时会话状态，不触及草稿正式层。
 */

import type {
  ArcStage,
  ArcFundamentals,
  VisibleActionSnapshot,
  ClosureState,
} from "./canon-craft-fields"
import { ARC_STAGE_VALUES, isArcStage } from "./canon-craft-fields"

// ============================================================================
// 输入/输出类型
// ============================================================================

/**
 * 弧光推进检测输入。
 *
 * 全部字段 additive optional（与 EntityCraftFields 对齐）：
 * 未提供的字段视为「无证据」而非「缺省值」，不会触发推进。
 */
export interface ArcProgressionInput {
  /** 当前弧光阶段（null/undefined = 尚未摄取）。 */
  currentStage: ArcStage | null | undefined
  /** 麦基鬼魂（主角过往创伤）。 */
  mckeeGhost?: string | null
  /** 麦基意识欲望。 */
  mckeeConsciousDesire?: string | null
  /** 麦基无意识需求。 */
  mckeeUnconsciousNeed?: string | null
  /** 愿望-动机驱动的行动清单。 */
  wmaActions?: string[]
  /** 显著细节锚点。 */
  significantDetails?: string[]
  /** 可见行为快照。 */
  visibleActions?: VisibleActionSnapshot[]
  /** 八项素质评分表。 */
  arcFundamentals?: ArcFundamentals | null
  /** 当前闭环状态（从 episodes.arc_closure 提取）。 */
  closureState?: ClosureState | null
}

/** 弧光推进检测结果。 */
export interface ArcProgressionResult {
  /** 前一个弧光阶段（null=首次摄取）。 */
  previousStage: ArcStage | null
  /** 当前弧光阶段（检测后的阶段）。 */
  currentStage: ArcStage
  /** 是否发生了阶段推进。 */
  progressed: boolean
  /** 置信度 [0,1]（证据充分性度量）。 */
  confidence: number
  /** 推进理由（人类可读，用于决策日志）。 */
  reason: string
}

// ============================================================================
// 推进规则（纯机械状态机）
// ============================================================================

/**
 * 检测弧光阶段是否推进（纯机械状态机，零 LLM）。
 *
 * 推进规则（U-04 提案口径）：
 *   按 ARC_STAGE_VALUES 顺序线性推进，每次只允许推进 0 或 1 步。
 *   置信度 = 证据数量权重总和 / 该阶段所需加权总分。
 *
 * 安全边界：
 *   - 不会跳过阶段（如从 refusal 直接到 climax 视为无推进）。
 *   - 不会回退（当前阶段已 ≥ 检测到的阶段时，不推进）。
 *   - 未知的 currentStage 字符串视为 null（尚未摄取）。
 */
export function detectArcProgression(input: ArcProgressionInput): ArcProgressionResult {
  // 1. 规范化当前阶段
  const currentStage = input.currentStage && isArcStage(input.currentStage)
    ? input.currentStage
    : null

  // 2. 计算每个阶段的证据权重
  const evidence = computeStageEvidence(input)

  // 3. 从当前阶段往后找第一个证据充足的阶段（只推进 1 步，不跳过）
  let nextStage: ArcStage | null = null
  let maxConfidence = 0
  let bestReason = ""

  const startIndex = currentStage
    ? ARC_STAGE_VALUES.indexOf(currentStage)
    : -1

  // 只检查 immediate next stage（线性推进，不跳过）
  const nextIndex = startIndex + 1
  if (nextIndex < ARC_STAGE_VALUES.length) {
    const stage = ARC_STAGE_VALUES[nextIndex]
    const ev = evidence[stage]
    if (ev.score >= ev.threshold) {
      nextStage = stage
      maxConfidence = ev.confidence
      bestReason = ev.reason
    }
  }

  // 4. 如果未找到推进，返回当前阶段
  if (!nextStage) {
    return {
      previousStage: currentStage,
      currentStage: currentStage ?? ARC_STAGE_VALUES[0],
      progressed: false,
      confidence: currentStage ? 1.0 : 0.0,
      reason: currentStage ? "无推进证据" : "首次摄取，无前驱阶段",
    }
  }

  return {
    previousStage: currentStage,
    currentStage: nextStage,
    progressed: true,
    confidence: maxConfidence,
    reason: bestReason,
  }
}

// ============================================================================
// 证据计算（内部）
// ============================================================================

interface StageEvidence {
  score: number
  threshold: number
  confidence: number
  reason: string
}

function computeStageEvidence(input: ArcProgressionInput): Record<ArcStage, StageEvidence> {
  const evidence: Record<string, StageEvidence> = {}

  for (const stage of ARC_STAGE_VALUES) {
    evidence[stage] = evaluateStage(stage, input)
  }

  return evidence as Record<ArcStage, StageEvidence>
}

function evaluateStage(stage: ArcStage, input: ArcProgressionInput): StageEvidence {
  switch (stage) {
    case "ghost_exposed":
      return evaluateGhostExposed(input)
    case "refusal":
      return evaluateRefusal(input)
    case "commitment":
      return evaluateCommitment(input)
    case "active":
      return evaluateActive(input)
    case "crisis":
      return evaluateCrisis(input)
    case "climax":
      return evaluateClimax(input)
    case "resolution":
      return evaluateResolution(input)
    default:
      return { score: 0, threshold: 1, confidence: 0, reason: `未知阶段: ${stage}` }
  }
}

/**
 * ghost_exposed 证据评估：
 *   - 存在 mckee_ghost（权重 2）
 *   - 存在 significant_details（权重 1，至少 1 条）
 *   阈值：2
 */
function evaluateGhostExposed(input: ArcProgressionInput): StageEvidence {
  let score = 0
  const parts: string[] = []

  if (input.mckeeGhost) {
    score += 2
    parts.push("mckee_ghost 存在")
  }
  if (input.significantDetails && input.significantDetails.length > 0) {
    score += 1
    parts.push(`significant_details 有 ${input.significantDetails.length} 条`)
  }

  const threshold = 2
  return {
    score,
    threshold,
    confidence: threshold > 0 ? Math.min(score / threshold, 1) : 0,
    reason: parts.length > 0 ? parts.join("；") : "无证据",
  }
}

/**
 * refusal 证据评估：
 *   - 存在拒绝型 visible_action（权重 1，至少 1 条冲突回避行为）
 *   - 存在 wma_action 但内容为回避型（权重 1，简化：只要 wma_action 非空就计）
 *   阈值：1
 */
function evaluateRefusal(input: ArcProgressionInput): StageEvidence {
  let score = 0
  const parts: string[] = []

  if (input.visibleActions && input.visibleActions.length > 0) {
    score += 1
    parts.push(`visible_actions 有 ${input.visibleActions.length} 条`)
  }
  if (input.wmaActions && input.wmaActions.length > 0) {
    // 简化：wma_action 存在即视为有行动证据（冲突回避/犹豫归内容检查，T28 规则包）
    score += 1
    parts.push(`wma_actions 有 ${input.wmaActions.length} 条`)
  }

  const threshold = 1
  return {
    score,
    threshold,
    confidence: threshold > 0 ? Math.min(score / threshold, 1) : 0,
    reason: parts.length > 0 ? parts.join("；") : "无证据",
  }
}

/**
 * commitment 证据评估：
 *   - 存在 mckee_conscious_desire（权重 2）
 *   - 存在 mckee_unconscious_need（权重 2）
 *   阈值：2
 */
function evaluateCommitment(input: ArcProgressionInput): StageEvidence {
  let score = 0
  const parts: string[] = []

  if (input.mckeeConsciousDesire) {
    score += 2
    parts.push("mckee_conscious_desire 存在")
  }
  if (input.mckeeUnconsciousNeed) {
    score += 2
    parts.push("mckee_unconscious_need 存在")
  }

  const threshold = 2
  return {
    score,
    threshold,
    confidence: threshold > 0 ? Math.min(score / threshold, 1) : 0,
    reason: parts.length > 0 ? parts.join("；") : "无证据",
  }
}

/**
 * active 证据评估：
 *   - 存在 wma_action（权重 2，至少 1 条）
 *   - arc_fundamentals 有进步性记录（权重 1，至少 1 个槽位 >= 0.5）
 *   阈值：2
 */
function evaluateActive(input: ArcProgressionInput): StageEvidence {
  let score = 0
  const parts: string[] = []

  if (input.wmaActions && input.wmaActions.length > 0) {
    score += 2
    parts.push(`wma_actions 有 ${input.wmaActions.length} 条`)
  }
  if (input.arcFundamentals) {
    const highSlots = Object.values(input.arcFundamentals).filter((v) => v >= 0.5)
    if (highSlots.length > 0) {
      score += 1
      parts.push(`arc_fundamentals 有 ${highSlots.length} 个槽位 >= 0.5`)
    }
  }

  const threshold = 2
  return {
    score,
    threshold,
    confidence: threshold > 0 ? Math.min(score / threshold, 1) : 0,
    reason: parts.length > 0 ? parts.join("；") : "无证据",
  }
}

/**
 * crisis 证据评估：
 *   - arc_fundamentals 有下降信号（权重 2，至少 1 个槽位 < 0.3）
 *   - visible_actions 显示冲突升级（权重 1，至少 2 条）
 *   阈值：2
 */
function evaluateCrisis(input: ArcProgressionInput): StageEvidence {
  let score = 0
  const parts: string[] = []

  if (input.arcFundamentals) {
    const lowSlots = Object.values(input.arcFundamentals).filter((v) => v < 0.3)
    if (lowSlots.length > 0) {
      score += 2
      parts.push(`arc_fundamentals 有 ${lowSlots.length} 个低槽位 < 0.3`)
    }
  }
  if (input.visibleActions && input.visibleActions.length >= 2) {
    score += 1
    parts.push(`visible_actions 有 ${input.visibleActions.length} 条（>=2）`)
  }

  const threshold = 2
  return {
    score,
    threshold,
    confidence: threshold > 0 ? Math.min(score / threshold, 1) : 0,
    reason: parts.length > 0 ? parts.join("；") : "无证据",
  }
}

/**
 * climax 证据评估：
 *   - visible_actions 有高潮行为（权重 2，至少 3 条）
 *   - arc_fundamentals 出现极端值（权重 1，至少 1 个槽位 >= 0.9 或 <= 0.1）
 *   阈值：2
 */
function evaluateClimax(input: ArcProgressionInput): StageEvidence {
  let score = 0
  const parts: string[] = []

  if (input.visibleActions && input.visibleActions.length >= 3) {
    score += 2
    parts.push(`visible_actions 有 ${input.visibleActions.length} 条（>=3）`)
  }
  if (input.arcFundamentals) {
    const extremeSlots = Object.values(input.arcFundamentals).filter(
      (v) => v >= 0.9 || v <= 0.1,
    )
    if (extremeSlots.length > 0) {
      score += 1
      parts.push(`arc_fundamentals 有 ${extremeSlots.length} 个极端值槽位`)
    }
  }

  const threshold = 2
  return {
    score,
    threshold,
    confidence: threshold > 0 ? Math.min(score / threshold, 1) : 0,
    reason: parts.length > 0 ? parts.join("；") : "无证据",
  }
}

/**
 * resolution 证据评估：
 *   - closure_state 为 closed（权重 3）
 *   - arc_fundamentals 恢复到稳定水平（权重 1，所有槽位 >= 0.4 且 <= 0.9）
 *   阈值：3
 */
function evaluateResolution(input: ArcProgressionInput): StageEvidence {
  let score = 0
  const parts: string[] = []

  if (input.closureState === "closed") {
    score += 3
    parts.push("closure_state 为 closed")
  }
  if (input.arcFundamentals) {
    const allStable = Object.values(input.arcFundamentals).every(
      (v) => v >= 0.4 && v <= 0.9,
    )
    if (allStable && Object.keys(input.arcFundamentals).length > 0) {
      score += 1
      parts.push("arc_fundamentals 全部稳定在 [0.4, 0.9]")
    }
  }

  const threshold = 3
  return {
    score,
    threshold,
    confidence: threshold > 0 ? Math.min(score / threshold, 1) : 0,
    reason: parts.length > 0 ? parts.join("；") : "无证据",
  }
}

// ============================================================================
// 机械守卫
// ============================================================================

/** 检测 ArcProgressionInput 是否合法（非空 currentStage 必须在注册表内，但不要求提供）。 */
export function validateArcProgressionInput(input: ArcProgressionInput): boolean {
  if (input.currentStage != null && !isArcStage(input.currentStage)) return false
  return true
}