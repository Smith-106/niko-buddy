/**
 * TASK-404 评估结论（2026-08-15）：6 维并行已落地（PERF-NEW-07，收益成立，无需再实施）。
 *
 * 证据（行号基于 2026-08-15 工作区实际读码）：
 * - 并行：runSixDimensionReview 内 `const settled = await Promise.all(keys.map(async (key) => ...))`
 *   （:590）—— 6 维每维独立 LLM 调用 + 独立 contextPack 只读消费，无相互依赖；串行需
 *   6 轮 LLM 往返，Promise.all 并行后墙钟从 6×LLM 降到 1×LLM。逐项 try/catch +
 *   buildFailedDimensionResult 保证单维失败（含 DimParseError 区分）不阻断其他维。
 * - UI 顺序约束：Promise.all 保序 → settled 数组顺序 = keys（缺省 SIX_REVIEW_DIMENSION_ORDER）；
 *   后续 `for (const { key, result, error } of settled)`（:636-651）按该顺序回填 results 并
 *   按序触发 onDimensionResult / onDimensionThinking，UI 收到即规范六维顺序，顺序约束已满足。
 * - 批量进度：onDimensionProgress 在并行启动时触发一次（:580，“六维审查并行启动”）；各维实时
 *   进度由 onDimensionThinking 流式覆盖（每维 token 即回调）。Promise.all 语义下“已完成 n/6”
 *   计数无增量信息（全部完成后才统一回填），不构成功能缺口，故不补计数。
 * - 同形孪生：与 context-data-sources.ts PERF-NEW-03 / context-engine.ts runVectorSearch 同形
 *   （PAT-G2：单点并行化须镜像同形 sibling），spec 断言 Object.keys(results) === 六维规范序。
 */
import { streamChat, combineAbortSignals, type StreamCallbacks } from "@/lib/llm-client"
import type { ChatMessage } from "@/lib/llm-providers"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import { logger, toErrorMessage } from "@/lib/utils"
import { buildContextPack, contextPackToPrompt, type ContextPack } from "./context-engine"
import { buildMeasurementFingerprint } from "./measurement-fingerprint"
import { createLiteraryExperimentProtocol } from "./literary-experiment-protocol"
import { resolveConsensusModels, resolveNovelModel } from "./model-resolver"
import { resolveTaskExtraPrompt } from "./task-customization"
import { appendTaskExtraSection } from "./deep-chapter-prompts"
import { runDimensionConsensus } from "./consensus-review"
import type { StyleExemplar } from "./style-exemplars-loader"
import {
  assessGoldScaleReadiness,
  formatGoldScalePromptBlock,
  loadGoldScaleMaterials,
  type LiteraryGoldAnchor,
} from "./literary-gold-scale"
import {
  createAvoidAiMechanicalSlopHook,
  createCedSoftReportHook,
  createDeAiDualPassHook,
  createGoldScaleReadinessHook,
  createStatisticalAiSignatureHook,
  registerNovelSkillHook,
  runNovelSkillHooks,
} from "./novel-skill-hooks"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import type { NovelReviewResult } from "./review-adapter"
import { sliceChapterForReview } from "./chapter-window"
import type { EvidenceVerificationResult } from "./evidence-chain"

// M10-3 切片：结果解析 / 评分判定纯逻辑块已迁至 ./dimension-result-scoring（纯函数零 IO 零 LLM）。
// 对外 export 的符号名与签名不变（下方 re-export 保 import 面）；本模块内部经同目录 import 回用。
import {
  buildFailedDimensionResult,
  deriveScoreVerdict,
  DIM_TO_GATE_TYPE,
  DimParseError,
  formatDimensionThinking,
  parseDimensionReviewResult,
  validateDimensionScoreBand,
} from "./dimension-result-scoring"
export {
  DIM_TO_GATE_TYPE,
  DimParseError,
  deriveScoreVerdict,
  minimalReworkSet,
  minimalReworkSetFromDimensionIssues,
  normalizeDimensionScore,
  parseDimensionReviewResult,
  validateDimensionScoreBand,
} from "./dimension-result-scoring"
export type { MinimalReworkIssue, ScoreDerivedVerdict } from "./dimension-result-scoring"

export type SixReviewDimensionKey = "thrill" | "consistency" | "pacing" | "character" | "continuity" | "pull"
export type DimensionReviewStatus = "error" | "high" | "medium" | "low" | "pass"

export interface SixReviewDimensionDefinition {
  key: SixReviewDimensionKey
  label: string
  objective: string
  stages: string[]
  checks: string[]
}

export interface DimensionReviewIssue extends NovelReviewResult {
  dimensionKey: SixReviewDimensionKey
  impact?: string
  rewriteTarget?: string
}

export interface DimensionReviewResult {
  dimensionKey: SixReviewDimensionKey
  score: number
  status: DimensionReviewStatus
  summary: string
  thinking: string
  issues: DimensionReviewIssue[]
  /**
   * 打这个分的评分模型（单模型为模型名；共识为 `consensus:` + 模型列表；机械短路为
   * `mechanical`）。不同评分模型的分数排序可能差很多，混排前必须看这个字段。
   * 可选：旧版本写入的历史结果没有该字段。
   */
  model?: string
}

export interface DimensionReviewCallbacks {
  onThinking?: (dimensionKey: SixReviewDimensionKey, thinking: string) => void
}

export interface SixDimensionReviewCallbacks {
  onDimensionProgress?: (dimensionKey: SixReviewDimensionKey, progress: string) => void
  onDimensionThinking?: (dimensionKey: SixReviewDimensionKey, thinking: string) => void
  onDimensionResult?: (dimensionKey: SixReviewDimensionKey, result: DimensionReviewResult) => void
  /** M0: ContextPack fingerprint for UI / Track B instrument identity. */
  onMeasurementFingerprint?: (fp: import("./measurement-fingerprint").MeasurementFingerprint) => void
}

