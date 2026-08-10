import { streamChat, combineAbortSignals, type StreamCallbacks } from "@/lib/llm-client"
import type { ChatMessage } from "@/lib/llm-providers"
import type { LlmConfig, NovelConfig } from "@/stores/wiki-store"
import { useWikiStore } from "@/stores/wiki-store"
import { validateSeverity, logger } from "@/lib/utils"
import { buildContextPack, contextPackToPrompt, type ContextPack } from "./context-engine"
import { buildMeasurementFingerprint } from "./measurement-fingerprint"
import { createLiteraryExperimentProtocol } from "./literary-experiment-protocol"
import { resolveNovelModel } from "./model-resolver"
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

export type SixReviewDimensionKey = "thrill" | "consistency" | "pacing" | "character" | "continuity" | "pull"
export type DimensionReviewStatus = "error" | "high" | "medium" | "low" | "pass"

/**
 * F-003 (ANL-010 R6): explicit 6-dim → review-`type` mapping.
 *
 * `resolveDecisionGateKey` in deep-chapter-generation.ts buckets a
 * NovelReviewResult into one of 3 gates (consistency / anti_ai / quality) by
 * matching its `type` string against CONSISTENCY_REVIEW_TYPES /
 * ANTI_AI_REVIEW_TYPES sets. A naive string-match would mis-bucket the
 * `character` DIMENSION (key "character") into the `quality` gate, because
 * CONSISTENCY_REVIEW_TYPES contains `character_consistency` — NOT `character`.
 * This mapping translates each of the 6 dimension keys into the review-`type`
 * string that lands it in the CORRECT gate, so the 6-dim fold composes with
 * the existing 18→3 fold instead of silently miscategorizing.
 *
 *   character       → character_consistency  (CONSISTENCY gate — NOT quality)
 *   continuity      → timeline               (CONSISTENCY gate)
 *   consistency     → consistency            (CONSISTENCY gate)
 *   pacing          → plot                   (quality gate)
 *   thrill          → plot                   (quality gate)
 *   pull            → plot                   (quality gate)
 */
export const DIM_TO_GATE_TYPE: Record<SixReviewDimensionKey, string> = {
  thrill: "plot",
  consistency: "consistency",
  pacing: "plot",
  character: "character_consistency",
  continuity: "timeline",
  pull: "plot",
}

/**
 * F-003: error class for malformed dimension-review JSON. Distinguishes a
 * SyntaxError (the model emitted non-JSON) from a runtime error so callers
 * can tell parse failures apart from stream/transport failures
 * (ISS-20260705-020 JSON.parse hardening).
 */
export class DimParseError extends Error {
  readonly raw: string
  readonly parseMessage: string
  constructor(raw: string, parseMessage: string) {
    super(`Dimension review JSON parse failed: ${parseMessage}`)
    this.name = "DimParseError"
    this.raw = raw
    this.parseMessage = parseMessage
  }
}

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

