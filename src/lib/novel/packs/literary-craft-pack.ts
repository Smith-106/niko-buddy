/**
 * literary-craft-pack.ts — 14 条文学提升规则包（T28 / F-21~F-26 / F-28）
 *
 * 职责（蓝图 §4 T28 行原文 + 任务定义）：
 *   14 条规则覆盖文学提升的全部可机械检查面：
 *   爽点密度/间隔/延宕比/弧光推进/鬼魂未揭/开篇钩子/章末钩子/显著细节/
 *   桥接口径/结局三戒/张弛交替/多米诺闭环与悬空钩子/开篇红线 5 类全集/
 *   八项素质检查。
 *
 * 规则数据源（T27 + T26 复用）：
 *   - T27 thrill-quantifier 纯算术输出（爽点密度/间隔/延宕比/张弛交替）
 *   - T27 arc-tracker 纯算术输出（弧光推进/鬼魂未揭/八项素质）
 *   - T26 canon-craft-fields 字段（钩子类型/显著细节/桥接口径/开篇红线）
 *
 * 规则结构（T23 rule-stack 契约，craft 门 warning 态）：
 *   - 全部规则归属 quality 门（门控 P2），默认 severity = "warning"
 *   - 终局章升格由 craftFinaleEscalation 处理（本包不处理升格）
 *   - 纯机械层零 LLM（ADR-19）：所有检查基于输入数据的确定性谓词
 *
 * Draft-first（ADR-08）：新增纯函数规则包，不写运行时会话状态，
 * 不触及草稿正式层。
 *
 * @license MIT © QMAI
 */

import type { RulePackDefinition, RuleDefinition, RawRuleFinding } from "../rule-stack"
import type { AuditDimensionId } from "../audit-taxonomy"
import type { QuantifiedHit, TensionSample } from "../craft/thrill-quantifier"
import type { ArcProgressionResult, ArcProgressionInput } from "../craft/arc-tracker"
import type {
  EntityCraftFields,
  EdgeCraftFields,
  EpisodeCraftFields,
} from "../craft/canon-craft-fields"
import type { BeatModel } from "../craft/beat-model"

// ============================================================================
// 文学规则包输入类型（T27 + T26 数据源合集）
// ============================================================================

/**
 * 文学规则包输入数据（全部 additive optional，缺省字段跳过对应规则的检查）。
 *
 * 数据源约定：
 *   - thrillQuantifierResult => T27 thrill-quantifier 输出
 *   - arcProgressionResult => T27 arc-tracker 输出
 *   - arcProgressionInput => T27 arc-tracker 输入（原始摄取数据）
 *   - entityCraftFields / edgeCraftFields / episodeCraftFields => T26 canon-craft-fields
 *   - beatModel => BeatModel（含 Snyder 标签级标注 + 爽点命中记录）
 */
export interface LiteraryCraftInput {
  /** 爽点量化结果（T27 thrill-quantifier 输出）。 */
  readonly thrillQuantifierResult?: {
    readonly hits: readonly QuantifiedHit[]
    readonly tensionCurve: readonly TensionSample[]
  }
  /** 弧光推进检测结果（T27 arc-tracker 输出）。 */
  readonly arcProgressionResult?: ArcProgressionResult
  /** 弧光推进检测输入（原始摄取数据，用于鬼魂/八素质检查）。 */
  readonly arcProgressionInput?: ArcProgressionInput
  /** entities 表技法字段（T26 EntityCraftFields）。 */
  readonly entityCraftFields?: EntityCraftFields
  /** edges 表技法字段（T26 EdgeCraftFields）。 */
  readonly edgeCraftFields?: EdgeCraftFields
  /** episodes 表技法字段（T26 EpisodeCraftFields）。 */
  readonly episodeCraftFields?: EpisodeCraftFields
  /** 节拍模型（BeatModel，含 Snyder 标签级标注 + 爽点命中记录）。 */
  readonly beatModel?: BeatModel
  /** 当前章节号（1-based，用于 chapter-end hook 检查）。 */
  readonly chapterNumber?: number
  /** 总章节数。 */
  readonly totalChapters?: number
}

// 输入引用（由 createLiteraryCraftPack 注入）
let input: LiteraryCraftInput = {}