export const SIX_REVIEW_DIMENSION_ORDER: SixReviewDimensionKey[] = [
  "thrill",
  "consistency",
  "pacing",
  "character",
  "continuity",
  "pull",
]

/** 机械短路（未调用 LLM）的维度在 `DimensionReviewResult.model` 上的标记。 */
export const MECHANICAL_SCORER_LABEL = "mechanical"

export interface ScoringModelSummary {
  /** 参与打分的 LLM 评分模型（去重、按首次出现顺序；不含机械短路）。 */
  models: string[]
  /** 至少一个维度是旧版本结果、没有记录评分模型。 */
  hasUnknown: boolean
  /** 不同维度由不同模型打分（例如换模型后只重跑了部分维度），分数不可直接对比。 */
  mixed: boolean
}

/**
 * 汇总一组六维结果的评分模型。不同评分模型对同一章的排序可能差很多（实测两个模型在
 * 71 章上的 Spearman 仅 0.38），所以 UI 必须在分数旁标明模型，并在混用时提示。
 */
export function summarizeScoringModels(
  results: Partial<Record<SixReviewDimensionKey, Pick<DimensionReviewResult, "model">>> | undefined,
): ScoringModelSummary {
  const models: string[] = []
  let hasUnknown = false
  for (const key of SIX_REVIEW_DIMENSION_ORDER) {
    const result = results?.[key]
    if (!result) continue
    const model = result.model?.trim()
    if (!model) {
      hasUnknown = true
      continue
    }
    if (model === MECHANICAL_SCORER_LABEL) continue
    if (!models.includes(model)) models.push(model)
  }
  return { models, hasUnknown, mixed: models.length > 1 || (hasUnknown && models.length > 0) }
}

/**
 * F-003 (ANL-010 C1): flatten the 6-dimension review result map into the
 * NovelReviewResult[] shape that deep-chapter-generation.ts's 18→3 fold
 * consumes. Each dimension's issues are tagged with the dimension key via
 * DIM_TO_GATE_TYPE so `resolveDecisionGateKey` buckets them into the correct
 * gate (character → consistency gate, NOT quality). The 6 dims were
 * previously generated by runSixDimensionReview but orphaned — they never
 * reached reviewResults (deep-chapter-generation.ts had no import; verified
 * grep-zero-match pre-F-003). This converter is the wiring point.
 *
 * Severity mapping: a DimensionReviewResult with status "error" yields
 * severity "error" (blocking); status "high"/"medium" yield "warning"
 * (route to stage-5 repair via collectRepairIssues); status "low"/"pass"
 * yield "info". The dimension's own issue severities (when present) are
 * preserved per-issue.
 */
/**
 * CORR-010 (from quality-review): map the dimension-level status to the
 * 3-tier NovelReviewResult severity, then take the MAX of that and the issue's
 * own severity. Previously this copied issue.severity verbatim, so a dimension
 * whose own status was "error" (blocking) could emit only "warning"-severity
 * issues — collectBlockingIssues (which keeps severity === "error" only) would
 * then DROP the dimension entirely, defeating the gate. The dimension's own
 * status is authoritative: status "error" → at least "error"; "high"/"medium"
 * → at least "warning"; "low"/"pass" → "info".
 */
/**
 * §GAP-88-02 评分与 verdict 解耦（ainovel editor.md 模式）：模型只打分不判刑。
 * status 是档位下限语义（error→阻断级 / high|medium→返修级 / low|pass→通过级），
 * 最终门控裁定只读 score（见 deriveScoreVerdict），status 不直接决定门控。
 * 档位-score 一致性由 validateDimensionScoreBand 机械校验。
 */
function severityForIssue(
  dimStatus: DimensionReviewStatus,
  issueSeverity: NovelReviewResult["severity"],
): NovelReviewResult["severity"] {
  const fromStatus: NovelReviewResult["severity"] =
    dimStatus === "error" ? "error"
    : dimStatus === "high" || dimStatus === "medium" ? "warning"
    : "info"
  // MAX by blocking order: error > warning > info. The dimension status is the
  // floor; an individual issue may still be more severe than its dimension
  // (e.g. a "medium" dimension surfacing one genuinely blocking issue).
  const order: Record<NovelReviewResult["severity"], number> = { error: 2, warning: 1, info: 0 }
  return order[issueSeverity] > order[fromStatus] ? issueSeverity : fromStatus
}

/**
 * EPIC-004 / ADR-33 / TASK-009: pure read accessor over the `dimension_results`
 * field persisted on NovelSessionStatus (S3 F-003 additive field). Returns the
 * non-undefined dimension results in the canonical SIX_REVIEW_DIMENSION_ORDER,
 * deriving a view over the status.json truth-source — NOT a module-level cache
 * (HARD-1: no second truth source). Inspector (queryInspectorState) consumes
 * this to render cached 6-dim findings without triggering a new review run.
 *
 * Accepts `undefined` (older status files without the field, or fresh-base
 * status) and returns `[]` — graceful degradation. The caller is expected to
 * pass `status.dimension_results` from loadNovelSessionStatus; this function
 * performs no I/O and mutates nothing.
 */
export function getCachedDimensionResults(
  dimensionResults: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>> | undefined,
): DimensionReviewResult[] {
  if (!dimensionResults) return []
  const out: DimensionReviewResult[] = []
  for (const key of SIX_REVIEW_DIMENSION_ORDER) {
    const result = dimensionResults[key]
    if (result) out.push(result)
  }
  return out
}

/**
 * F-001 (v2.6 Tier1 must): verify that issue.evidence appears verbatim
 * (after whitespace normalization) in the chapter body. Pure function — no
 * side effects, no I/O.
 *
 * Normalization: trim + collapse all whitespace runs to single space.
 * Match strategy: substring includes on normalized strings.
 *
 * On failure: the issue severity is downgraded to "warning", and evidence is
 * replaced with the nearest matching fragment from findNearestEvidenceFragment.
 */