export function dimensionResultsToReviewResults(
  dimensionResults: Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>,
): NovelReviewResult[] {
  const out: NovelReviewResult[] = []
  for (const key of SIX_REVIEW_DIMENSION_ORDER) {
    const result = dimensionResults[key]
    if (!result) continue
    const reviewType = DIM_TO_GATE_TYPE[key]
    if (result.issues.length > 0) {
      for (const issue of result.issues) {
        out.push({
          severity: severityForIssue(result.status, issue.severity),
          // Override the issue's `type` with the gate-bucketed type so the
          // fold routes correctly. Keep the dimension key in the message
          // prefix for traceability.
          type: reviewType,
          message: `[${result.summary || key}] ${issue.message || ""}`.trim(),
          evidence: issue.evidence || "",
          relatedMemory: issue.relatedMemory || "",
          suggestion: issue.suggestion || "",
        })
      }
    } else {
      // Dimension produced no issues — emit an info-level summary so the
      // gate still records that the dimension was reviewed.
      out.push({
        severity: "info",
        type: reviewType,
        message: `${SIX_REVIEW_DIMENSIONS[key].label}：${result.summary || "pass"}`,
        evidence: "",
        relatedMemory: "",
        suggestion: "",
      })
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
  },
): string {
  const goldExtra = buildGoldScaleReviewBlock(dimension.key, options?.goldAnchors, options?.goldReadinessHint)
  return `${contextPackToPrompt(pack)}

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
}): Promise<Partial<Record<SixReviewDimensionKey, DimensionReviewResult>>> {
  const injectedNovelConfig = novelConfig ?? useWikiStore.getState().novelConfig
  const llmConfigResolved = resolveNovelModel(
    llmConfig ?? useWikiStore.getState().llmConfig,
    injectedNovelConfig,
    "review",
  )
  if (!hasUsableLlm(llmConfigResolved) || !(novelMode ?? useWikiStore.getState().novelMode)) return {}

  const contextPack = await buildContextPack(
    projectPath,
    `六维审查第${chapterNumber || "?"}章`,
    chapterNumber,
  )

  // M0: attach measurement fingerprint for UI / logs (Track B instrument identity)
  try {
    const protocol = createLiteraryExperimentProtocol({
      model: llmConfigResolved.model || "unknown",
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
  } catch {
    // non-fatal
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
    } catch {
      // registry may already have same id — ignore
    }
    try {
      // Track B soft: mechanical avoid-ai / slop (zero-LLM). Not product hard gate.
      registerNovelSkillHook(
        createAvoidAiMechanicalSlopHook({
          text: chapterContent,
          stages: ["pre_six_dim_review"],
        }),
      )
    } catch {
      // ignore registry race
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
    } catch {
      // ignore registry race
    }
    try {
      // Wave C: dual-pass de-AI notes (Track B soft; never product hard gate).
      registerNovelSkillHook(
        createDeAiDualPassHook({
          text: chapterContent,
          stages: ["pre_six_dim_review"],
        }),
      )
    } catch {
      // ignore registry race
    }
    try {
      // Wave C: statistical AI signature proxy (experimental; soft only).
      registerNovelSkillHook(
        createStatisticalAiSignatureHook({
          text: chapterContent,
          stages: ["pre_six_dim_review"],
        }),
      )
    } catch {
      // ignore registry race
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
      error: err instanceof Error ? err.message : String(err),
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
        }
        callbacks.onDimensionResult?.(key, shortCircuitResult)
        callbacks.onDimensionThinking?.(key, shortCircuitResult.thinking)
        return { key, result: shortCircuitResult, error: null as Error | null }
      }
      try {
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
        return { key, result, error: null as Error | null }
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
      results[key] = buildFailedDimensionResult(
        dimension,
        isParseFailure
          ? new Error(`${dimension.label}审查返回的 JSON 无法解析：${error?.message}`)
          : (error ?? new Error("unknown error")),
      )
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
    { role: "system", content: `你是专业网文审稿编辑，当前只负责“${dimension.label}”这一项审查。输出必须使用中文。` },
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
      logger.error("Dimension Review", `${dimension.key} stream error`, { error: error instanceof Error ? error.message : String(error) })
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

function parseDimensionReviewResult(
  dimension: SixReviewDimensionDefinition,
  finalText: string,
  thinking: string,
): DimensionReviewResult {
  const jsonMatch = finalText.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error(`${dimension.label}审查没有返回 JSON`)

  // F-003 (ISS-20260705-020): harden the unguarded JSON.parse. A SyntaxError
  // means the model emitted malformed JSON (truncation, code-fence leakage,
  // trailing prose) — wrap it in DimParseError so callers can distinguish a
  // parse failure from a runtime/stream failure. Non-SyntaxError throwables
  // are re-thrown unchanged.
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new DimParseError(jsonMatch[0], error.message)
    }
    throw error
  }
  const issues = Array.isArray(parsed.issues) ? parsed.issues : []
  return {
    dimensionKey: dimension.key,
    score: normalizeScore(parsed.score),
    status: validateStatus(parsed.status, issues.length),
    summary: String(parsed.summary || ""),
    thinking: formatDimensionThinking(dimension, thinking),
    issues: issues.map((item) => normalizeIssue(dimension.key, item as Record<string, unknown>)),
  }
}

function normalizeIssue(dimensionKey: SixReviewDimensionKey, item: Record<string, unknown>): DimensionReviewIssue {
  const evidence = String(item.evidence || "")
  return {
    severity: validateSeverity(item.severity),
    type: String(item.type || dimensionKey),
    dimensionKey,
    message: String(item.message || ""),
    evidence,
    relatedMemory: String(item.relatedMemory || ""),
    suggestion: String(item.suggestion || ""),
    impact: String(item.impact || ""),
    rewriteTarget: String(item.rewriteTarget || evidence),
  }
}

function buildFailedDimensionResult(
  dimension: SixReviewDimensionDefinition,
  error: unknown,
): DimensionReviewResult {
  const message = error instanceof Error ? error.message : "未知错误"
  return {
    dimensionKey: dimension.key,
    score: 0,
    status: "error",
    summary: `${dimension.label}审查失败：${message}`,
    thinking: formatDimensionThinking(dimension, `审查失败：${message}`),
    issues: [{
      severity: "error",
      type: dimension.key,
      dimensionKey: dimension.key,
      message: `${dimension.label}审查失败：${message}`,
      evidence: "",
      relatedMemory: "",
      suggestion: "请检查模型设置后重新审查此维度。",
      impact: "该维度暂时没有可用审查结果。",
      rewriteTarget: "",
    }],
  }
}

function formatDimensionThinking(dimension: SixReviewDimensionDefinition, content: string): string {
  return `## ${dimension.label}\n${content.trim()}`
}

/**
 * ISS-20260806-001: unify dimension scores on 0-10 (one decimal).
 * Legacy models / short-circuit paths that still emit 0-100 are folded via /10
 * when raw > 10.5 (same rule as step0 A/B calibration arm).
 */
export function normalizeDimensionScore(value: unknown): number {
  const raw = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(raw)) return 0
  const score = raw > 10.5 ? raw / 10 : raw
  return Math.max(0, Math.min(10, Math.round(score * 10) / 10))
}

function normalizeScore(value: unknown): number {
  return normalizeDimensionScore(value)
}

function validateStatus(value: unknown, issueCount: number): DimensionReviewStatus {
  if (value === "error" || value === "high" || value === "medium" || value === "low" || value === "pass") {
    return value
  }
  return issueCount === 0 ? "pass" : "medium"
}