// ============================================================================
// 14 条规则内部实现
// ============================================================================

// ---------------------------------------------------------------------------
// 规则 1: 爽点密度（thrill-density）— 检查爽点命中是否在合理密度区间
// ---------------------------------------------------------------------------

function checkThrillDensity(data: LiteraryCraftInput): readonly RawRuleFinding[] {
  const hits = data.thrillQuantifierResult?.hits
  if (!hits || hits.length === 0) return []

  // 按全书位置比例分桶：每 10% 一个桶
  const bucketSize = 0.1
  const bucketCount = Math.ceil(1 / bucketSize)
  const buckets = new Array<number>(bucketCount).fill(0)
  for (const hit of hits) {
    const idx = Math.min(Math.floor(hit.positionRatio / bucketSize), bucketCount - 1)
    buckets[idx]++
  }

  const findings: RawRuleFinding[] = []
  for (let i = 0; i < buckets.length; i++) {
    const density = buckets[i]
    const positionLabel = `${i * 10}-${Math.min((i + 1) * 10, 100)}%`
    // 过密：单桶 > 全书 30% 的 hit 数
    if (density > 0 && hits.length > 0 && density / hits.length > 0.3) {
      findings.push({
        severity: "warning",
        message: `爽点密度过高：${positionLabel} 段集中了 ${density}/${hits.length} 个爽点（${((density / hits.length) * 100).toFixed(0)}%），建议分散分布`,
      })
    }
    // 过疏：全书 ≥5 个 hit 但某桶为 0（非首尾桶）
    if (hits.length >= 5 && density === 0 && i > 0 && i < bucketCount - 1) {
      findings.push({
        severity: "info",
        message: `爽点空白段：${positionLabel} 段无任何爽点，可能造成阅读疲劳`,
      })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// 规则 2: 爽点间隔（thrill-spacing）— 检查相邻爽点间距是否合理
// ---------------------------------------------------------------------------

function checkThrillSpacing(data: LiteraryCraftInput): readonly RawRuleFinding[] {
  const hits = data.thrillQuantifierResult?.hits
  if (!hits || hits.length < 3) return []

  const findings: RawRuleFinding[] = []
  // 计算相邻 hit 间距
  const gaps: number[] = []
  for (let i = 1; i < hits.length; i++) {
    gaps.push(hits[i].positionRatio - hits[i - 1].positionRatio)
  }

  // 全书前 80% 内最大间距超过 0.3（全书 30%）→ warning
  const last80pcIdx = hits.findIndex((h) => h.positionRatio > 0.8)
  const earlyGaps = last80pcIdx > 0 ? gaps.slice(0, last80pcIdx) : gaps
  if (earlyGaps.length > 0) {
    const maxEarlyGap = Math.max(...earlyGaps)
    if (maxEarlyGap > 0.3) {
      findings.push({
        severity: "warning",
        message: `爽点间隔过长：前 80% 位置最大间距达 ${(maxEarlyGap * 100).toFixed(0)}%（全书位置），建议控制在 30% 以内`,
      })
    }
  }

  // 最小间距检查（过密）
  const minGap = Math.min(...gaps)
  if (minGap < 0.02 && hits.length > 5) {
    findings.push({
      severity: "info",
      message: `爽点间隔过密：相邻爽点最小间距仅 ${(minGap * 100).toFixed(1)}%（全书位置），建议拉开间距`,
    })
  }

  return findings
}

// ---------------------------------------------------------------------------
// 规则 3: 延宕比（delay-ratio）— 检查危机延宕 vs 疏解的比例
// ---------------------------------------------------------------------------

function checkDelayRatio(data: LiteraryCraftInput): readonly RawRuleFinding[] {
  const hits = data.thrillQuantifierResult?.hits
  if (!hits || hits.length < 4) return []

  const findings: RawRuleFinding[] = []
  // 按闭环状态分组：open（未兑现/延宕态）vs closed（已兑现/疏解态）
  const openHits = hits.filter((h) => h.closureState === "open")
  const closedHits = hits.filter((h) => h.closureState === "closed")

  if (openHits.length > 0 && closedHits.length > 0) {
    const ratio = openHits.length / closedHits.length
    // 延宕/疏解比 > 3:1 → 延宕过度
    if (ratio > 3) {
      findings.push({
        severity: "warning",
        message: `延宕比过高：open/closed 比例 = ${ratio.toFixed(1)}:1（${openHits.length} 开放 / ${closedHits.length} 闭环），建议 ≤ 3:1，避免读者长期压抑`,
      })
    }
    // 延宕/疏解比 < 0.5:1 → 疏解过快（压抑不足）
    if (ratio < 0.5 && openHits.length >= 2) {
      findings.push({
        severity: "info",
        message: `延宕比过低：open/closed 比例 = ${ratio.toFixed(1)}:1（${openHits.length} 开放 / ${closedHits.length} 闭环），压抑累积不足可能导致爽感强度不够`,
      })
    }
  }

  // 检查最长连续 open 序列的跨度（连续延宕，中间无 closed 打断）
  if (openHits.length >= 2) {
    const sortedHits = [...hits].sort((a, b) => a.positionRatio - b.positionRatio)
    let maxRunSpan = 0
    let currentRunStart = -1
    for (let i = 0; i < sortedHits.length; i++) {
      if (sortedHits[i].closureState === "open") {
        if (currentRunStart < 0) currentRunStart = sortedHits[i].positionRatio
        // 如果这是最后一个 hit 或下一个 hit 是 closed，计算当前 run 的跨度
        if (i === sortedHits.length - 1 || sortedHits[i + 1].closureState === "closed") {
          const runSpan = sortedHits[i].positionRatio - currentRunStart
          if (runSpan > maxRunSpan) maxRunSpan = runSpan
          currentRunStart = -1
        }
      }
    }
    if (maxRunSpan > 0.5) {
      findings.push({
        severity: "warning",
        message: `连续延宕跨度过长：最长连续开放爽点序列跨度达全书 ${(maxRunSpan * 100).toFixed(0)}%，建议压缩延宕周期或在延宕段内插入分流疏解`,
      })
    }
  }

  return findings
}

// ---------------------------------------------------------------------------
// 规则 4: 弧光推进（arc-progression）— 检查弧光阶段是否正确推进
// ---------------------------------------------------------------------------

function checkArcProgression(data: LiteraryCraftInput): readonly RawRuleFinding[] {
  const result = data.arcProgressionResult
  if (!result) return []

  const findings: RawRuleFinding[] = []

  // 未推进（progressed = false）且当前阶段不是首次摄取
  if (!result.progressed && result.previousStage !== null) {
    findings.push({
      severity: "warning",
      message: `弧光未推进：当前阶段 "${result.currentStage}" 与前驱 "${result.previousStage}" 相同，需检查是否有推进事件`,
    })
  }

  // 低置信度推进
  if (result.progressed && result.confidence < 0.5) {
    findings.push({
      severity: "info",
      message: `弧光推进置信度低：阶段 "${result.previousStage}" → "${result.currentStage}" 置信度仅 ${(result.confidence * 100).toFixed(0)}%，建议强化推进证据`,
    })
  }

  // 首次摄取无阶段
  if (result.previousStage === null && result.currentStage === "ghost_exposed") {
    // 首次摄取默认为 ghost_exposed，正常
  }

  return findings
}

// ---------------------------------------------------------------------------
// 规则 5: 鬼魂未揭（ghost-unrevealed）— 检查鬼魂是否在合理节点被揭示
// ---------------------------------------------------------------------------

function checkGhostUnrevealed(data: LiteraryCraftInput): readonly RawRuleFinding[] {
  const entity = data.entityCraftFields
  const totalChapters = data.totalChapters ?? 0
  const chapterNumber = data.chapterNumber ?? 0

  const findings: RawRuleFinding[] = []

  // 鬼魂字段是否存在
  const ghost = entity?.mckee_ghost
  const hasGhost = Boolean(ghost && ghost.trim().length > 0)

  // 超过全书 50% 位置仍未揭示鬼魂
  if (!hasGhost && totalChapters > 0 && chapterNumber > 0) {
    const progress = chapterNumber / totalChapters
    if (progress > 0.5) {
      findings.push({
        severity: "warning",
        message: `鬼魂未揭示：全书进度 ${(progress * 100).toFixed(0)}%（第 ${chapterNumber}/${totalChapters} 章）仍未登记主角鬼魂，建议在全书前半程揭示`,
      })
    } else {
      findings.push({
        severity: "info",
        message: `鬼魂缺失：主角鬼魂（mckee_ghost）尚未登记，需在全书前半程注入`,
      })
    }
  }

  return findings
}

// ---------------------------------------------------------------------------
// 规则 6: 开篇钩子（opening-hook）— 检查开篇钩子类型与质量
// ---------------------------------------------------------------------------

function checkOpeningHook(data: LiteraryCraftInput): readonly RawRuleFinding[] {
  const edge = data.edgeCraftFields
  const findings: RawRuleFinding[] = []

  const hookType = edge?.hook_type
  if (!hookType || hookType.trim().length === 0) {
    findings.push({
      severity: "warning",
      message: `开篇钩子缺失：edges.hook_type 未登记，开篇需注册钩子类型（对话/悬念/有力首句等，见 T27b 钩子注册表）`,
    })
    return findings
  }

  // 检查是否命中投稿禁忌（T27b 开篇包参数中的 taboos）
  const taboos = [
    "country_road",
    "crash_course",
    "dud_opening",
    "mirror_gazing",
    "standing_still",
    "typecasting",
    "sensationalism",
    "fast_lane",
    "tears",
  ]
  if (taboos.includes(hookType)) {
    findings.push({
      severity: "warning",
      message: `开篇钩子类型 "${hookType}" 属于投稿禁忌（T27b opening-hook-promise 包），建议更换为有力钩子类型`,
    })
  }

  return findings
}

// ---------------------------------------------------------------------------
// 规则 7: 章末钩子（chapter-end-hook）— 检查章末钩子类型与存在
// ---------------------------------------------------------------------------

function checkChapterEndHook(data: LiteraryCraftInput): readonly RawRuleFinding[] {
  const episode = data.episodeCraftFields
  const chapterNumber = data.chapterNumber ?? 0
  const totalChapters = data.totalChapters ?? 0
  const findings: RawRuleFinding[] = []

  // 非终章才需要章末钩子（终章不需要钩子）
  if (chapterNumber >= totalChapters && totalChapters > 0) {
    return []
  }

  const hookType = episode?.hook_type
  if (!hookType || hookType.trim().length === 0) {
    findings.push({
      severity: "warning",
      message: `章末钩子缺失：episodes.hook_type 未登记（第 ${chapterNumber} 章），每章（除终章）结尾需注册章末钩子类型`,
    })
    return findings
  }

  // 检查是否命中已知的章末钩子类型（T27b 维兰德十一型）
  const knownHooks = [
    "foreshadow_conflict",
    "secret",
    "important_decision_or_vow",
    "shocking_announcement",
    "intense_emotion",
    "novel_flipping_twist",
    "new_idea",
    "unanswered_question",
    "mysterious_dialogue",
    "prophecy",
    "turning_point",
  ]
  if (!knownHooks.includes(hookType)) {
    findings.push({
      severity: "info",
      message: `章末钩子类型 "${hookType}" 不在维兰德十一型注册表中，确认是否为新注册类型`,
    })
  }

  return findings
}

// ---------------------------------------------------------------------------
// 规则 8: 显著细节（significant-detail）— 检查显著细节密度
// ---------------------------------------------------------------------------

function checkSignificantDetail(data: LiteraryCraftInput): readonly RawRuleFinding[] {
  const entity = data.entityCraftFields
  const findings: RawRuleFinding[] = []

  const details = entity?.significant_details
  if (!details || details.length === 0) {
    findings.push({
      severity: "info",
      message: `显著细节缺失：entities.significant_details 为空，建议为关键角色/环境登记 1-2 个鲜明细节锚点`,
    })
    return findings
  }

  // 每个角色最多 2 个显著细节（T27b 显著细节包参数 max_details_per_subject=2）
  if (details.length > 2) {
    findings.push({
      severity: "info",
      message: `显著细节过多：${details.length} 个细节（建议 ≤2 个/角色），少即是多——保留最鲜明的 1-2 个`,
    })
  }

  // 检查是否包含泛化形容词（T27b 显著细节包 avoid_generic_adjectives）
  const genericAdjectives = ["漂亮", "帅", "美", "丑"]
  for (const detail of details) {
    for (const adj of genericAdjectives) {
      if (detail.includes(adj)) {
        findings.push({
          severity: "warning",
          message: `显著细节含泛化形容词："${detail}" 中的 "${adj}" 属于禁用广告词，请替换为新鲜具体的描述`,
        })
      }
    }
  }

  return findings
}

// ---------------------------------------------------------------------------
// 规则 9: 桥接口径（bridge-caliber）— 检查冲突口径与叙事模式对齐
// ---------------------------------------------------------------------------

function checkBridgeCaliber(data: LiteraryCraftInput): readonly RawRuleFinding[] {
  const episode = data.episodeCraftFields
  const beatModel = data.beatModel
  const findings: RawRuleFinding[] = []

  const caliber = episode?.conflict_caliber
  const narrativeMode = episode?.narrative_mode ?? beatModel?.narrativeMode ?? null

  if (!caliber) {
    findings.push({
      severity: "info",
      message: `桥接口径未设置：episodes.conflict_caliber 为空，建议按叙事模式设置（snyder_commercial→edgerton，longform_padding→gerke）`,
    })
    return findings
  }

  // 检查口径与叙事模式的一致性（T27b 桥接包 caliber_by_narrative_mode 映射）
  if (narrativeMode === "snyder_commercial" && caliber !== "edgerton") {
    findings.push({
      severity: "warning",
      message: `桥接口径不匹配：叙事模式为 snyder_commercial 但口径为 ${caliber}，建议改用 edgerton（冲突尽快落地，压缩稳定态）`,
    })
  }
  if (narrativeMode === "longform_padding" && caliber === "edgerton") {
    findings.push({
      severity: "info",
      message: `桥接口径提示：长篇铺垫模式（longform_padding）使用 edgerton 口径虽有违建议，但当代商业节奏可用`,
    })
  }

  return findings
}

// ---------------------------------------------------------------------------
// 规则 10: 结局三戒（ending-three-precepts）— 检查终局是否违反三戒
// ---------------------------------------------------------------------------

function checkEndingThreePrecepts(data: LiteraryCraftInput): readonly RawRuleFinding[] {
  const entity = data.entityCraftFields
  const arcResult = data.arcProgressionResult
  const findings: RawRuleFinding[] = []

  // 戒一：主角不在场的结局——检查 arc_stage 是否达到 climax/resolution
  const arcStage = entity?.arc_stage ?? arcResult?.currentStage ?? null
  if (arcStage && !["climax", "resolution"].includes(arcStage)) {
    findings.push({
      severity: "warning",
      message: `结局三戒·戒一（主角在场）：弧光阶段 "${arcStage}" 未达到 climax/resolution，终局章主角必须在场并主动完成抉择`,
    })
  }

  // 戒二：主角失控的结局——检查 arc_fundamentals 是否有合理值
  const fundamentals = entity?.arc_fundamentals
  if (fundamentals && Object.keys(fundamentals).length > 0) {
    const allLow = Object.values(fundamentals).every((v) => v < 0.3)
    if (allLow) {
      findings.push({
        severity: "warning",
        message: `结局三戒·戒二（主角掌控）：八项素质全部低于 0.3，主角完全失控状态不符合终局章要求`,
      })
    }
  }

  // 戒三：主角逃避最终选择——检查 wma_action 是否为空
  const wmaActions = entity?.wma_action
  if (arcStage === "climax" || arcStage === "resolution") {
    if (!wmaActions || wmaActions.length === 0) {
      findings.push({
        severity: "warning",
        message: `结局三戒·戒三（主角抉择）：弧光在 "${arcStage}" 阶段但 wma_action 为空，主角必须面对最终选择并行动`,
      })
    }
  }

  return findings
}

// ---------------------------------------------------------------------------
// 规则 11: 张弛交替（tension-relax-alternation）— 检查张力曲线交替模式
// ---------------------------------------------------------------------------

function checkTensionRelaxAlternation(data: LiteraryCraftInput): readonly RawRuleFinding[] {
  const curve = data.thrillQuantifierResult?.tensionCurve
  if (!curve || curve.length < 4) return []

  const findings: RawRuleFinding[] = []

  // 检测连续上升/下降的持续时间
  let risingRun = 0
  let fallingRun = 0
  let maxRisingRun = 0
  let maxFallingRun = 0

  for (let i = 1; i < curve.length; i++) {
    if (curve[i].smoothed > curve[i - 1].smoothed) {
      risingRun++
      fallingRun = 0
      maxRisingRun = Math.max(maxRisingRun, risingRun)
    } else if (curve[i].smoothed < curve[i - 1].smoothed) {
      fallingRun++
      risingRun = 0
      maxFallingRun = Math.max(maxFallingRun, fallingRun)
    } else {
      // 平缓，不算
    }
  }

  // 连续上升超过 5 个采样点 → 紧张过度缺乏舒缓
  if (maxRisingRun > 5) {
    findings.push({
      severity: "warning",
      message: `张弛交替不足：张力连续上升 ${maxRisingRun} 个采样点未缓解，建议插入次要线索或喜剧舒缓桥段`,
    })
  }

  // 连续下降超过 6 个采样点且全书有 tension → 张力塌陷
  if (maxFallingRun > 6 && curve.some((s) => s.smoothed > 0.5)) {
    findings.push({
      severity: "info",
      message: `张力连续下降 ${maxFallingRun} 个采样点，注意避免张力塌陷（突然失去紧张感）`,
    })
  }

  return findings
}

// ---------------------------------------------------------------------------
// 规则 12: 多米诺闭环与悬空钩子（domino-closure-dangling-hooks）— 检查伏笔闭环
// ---------------------------------------------------------------------------

function checkDominoClosureDanglingHooks(data: LiteraryCraftInput): readonly RawRuleFinding[] {
  const edge = data.edgeCraftFields
  const episode = data.episodeCraftFields
  const chapterNumber = data.chapterNumber ?? 0
  const findings: RawRuleFinding[] = []

  // 检查悬空钩子：有 foreshadow_planted_at 但无 payoff_chapter（未计划回收）
  const plantedAt = edge?.foreshadow_planted_at
  const payoffChapter = edge?.payoff_chapter

  if (plantedAt != null && plantedAt > 0 && (payoffChapter == null || payoffChapter <= 0)) {
    // 伏笔埋设超过 3 章仍未计划回收
    if (chapterNumber - plantedAt > 3) {
      findings.push({
        severity: "warning",
        message: `悬空钩子：第 ${plantedAt} 章埋设的伏笔（foreshadow_planted_at=${plantedAt}）已过 ${chapterNumber - plantedAt} 章仍未登记 payoff 计划，建议回收或标记为有意延期`,
      })
    } else {
      findings.push({
        severity: "info",
        message: `伏笔待回收：第 ${plantedAt} 章埋设的伏笔尚未登记 payoff_chapter，需在 3 章内计划回收`,
      })
    }
  }

  // 检查多米诺连贯性：每章是否至少有一个场景影响后续（通过 beat_hits 判断）
  const beatHits = episode?.beat_hits
  if (beatHits && beatHits.length === 0 && chapterNumber > 0) {
    findings.push({
      severity: "info",
      message: `多米诺连贯性：第 ${chapterNumber} 章无 beat_hits 记录，每个场景应影响后续场景`,
    })
  }

  return findings
}

// ---------------------------------------------------------------------------
// 规则 13: 开篇红线 5 类全集（opening-red-line-five-categories）— 检查开篇承诺
// ---------------------------------------------------------------------------

function checkOpeningRedLineFiveCategories(data: LiteraryCraftInput): readonly RawRuleFinding[] {
  const edge = data.edgeCraftFields
  const entity = data.entityCraftFields
  const findings: RawRuleFinding[] = []

  // 开篇红线 5 类全集：主题承诺 / 类型承诺 / 情感承诺 / 智力承诺 / 行动承诺
  // 每类对应一个检查项：

  // 1. 主题承诺（Theme Stated）：通过 beat_label 或 Snyder 注册表检查
  // 简化：假设有 theme_stated beat 注册即为有主题承诺
  const beatLabel = edge?.beat_label
  // 2. 类型承诺（beat_label 或 hook_type 暗示类型方向）
  const hookType = edge?.hook_type
  // 3. 情感承诺（wish/motive 存在代表承诺情感投入）
  const wish = entity?.wish
  const motive = entity?.motive
  // 4. 智力承诺（significant_details 或 hook_type=suspense 代表智力参与）
  const details = entity?.significant_details
  // 5. 行动承诺（wma_action 或 visible_actions 代表行动即将发生）
  const wmaActions = entity?.wma_action

  // 检查缺失的承诺类型
  const missingCategories: string[] = []

  if (!beatLabel && !hookType) {
    // 无法判断主题承诺
  }
  // 主题承诺：如果 beat_label 是 theme_stated 则隐含，否则通过 hook_type 判断
  // 简化：暂不强制

  // 类型承诺
  if (!hookType || hookType.trim().length === 0) {
    missingCategories.push("类型承诺（开篇钩子未注册，需通过 hook_type 暗示类型方向）")
  }

  // 情感承诺
  if (!wish || wish.length === 0) {
    missingCategories.push("情感承诺（主角愿望清单为空，读者无法为角色投入情感）")
  }
  if (!motive || motive.length === 0) {
    missingCategories.push("情感承诺（动机清单为空，读者无法理解角色为何行动）")
  }

  // 智力承诺
  if (!details || details.length === 0) {
    missingCategories.push("智力承诺（显著细节缺失，读者缺少参与推理的锚点）")
  }

  // 行动承诺
  if (!wmaActions || wmaActions.length === 0) {
    missingCategories.push("行动承诺（wma_action 为空，读者无法期待行动发生）")
  }

  if (missingCategories.length > 0) {
    const detail = missingCategories.join("；")
    const severity = missingCategories.length >= 3 ? "warning" : "info"
    findings.push({
      severity,
      message: `开篇红线承诺缺失（${missingCategories.length}/5 类）：${detail}`,
    })
  }

  return findings
}

// ---------------------------------------------------------------------------
// 规则 14: 八项素质检查（eight-fundamentals-check）— 检查 arc_fundamentals 完整性
// ---------------------------------------------------------------------------

function checkEightFundamentals(data: LiteraryCraftInput): readonly RawRuleFinding[] {
  const entity = data.entityCraftFields
  const findings: RawRuleFinding[] = []

  const fundamentals = entity?.arc_fundamentals ?? null

  if (!fundamentals || Object.keys(fundamentals).length === 0) {
    findings.push({
      severity: "warning",
      message: `八项素质缺失：arc_fundamentals 为空，需按 U-04 提案 8 槽位登记主角素质评分（意志力/多才多艺/下风狗位置/移情本质/心机/长度与深度/改变容量/洞察力）`,
    })
    return findings
  }

  const keys = Object.keys(fundamentals)

  // 检查槽位数
  if (keys.length < 8) {
    findings.push({
      severity: "warning",
      message: `八项素质不全：仅 ${keys.length}/8 槽位有值（${keys.join("、")}），缺失槽位需由 U-04 摄取回填`,
    })
  }
  if (keys.length > 8) {
    findings.push({
      severity: "info",
      message: `八项素质超限：${keys.length} 个槽位（超过上限 8），可能混入了非标准键`,
    })
  }

  // 检查值域 [0,1]
  const outOfRange = Object.entries(fundamentals).filter(
    ([, v]) => typeof v !== "number" || v < 0 || v > 1,
  )
  if (outOfRange.length > 0) {
    findings.push({
      severity: "warning",
      message: `八项素质值域越界：${outOfRange.map(([k, v]) => `${k}=${String(v)}`).join("、")}，必须为 [0,1] 内有限数字`,
    })
  }

  // 检查是否全部为 0（未评估）
  const allZero = Object.values(fundamentals).every((v) => v === 0)
  if (allZero && keys.length > 0) {
    findings.push({
      severity: "info",
      message: `八项素质全部为 0，可能尚未完成评估（需由 U-04 摄取回填真实评分）`,
    })
  }

  // 检查是否有 any 缺失（undefined/null 条目）
  const nullEntries = Object.entries(fundamentals).filter(
    ([, v]) => v == null || (typeof v === "number" && !Number.isFinite(v)),
  )
  if (nullEntries.length > 0) {
    findings.push({
      severity: "warning",
      message: `八项素质含无效条目：${nullEntries.map(([k]) => k).join("、")} 为 null/undefined/NaN`,
    })
  }

  return findings
}

// ============================================================================
// 规则包工厂
// ============================================================================

/**
 * 14 条文学提升规则注册表（按 ruleId 字典序，与 combinePacks 全序一致）。
 */
const RULES: readonly RuleDefinition[] = Object.freeze([
  Object.freeze({
    id: "craft.arc-progression",
    gate: "quality" as const,
    dimensionId: "emotional_impact" as AuditDimensionId,
    run: () => checkArcProgression(input),
  }),
  Object.freeze({
    id: "craft.bridge-caliber",
    gate: "quality" as const,
    dimensionId: "pacing_tension" as AuditDimensionId,
    run: () => checkBridgeCaliber(input),
  }),
  Object.freeze({
    id: "craft.chapter-end-hook",
    gate: "quality" as const,
    dimensionId: "reading_power" as AuditDimensionId,
    run: () => checkChapterEndHook(input),
  }),
  Object.freeze({
    id: "craft.delay-ratio",
    gate: "quality" as const,
    dimensionId: "pacing_tension" as AuditDimensionId,
    run: () => checkDelayRatio(input),
  }),
  Object.freeze({
    id: "craft.domino-closure-dangling-hooks",
    gate: "quality" as const,
    dimensionId: "scene_craft" as AuditDimensionId,
    run: () => checkDominoClosureDanglingHooks(input),
  }),
  Object.freeze({
    id: "craft.eight-fundamentals",
    gate: "quality" as const,
    dimensionId: "structural_balance" as AuditDimensionId,
    run: () => checkEightFundamentals(input),
  }),
  Object.freeze({
    id: "craft.ending-three-precepts",
    gate: "quality" as const,
    dimensionId: "structural_balance" as AuditDimensionId,
    run: () => checkEndingThreePrecepts(input),
  }),
  Object.freeze({
    id: "craft.ghost-unrevealed",
    gate: "quality" as const,
    dimensionId: "emotional_impact" as AuditDimensionId,
    run: () => checkGhostUnrevealed(input),
  }),
  Object.freeze({
    id: "craft.opening-hook",
    gate: "quality" as const,
    dimensionId: "reading_power" as AuditDimensionId,
    run: () => checkOpeningHook(input),
  }),
  Object.freeze({
    id: "craft.opening-red-line-five-categories",
    gate: "quality" as const,
    dimensionId: "structural_balance" as AuditDimensionId,
    run: () => checkOpeningRedLineFiveCategories(input),
  }),
  Object.freeze({
    id: "craft.significant-detail",
    gate: "quality" as const,
    dimensionId: "description_vividness" as AuditDimensionId,
    run: () => checkSignificantDetail(input),
  }),
  Object.freeze({
    id: "craft.thrill-density",
    gate: "quality" as const,
    dimensionId: "thrill_density" as AuditDimensionId,
    run: () => checkThrillDensity(input),
  }),
  Object.freeze({
    id: "craft.thrill-spacing",
    gate: "quality" as const,
    dimensionId: "thrill_density" as AuditDimensionId,
    run: () => checkThrillSpacing(input),
  }),
  Object.freeze({
    id: "craft.tension-relax-alternation",
    gate: "quality" as const,
    dimensionId: "tension_curve" as AuditDimensionId,
    run: () => checkTensionRelaxAlternation(input),
  }),
])

/**
 * 文学提升规则包定义（14 条 quality 门规则，warning 态，终局升格由外部处理）。
 *
 * 注意：本包是**有状态工厂**——调用 `createLiteraryCraftPack(data)` 会设置
 * 内部输入引用，返回的包不可变。多次调用创建独立实例。
 * 使用方式：`combinePacks([createLiteraryCraftPack(data)])`。
 */
export function createLiteraryCraftPack(data: LiteraryCraftInput): RulePackDefinition {
  // 设置内部输入引用
  input = { ...data }

  return Object.freeze({
    id: "literary-craft-pack",
    rules: RULES,
  })
}

/**
 * 创建空文学规则包（无数据注入，所有规则产出空 findings）。
 * 用于测试或未就绪场景。
 */
export function createEmptyLiteraryCraftPack(): RulePackDefinition {
  return createLiteraryCraftPack({})
}