export function verifyEvidenceCitations(
  evidence: string,
  chapterBody: string,
): EvidenceVerificationResult {
  // Empty evidence edge case — nothing to verify
  if (!evidence.trim()) {
    return {
      passed: false,
      originalEvidence: evidence,
      resolvedEvidence: "",
      matchType: "fallback",
    }
  }

  // Strip all whitespace for comparison so extra spaces, tabs, or newlines in
  // the LLM output do not prevent a verbatim match on the actual content.
  const normalize = (s: string): string => s.replace(/\s+/g, "")
  const normalizedEvidence = normalize(evidence)
  const normalizedBody = normalize(chapterBody)

  // Verbatim substring match after stripping whitespace
  if (normalizedBody.includes(normalizedEvidence)) {
    return {
      passed: true,
      originalEvidence: evidence,
      resolvedEvidence: evidence,
      matchType: "verbatim",
    }
  }

  // Fallback: find nearest fragment via sliding-window Levenshtein
  const nearest = findNearestEvidenceFragment(chapterBody, evidence)
  return {
    passed: false,
    originalEvidence: evidence,
    resolvedEvidence: nearest || evidence,
    matchType: "fallback",
  }
}

/**
 * F-001: sliding-window Levenshtein-distance search for the fragment in
 * chapterBody that most closely matches the evidence string. Windows of
 * length evidenceLen ±20% are evaluated. Returns the closest fragment, or
 * empty string if no reasonable match is found.
 */
export function findNearestEvidenceFragment(
  chapterBody: string,
  evidence: string,
): string {
  // Strip all whitespace for comparison (same normalize as verifyEvidenceCitations)
  const normalize = (s: string): string => s.replace(/\s+/g, "")
  const normalizedEvidence = normalize(evidence)
  const normalizedBody = normalize(chapterBody)

  const evidenceLen = normalizedEvidence.length
  if (evidenceLen === 0) return ""
  const bodyLen = normalizedBody.length
  if (bodyLen === 0) return ""

  // Sliding window: try windows of length [80%, 120%] of evidence length
  const minLen = Math.max(1, Math.floor(evidenceLen * 0.8))
  const maxLen = Math.min(bodyLen, Math.ceil(evidenceLen * 1.2))

  let bestDistance = Infinity
  let bestFragment = ""

  for (let winLen = minLen; winLen <= maxLen; winLen++) {
    for (let start = 0; start <= bodyLen - winLen; start++) {
      const fragment = normalizedBody.slice(start, start + winLen)
      const dist = levenshteinDistance(normalizedEvidence, fragment)
      if (dist < bestDistance) {
        bestDistance = dist
        bestFragment = fragment
      }
    }
  }

  return bestFragment
}

/** F-001: standard Levenshtein edit distance (iterative DP). */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      )
    }
  }
  return dp[m][n]
}

export function dimensionResultsToReviewResults(
  dimensionResults: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>,
  chapterBody?: string,
): NovelReviewResult[] {
  const out: NovelReviewResult[] = []
  for (const key of SIX_REVIEW_DIMENSION_ORDER) {
    const result = dimensionResults[key]
    if (!result) continue
    const reviewType = DIM_TO_GATE_TYPE[key]
    let droppedEvidenceCount = 0
    // §GAP-88-02 score 派生 error 下限：举证扣减后有效分落入硬伤档（≤4）时，
    // 该维按 error 处理 —— 模型只打分，是否阻断由系统按有效分裁定。
    const scoreErrorFloor = (): NovelReviewResult["severity"] | null => {
      const effective = Math.max(0, result.score - droppedEvidenceCount)
      return deriveScoreVerdict(effective) === "error" ? "error" : null
    }
    const dimStartLen = out.length
    if (result.issues.length > 0) {
      for (const issue of result.issues) {
        // F-001 (v2.6 Tier1 must): mechanical evidence citation verification.
        // Check each issue's evidence against the chapter body; on failure
        // downgrade severity to "warning" and backfill the nearest fragment.
        // §GAP-88-03 (ainovel 强制举证硬门): 有 chapterBody（真实正文可对）
        // 时，空 evidence 或校验失败的 issue 不计入门控（跳过，不再回填
        // warning 占位），且该维 score 按 1 分/条扣减下限 0（出口条款机械
        // 执行）。error 级 issue 校验失败同样跳过：不可信的阻断不断章（防误
        // 修订，对齐 parseFailed 语义）。无 chapterBody（旧调用/单元凭空
        // evidence）时沿用旧语义保留 issue，避免误杀。
        let severity: NovelReviewResult["severity"] = severityForIssue(result.status, issue.severity)
        let evidence = issue.evidence || ""
        let evidenceDropped = false
        // §GAP-88-03 举证作用域纪律：仅在生产链传入 chapterBody（真实章节
        // 正文）时做机械举证校验。单元测试凭空构造 evidence（如 "ex"）无
        // 正文可对，不应误杀 —— 无 chapterBody 时沿用旧语义（保留 issue，
        // 不扣分），硬门只在真实正文可得时生效。
        if (chapterBody) {
          if (evidence) {
            const verification = verifyEvidenceCitations(evidence, chapterBody)
            if (!verification.passed) {
              evidenceDropped = true
            }
          } else {
            // 空 evidence = 无举证：硬门直接丢弃（旧回填 warning 占位语义废止）
            evidenceDropped = true
          }
        }
        if (evidenceDropped) {
          droppedEvidenceCount += 1
          continue
        }
        // §GAP-88-02：举证扣减后有效分落入硬伤档 → 该 issue 升 error（系统裁定）。
        if (deriveScoreVerdict(Math.max(0, result.score - droppedEvidenceCount)) === "error") {
          severity = "error"
        }
        out.push({
          severity,
          // Override the issue's `type` with the gate-bucketed type so the
          // fold routes correctly. Keep the dimension key in the message
          // prefix for traceability.
          type: reviewType,
          message: `[${result.summary || key}] ${issue.message || ""}`.trim(),
          evidence,
          relatedMemory: issue.relatedMemory || "",
          suggestion: issue.suggestion || "",
        })
      }
      // §GAP-88-03 全丢弃回退：有 issue 但举证校验全部丢弃时，本维不能零
      // finding 沉默（否则门控以为该维未评审）。按无 issue 出口条款结算：
      // 有效分 <8.5 → warning 出口 finding（含举证丢弃计数），有效分落入
      // 硬伤档 → 补 error 级 score-floor finding 保持阻断可见。
      if (out.length === dimStartLen && droppedEvidenceCount > 0) {
        const effectiveScore = Math.max(0, result.score - droppedEvidenceCount)
        const exitViolation =
          deriveScoreVerdict(effectiveScore) !== "info" ||
          (result.score < 8.5 && !result.summary.trim())
        out.push({
          severity: exitViolation ? "warning" : "info",
          type: reviewType,
          message: `${SIX_REVIEW_DIMENSIONS[key].label}：${result.summary || "pass"} (score ${result.score}, 举证丢弃${droppedEvidenceCount}条有效${effectiveScore})`,
          evidence: "",
          relatedMemory: "",
          suggestion: exitViolation ? "对照档位行为定义补足检查项兑现或下调分数。" : "",
        })
        const bandFinding = validateDimensionScoreBand(key, result.score, result.status)
        if (bandFinding) out.push(bandFinding)
        if (scoreErrorFloor() === "error") {
          out.push({
            severity: "error",
            type: reviewType,
            message: `[${result.summary || key}] 维度有效分 ${effectiveScore} 落入硬伤档`,
            evidence: "",
            relatedMemory: "score-floor",
            suggestion: "返修正文或重审该维度。",
          })
        }
      }
    } else {
      // Dimension produced no issues — emit an info-level summary so the
      // gate still records that the dimension was reviewed.
      // §GAP-88-02 出口条款机械执行：无 issue 但有效分 <8.5 → warning（含举证
      // 扣减后的有效分），summary 未列未兑现项同样 warning —— 无举证不给高分。
      // 顺序：摘要 finding 始终首位（守旧 spec results[0] 摘要不变量），档位
      // 不一致 finding 追加其后。
      const effectiveScore = Math.max(0, result.score - droppedEvidenceCount)
      const exitViolation =
        deriveScoreVerdict(effectiveScore) !== "info" ||
        (result.score < 8.5 && !result.summary.trim())
      out.push({
        severity: exitViolation ? "warning" : "info",
        type: reviewType,
        message: `${SIX_REVIEW_DIMENSIONS[key].label}：${result.summary || "pass"} (score ${result.score}${droppedEvidenceCount > 0 ? `, 举证丢弃${droppedEvidenceCount}条有效${effectiveScore}` : ""})`,
        evidence: "",
        relatedMemory: "",
        suggestion: exitViolation ? "对照档位行为定义补足检查项兑现或下调分数。" : "",
      })
      const bandFinding = validateDimensionScoreBand(key, result.score, result.status)
      if (bandFinding) out.push(bandFinding)
      // score 下限 error 但零 issue：维度自身状态权威（CORR-010），补 error
      // finding 使 collectBlockingIssues 可见 —— 否则高分零举证可绕过阻断。
      const floor = scoreErrorFloor()
      if (floor === "error") {
        out.push({
          severity: "error",
          type: reviewType,
          message: `[${result.summary || key}] 维度有效分 ${effectiveScore} 落入硬伤档`,
          evidence: "",
          relatedMemory: "score-floor",
          suggestion: "返修正文或重审该维度。",
        })
      }
    }
  }
  return out
}

export const SIX_REVIEW_DIMENSIONS: Record<SixReviewDimensionKey, SixReviewDimensionDefinition> = {
  thrill: {
    key: "thrill",
    label: "爽感密度",
    objective: "判断章节是否建立并兑现有效爽点，而不是只检查剧情是否发生。",
    stages: ["爽点预期识别", "压抑与释放链检查", "主角能动性检查", "爽点密度检查", "爽点失效诊断"],
    checks: ["打脸、反杀、成长、揭谜、奖励兑现是否成立", "期待、阻力、升级、反转、兑现链条是否完整", "爽点是否由主角选择、能力或决断推动", "解释、重复和旁人代打是否削弱爽感"],
  },
  consistency: {
    key: "consistency",
    label: "设定自治",
    objective: "判断设定是否能自洽地推动剧情，而不是临时为剧情让路。",
    stages: ["已登记设定读取", "新设定识别", "规则一致性检查", "代价与边界检查", "设定推动剧情检查"],
    checks: ["能力、物品、组织、地点和规则是否违背旧设定", "新增规则是否有边界、代价和触发条件", "设定是否参与冲突和选择", "是否存在作者硬送或临时开挂"],
  },
  pacing: {
    key: "pacing",
    label: "节奏张力",
    objective: "判断章节是否有推进力、压力变化和持续阅读的节奏。",
    stages: ["场景结构拆分", "张力曲线检查", "信息密度检查", "转折频率检查", "拖沓与跳跃诊断"],
    checks: ["每个场景是否有目标、阻力和结果", "张力是否升级或反转", "说明、内心和背景是否压过行动", "是否存在水文、重复、跳转过快或关键冲突没写足"],
  },
  character: {
    key: "character",
    label: "人设一致",
    objective: "判断人物行为、语言、认知和情绪是否符合既有人设。",
    stages: ["人物状态读取", "行为动机检查", "语言风格检查", "认知边界检查", "成长弧线检查"],
    checks: ["关键选择是否有动机", "台词是否符合身份、性格和关系", "角色是否知道了不该知道的信息", "变化是否有触发原因和过渡"],
  },
  continuity: {
    key: "continuity",
    label: "叙事衔接",
    objective: "判断本章是否和前文、大纲、记忆库顺畅连接。",
    stages: ["前章结尾对接", "章纲目标对接", "时间线检查", "地点与物品连续性检查", "因果链检查"],
    checks: ["开头是否承接上一章地点、状态、情绪和动作", "正文是否完成当前章纲目标", "时间、地点、伤势、物品和伏笔是否连续", "事件是否有清晰因果"],
  },
  pull: {
    key: "pull",
    label: "追读引力",
    objective: "判断读者看完本章后是否有继续阅读下一章的动力。",
    stages: ["本章核心悬念识别", "结尾钩子检查", "下一章承诺检查", "情绪停点检查", "假悬念过滤"],
    checks: ["是否留下新危机、新目标、新反转或新信息", "下一章期待是否明确", "结尾是否停在高张力或强情绪点", "悬念是否有正文证据而不是空钩子"],
  },
}

export function buildDimensionReviewPrompt(
  pack: ContextPack,
  chapterContent: string,
  dimension: SixReviewDimensionDefinition,
  options?: {
    /** Merged gold anchors (file + exemplar import). Track B only. */
    goldAnchors?: LiteraryGoldAnchor[]
    /** Precomputed readiness hint; if omitted and anchors provided, computed. */
    goldReadinessHint?: string
    /** P2-IMP-07: hardInject 渲染门穿参（缺省 undefined → flag 默认 false，零行为变化）。 */
    hardInjectEnabled?: boolean
  },
): string {
  const goldExtra = buildGoldScaleReviewBlock(dimension.key, options?.goldAnchors, options?.goldReadinessHint)
  return `${contextPackToPrompt(pack, undefined, { hardInjectEnabled: options?.hardInjectEnabled })}

六维独立审查维度：${dimension.label}
审查目标：${dimension.objective}

专业工作流：
${dimension.stages.map((stage, index) => `${index + 1}. ${stage}`).join("\n")}

检查标准：
${dimension.checks.map((check) => `- ${check}`).join("\n")}

阶段分析要求：
只输出阶段分析，不要输出结构化对象。必须先列已核对依据，再列阶段结论，并明确问题对应的正文证据。

评分量程与档位（校准锚点，必须严格遵守）：
- 量程：0-10 分。严禁按先验习惯区间（如 6-8）打分，必须对照下列档位行为定义给出分数。
  - 0-4 分：存在硬伤级问题（连贯性破坏、主线偏离、明显语病或逻辑错误），属于未完成/失败段。
  - 5-6 分：及格线——无硬伤但平淡，检查项多数未兑现或兑现力度弱。
  - 7-8 分：良级——无硬伤，检查项基本兑现，有阅读价值但缺乏出彩点。
  - 9-10 分：可发表文学质量——检查项全部兑现且有出彩点（强画面感/叙事节奏/情绪冲击/主题升华），达到出版级参照水准。
- 出口条款：若本维度所有检查项均通过、且 issues 中没有任何 error/warning 级问题，score 必须 ≥8.5；若打出 <8.5，summary 必须明确列出未兑现的检查项。
- 举证条款（强制）：每个 issue 的 evidence 字段必须是从下方“章节正文”逐字摘出的原文片段（允许只去空白差异），不得编造、概括或转述；无原文可引的问题必须删除。evidence 为空或经系统校验与正文不匹配时，该 issue 将被忽略且本维度 score 按规则扣减——无举证不给高分。
- 打分理由：summary 必须引用对应档位的行为定义，说明分数落在该档的原因。${buildStyleExemplarBlock(pack.styleExemplars)}${goldExtra}

结构化结果格式：
{
  "score": 0.0,
  "status": "error|high|medium|low|pass",
  "summary": "本维度审查摘要（须引用档位行为定义；score 为 0-10 一位小数）",
  "issues": [
    {
      "severity": "error|warning|info",
      "type": "${dimension.key}",
      "message": "问题描述",
      "evidence": "正文片段",
      "relatedMemory": "相关大纲、记忆或设定",
      "suggestion": "修改建议",
      "impact": "对本维度的影响",
      "rewriteTarget": "建议 AI 修改时定位的原文片段"
    }
  ]
}

章节正文：
${sliceChapterForReview(chapterContent)}`
}

/**
 * Step 0 A/B 校准（20260806 swarm 共识）：把 pack.styleExemplars（人类标注的
 * 正向风格标杆，EPIC-001/ADR-29 已注入 contextPack）渲染为 9-10 档 few-shot
 * 参照。零 exemplar 时返回空串，prompt 保持向后兼容（不改变既有审查行为）。
 */
function buildStyleExemplarBlock(styleExemplars: StyleExemplar[] | undefined): string {
  if (!styleExemplars || styleExemplars.length === 0) return ""
  const markTypeLabel: Record<StyleExemplar["markType"], string> = {
    style: "文风",
    voice: "声线/对白",
    pacing: "节奏",
    thrill: "爽感兑现",
    pull: "追读钩子",
    consistency: "设定自洽",
  }
  const lines = styleExemplars.map((ex) => {
    const excerpt = ex.text.length > 200 ? `${ex.text.slice(0, 200)}…` : ex.text
    return `- [${markTypeLabel[ex.markType]}] ${excerpt}`
  })
  return `\n风格标杆样本（人类标注的真实好段落，仅作 9-10 档参照，不得直接改写正文）：\n${lines.join("\n")}`
}


/**
 * Track B gold-scale block for thril/pull dimensions (humanGoldFloor=9).
 * Not a product hard gate. Empty anchors → honest NOT_READY note.
 */
function buildGoldScaleReviewBlock(
  dimensionKey: SixReviewDimensionKey,
  goldAnchors: LiteraryGoldAnchor[] | undefined,
  readinessHint?: string,
): string {
  if (dimensionKey !== "thrill" && dimensionKey !== "pull") return ""
  const dim = dimensionKey === "pull" ? "pull" : "thrill"
  const anchors = goldAnchors ?? []
  const block = formatGoldScalePromptBlock(anchors, { dimension: dim, max: 3 })
  if (block) return `\n${block}`
  const hint =
    readinessHint
    ?? assessGoldScaleReadiness({ anchors }).promptHint
  return `\n【文学金标量程 · ${dim} · 非产品硬门】\n${hint}`
}

export async function reviewChapterDimension({
  llmConfig,
  contextPack,
  chapterContent,
  dimension,
  callbacks = {},
  signal,
  novelConfig,
  goldAnchors,
  goldReadinessHint,
}: {
  llmConfig: LlmConfig
  contextPack: ContextPack
  chapterContent: string
  dimension: SixReviewDimensionDefinition
  callbacks?: DimensionReviewCallbacks
  signal?: AbortSignal
  /**
   * ISS-20260709-023 (DC-7) 渐进式 DI: 缺省回退 useWikiStore 保持向后兼容。
   */
  novelConfig?: NovelConfig
  /** Track B gold anchors for thril/pull prompt injection. */
  goldAnchors?: LiteraryGoldAnchor[]
  goldReadinessHint?: string
}): Promise<DimensionReviewResult> {
  callbacks.onThinking?.(dimension.key, formatDimensionThinking(dimension, "正在读取上下文..."))
  const analysisPrompt = buildDimensionReviewPrompt(contextPack, chapterContent, dimension, {
    goldAnchors: goldAnchors,
    goldReadinessHint: goldReadinessHint,
    // P2-IMP-07: hardInject 渲染门穿参（缺省 undefined → flag 默认 false，零行为变化）。
    hardInjectEnabled: novelConfig?.hardInjectEnabled,
  })
  const analysis = await runDimensionStage(
    llmConfig,
    dimension,
    analysisPrompt,
    callbacks,
    signal,
    novelConfig,
  )

  const finalPrompt = [
    analysisPrompt,
    "",
    "阶段分析结果：",
    analysis,
    "",
    "最终 JSON：",
    "只输出最终 JSON 对象，不要输出解释、标题或 markdown。",
  ].join("\n")
  const finalText = await runDimensionStage(llmConfig, dimension, finalPrompt, callbacks, signal, novelConfig)
  return parseDimensionReviewResult(dimension, finalText, analysis)
}

export async function runSixDimensionReview({
  projectPath,
  chapterContent,
  chapterNumber,
  dimensionKeys,
  callbacks = {},
  signal,
  llmConfig,
  novelConfig,
  novelMode,
  priorReviewResults,
  contextPack: injectedContextPack,
}: {
  projectPath: string
  chapterContent: string
  chapterNumber?: number
  dimensionKeys?: SixReviewDimensionKey[]
  callbacks?: SixDimensionReviewCallbacks
  signal?: AbortSignal
  /**
   * ISS-20260709-023 (DC-7) 渐进式 DI: store 字段注入。缺省回退 useWikiStore
   * 保持向后兼容。
   */
  llmConfig?: LlmConfig
  novelConfig?: NovelConfig
  novelMode?: boolean
  /**
   * TASK-008 (GRL-011 Decision 4.2): 机械先于语义短路。调用方 (deep-chapter-
   * generation.runFullReviewWithSixDim) 把 review-adapter.reviewChapter 已产出的
   * findings 传入, continuity 维度读到含 consistency_mechanical subtype 时降级
   * pass 跳 LLM 调用省 token。短路范围 ONLY 机械已检 subtype (休眠/缺席/逾期/
   * 死亡活跃), LLM continuity 仍检机械覆盖外语义矛盾 (时间线逻辑矛盾非章号偏移)。
   * 可选参数, 未传时六维全跑 LLM (向后兼容, 当前 runFullReviewWithSixDim 并行
   * 调用未传 — 接线由后续 plan session 在 deep-chapter-generation.ts 调用点做,
   * 本 TASK 不改 deep-chapter-generation.ts 出 scope)。
   */
  priorReviewResults?: NovelReviewResult[]
  /**
   * ISS-20260713-002: 复用调用方已持有的 ContextPack（零重建）。
   * runFullReviewWithSixDim 入参即持有 contextPack（并已传给 reviewChapter），
   * 改前本函数无视该包、无条件再 `await buildContextPack` 一次（整包重建 ≈
   * 数十次 wiki IO + rerank）。传入时直接复用（prompt/指纹/六维只读消费同一
   * 包）；未传时回退原行为（UI 单文件重跑等无包路径不受影响）。
   */
  contextPack?: ContextPack
}): Promise<Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>> {
  const injectedNovelConfig = novelConfig ?? useWikiStore.getState().novelConfig
  const llmConfigResolved = resolveNovelModel(
    llmConfig ?? useWikiStore.getState().llmConfig,
    injectedNovelConfig,
    "review",
  )
  if (!hasUsableLlm(llmConfigResolved) || !(novelMode ?? useWikiStore.getState().novelMode)) return {}

  // ISS-20260713-002: 调用方已传包时复用，跳过整包重建；未传时沿用原 build 路径。
  const contextPack = injectedContextPack ?? await buildContextPack(
    projectPath,
    `六维审查第${chapterNumber || "?"}章`,
    chapterNumber,
  )

  // M0: attach measurement fingerprint for UI / logs (Track B instrument identity)
  try {
    const protocol = createLiteraryExperimentProtocol({
      model: injectedNovelConfig.consensusEnabled
        ? `consensus:debate${injectedNovelConfig.consensusDebateRounds}`
        : llmConfigResolved.model || "unknown",
      samples: 1,
      label: `ui-six-dim-ch${chapterNumber ?? "?"}`,
      notes: ["UI six-dimension run fingerprint; N=1 is display-only not seal"],
    })
    const measurementFingerprint = buildMeasurementFingerprint({
      protocol,
      pack: contextPack,
      chapterText: chapterContent,
      packKind: "app-runtime-six-dimension",
    })
    callbacks.onMeasurementFingerprint?.(measurementFingerprint)
  } catch (err) {
    // non-fatal
    // ISS-20260709-025 PAT-IM2: 记诊断，控制流不变（指纹失败不阻断六维）。
    logger.warn("SixDim", "measurement fingerprint failed (non-fatal)", { error: toErrorMessage(err) })
  }

  // Track B: gold scale materials + skill hooks at pre_six_dim_review (soft).
  let goldAnchors: LiteraryGoldAnchor[] = []
  let goldReadinessHint: string | undefined
  try {
    const materials = await loadGoldScaleMaterials(projectPath)
    goldAnchors = materials.merged
    const readiness = assessGoldScaleReadiness({
      anchors: materials.anchors,
      exemplars: materials.exemplars,
    })
    goldReadinessHint = readiness.promptHint
    try {
      registerNovelSkillHook(createGoldScaleReadinessHook(readiness.promptHint))
    } catch (err) {
      // registry may already have same id — ignore
      // ISS-20260709-025 PAT-IM2: 记诊断，控制流不变。
      logger.warn("SixDim", "gold readiness hook register skipped (non-fatal)", { error: toErrorMessage(err) })
    }
    try {
      // Track B soft: mechanical avoid-ai / slop (zero-LLM). Not product hard gate.
      registerNovelSkillHook(
        createAvoidAiMechanicalSlopHook({
          text: chapterContent,
          stages: ["pre_six_dim_review"],
        }),
      )
    } catch (err) {
      // ignore registry race
      // ISS-20260709-025 PAT-IM2: 记诊断，控制流不变。
      logger.warn("SixDim", "avoid-ai slop hook register skipped (non-fatal)", { error: toErrorMessage(err) })
    }
    try {
      // Wave A CED soft report (empty findings here; full CED logs in continuity preflight).
      // Density uses chapter text; never product hard gate.
      registerNovelSkillHook(
        createCedSoftReportHook({
          findings: [],
          textForWordCount: chapterContent,
          stages: ["pre_six_dim_review"],
        }),
      )
    } catch (err) {
      // ignore registry race
      // ISS-20260709-025 PAT-IM2: 记诊断，控制流不变。
      logger.warn("SixDim", "ced soft hook register skipped (non-fatal)", { error: toErrorMessage(err) })
    }
    try {
      // Wave C: dual-pass de-AI notes (Track B soft; never product hard gate).
      registerNovelSkillHook(
        createDeAiDualPassHook({
          text: chapterContent,
          stages: ["pre_six_dim_review"],
        }),
      )
    } catch (err) {
      // ignore registry race
      // ISS-20260709-025 PAT-IM2: 记诊断，控制流不变。
      logger.warn("SixDim", "de-ai dualpass hook register skipped (non-fatal)", { error: toErrorMessage(err) })
    }
    try {
      // Wave C: statistical AI signature proxy (experimental; soft only).
      registerNovelSkillHook(
        createStatisticalAiSignatureHook({
          text: chapterContent,
          stages: ["pre_six_dim_review"],
        }),
      )
    } catch (err) {
      // ignore registry race
      // ISS-20260709-025 PAT-IM2: 记诊断，控制流不变。
      logger.warn("SixDim", "statistical-ai-signature hook register skipped (non-fatal)", { error: toErrorMessage(err) })
    }
    const hookCtx = await runNovelSkillHooks("pre_six_dim_review", {
      projectPath,
      chapterNumber,
    })
    if (hookCtx.bag.promptFragments.length > 0) {
      // gold readiness + optional avoid-ai soft fragments
      goldReadinessHint = hookCtx.bag.promptFragments.join("\n")
    }
  } catch (err) {
    logger.warn("SixDimReview", "gold scale / skill hooks soft-failed", {
      error: toErrorMessage(err),
    })
  }

  const results: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>> = {}
  const keys = dimensionKeys ?? SIX_REVIEW_DIMENSION_ORDER
  // PERF-NEW-07: 6 维审查无相互依赖（每维独立 LLM 调用 + 独立 contextPack 只读消费 +
  // results 按 key 独立存储），串行 for-await 每维 1 轮 LLM 往返共 6 轮。
  // 改 Promise.all 并行 → 6 维并发，墙钟从 6×LLM 降到 1×LLM。
  // 与 context-data-sources.ts PERF-NEW-03 / context-engine.ts runVectorSearch 同形孪生
  // （PAT-G2：单点并行化须镜像同形 sibling，否则下次扫描漏改）。
  // 逐项 try/catch 保留 F-003 DimParseError 区分（parse 失败 vs stream 错误），
  // 失败维度走 buildFailedDimensionResult 不阻断其他维度。顺序由 keys 数组保序。
  callbacks.onDimensionProgress?.(keys[0], "六维审查并行启动")
  // TASK-008 (GRL-011 Decision 4.2): 机械先于语义短路 — continuity 维度机械已检
  // (priorReviewResults 含 consistency_mechanical subtype) 时跳 LLM 调用省 token。
  // 短路范围 ONLY 机械已检 subtype (休眠/缺席/逾期/死亡活跃); LLM continuity 仍
  // 检机械覆盖外语义矛盾 (时间线逻辑矛盾非章号偏移) — 故短路产 pass + 备注, 不
  // 替代全量 LLM continuity 审查的语义覆盖。priorReviewResults 缺省 (undefined)
  // 时六维全跑 LLM (向后兼容)。
  const hasMechanicalContinuity = Boolean(
    priorReviewResults && priorReviewResults.some(r => r.type === "consistency_mechanical"),
  )
  const settled = await Promise.all(
    keys.map(async (key) => {
      const dimension = SIX_REVIEW_DIMENSIONS[key]
      // continuity 维度机械短路 (Decision 4.2): 跳 LLM 调用, 产 pass 占位结果
      if (key === "continuity" && hasMechanicalContinuity) {
        const shortCircuitResult: DimensionReviewResult = {
          dimensionKey: "continuity",
          // 0-10 量程（与 buildDimensionReviewPrompt / normalizeScore 对齐；禁止 0-100 遗留）
          score: 10,
          status: "pass",
          summary: "机械连续性引擎已前置检测 (consistency_mechanical), LLM continuity 维度短路省 token; 机械覆盖外语义矛盾仍需人工复核",
          thinking: formatDimensionThinking(dimension, "机械短路: 引擎已检休眠/缺席/逾期/死亡活跃 subtype"),
          issues: [],
          model: MECHANICAL_SCORER_LABEL,
        }
        callbacks.onDimensionResult?.(key, shortCircuitResult)
        callbacks.onDimensionThinking?.(key, shortCircuitResult.thinking)
        return { key, result: shortCircuitResult, error: null as Error | null }
      }
      try {
        // 多模型共识旁路（consensusEnabled 且该维明确配置了模型组才启用；关闭/空配置 = 单模型现状路径）
        const consensusConfigured =
          injectedNovelConfig.consensusEnabled && (injectedNovelConfig.consensusReviewModels[key]?.length ?? 0) > 0
        if (consensusConfigured) {
          const consensusModels = resolveConsensusModels(
            injectedNovelConfig.consensusReviewModels[key] ?? [],
            llmConfigResolved,
            injectedNovelConfig,
          )
          const outcome = await runDimensionConsensus({
            models: consensusModels,
            dimension,
            contextPack,
            chapterContent,
            debateRounds: injectedNovelConfig.consensusDebateRounds,
            signal,
            novelConfig: injectedNovelConfig,
            goldAnchors,
            goldReadinessHint,
          })
          callbacks.onDimensionThinking?.(key, outcome.result.thinking)
          const consensusLabel = `consensus:${consensusModels.map((m) => m.model || "unknown").join("+")}`
          return { key, result: { ...outcome.result, model: consensusLabel }, error: null as Error | null }
        }
        const result = await reviewChapterDimension({
          llmConfig: llmConfigResolved,
          contextPack,
          chapterContent,
          dimension,
          signal,
          novelConfig: injectedNovelConfig,
          goldAnchors,
          goldReadinessHint,
          callbacks: {
            onThinking: (dimensionKey, thinking) => {
              callbacks.onDimensionThinking?.(dimensionKey, thinking)
            },
          },
        })
        return { key, result: { ...result, model: llmConfigResolved.model || "unknown" }, error: null as Error | null }
      } catch (error) {
        // F-003 (ISS-20260705-020): distinguish a JSON parse failure
        // (DimParseError / SyntaxError — the model emitted malformed JSON)
        // from a runtime/stream error, so the failed-dimension result records
        // the actual failure mode instead of an opaque "未知错误".
        return { key, result: null, error: error as Error }
      }
    }),
  )
  for (const { key, result, error } of settled) {
    if (result) {
      results[key] = result
      callbacks.onDimensionResult?.(key, result)
      callbacks.onDimensionThinking?.(key, result.thinking)
    } else {
      const dimension = SIX_REVIEW_DIMENSIONS[key]
      const isParseFailure = error instanceof DimParseError || error instanceof SyntaxError
      results[key] = {
        ...buildFailedDimensionResult(
          dimension,
          isParseFailure
            ? new Error(`${dimension.label}审查返回的 JSON 无法解析：${error?.message}`)
            : (error ?? new Error("unknown error")),
        ),
        model: llmConfigResolved.model || "unknown",
      }
      callbacks.onDimensionResult?.(key, results[key]!)
      callbacks.onDimensionThinking?.(key, results[key]!.thinking)
    }
  }
  return results
}

async function runDimensionStage(
  llmConfig: LlmConfig,
  dimension: SixReviewDimensionDefinition,
  userPrompt: string,
  callbacks: DimensionReviewCallbacks,
  signal?: AbortSignal,
  novelConfig?: NovelConfig,
): Promise<string> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: appendTaskExtraSection(
        `你是专业网文审稿编辑，当前只负责“${dimension.label}”这一项审查。输出必须使用中文。`,
        resolveTaskExtraPrompt(novelConfig, "review"),
      ),
    },
    { role: "user", content: userPrompt },
  ]
  let result = ""
  const streamCallbacks: StreamCallbacks = {
    onToken: (token: string) => {
      result += token
      callbacks.onThinking?.(dimension.key, formatDimensionThinking(dimension, result))
    },
    onDone: () => {},
    onError: (error: Error) => {
      // F-16 (CWE-532): message-only to avoid leaking provider request details.
      logger.error("Dimension Review", `${dimension.key} stream error`, { error: toErrorMessage(error) })
    },
  }

  // ISS-20260709-049: thread an external AbortSignal down to the LLM stream so a
  // caller-side cancel (reviewChapter throw → 6-dim orphan) can cascade-abort
  // the in-flight dimension LLM call instead of letting it run to its 120s
  // timeout. combineAbortSignals merges the external signal with the internal
  // 120s timeout — either firing aborts the stream. Undefined external signal
  // falls back to the prior behavior (timeout-only), so existing callers
  // (start-six-dimension-review-run.ts manual UI trigger, no external signal)
  // are unaffected.
  await streamChat(
    llmConfig,
    messages,
    streamCallbacks,
    combineAbortSignals(signal, AbortSignal.timeout(120000)),
    { reasoning: { mode: (novelConfig ?? useWikiStore.getState().novelConfig).reviewReasoningEffort ?? "high" } },
  )
  return result.trim()
}
