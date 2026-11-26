/**
 * 零 LLM / 零磁盘写的机械门控只读门面（`gate.check_mechanical`）。
 *
 * ## 职责边界
 *
 * 1. **薄门面不重写引擎**：所有确定性规则均经 `@/lib/novel` barrel 与 `@/lib/user-memory`
 *    调用生产实现，禁止深导入 `src/lib/novel/*` 内部模块。
 * 2. **严格只读（零磁盘写）**：
 *    - P0 连续性预检传 `{ readOnly: true, includeNonBlockingAudit: true }`，跳过
 *      `collectContinuityMetric` 与 `appendAuditFindings`；
 *    - `book-rules.json` 与 `user-memory.json` 仅做纯只读 `readFile`，缺失/损坏静默降级。
 * 3. **门控优先级与诚实契约**：
 *    - `Consistency(P0) > Anti-AI(P1) > Quality(P2)`；
 *    - `mechanicalOnly: true`、`semanticReviewCompleted: false`；
 *    - `gates.quality` 恒为 `pending`；
 *    - `verdict` 永不返回冒充语义审查通过的 `"pass"`（无告警时为 `"mechanical_pass_pending_semantic"`）。
 */

import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import {
  AntiAiCandidatePool,
  EMPTY_BOOK_RULES,
  buildDecisionGates,
  cavityPatternPenalty,
  characterActionsToText,
  classifySlop,
  detectCharacterActions,
  detectChorusSing,
  detectSilentStretch,
  extractDeAiChapterBody,
  loadCharacterStates,
  overCorrectionReport,
  overCorrectionToText,
  resolveChapterLengthSpec,
  runContinuityMechanicalPreflight,
  runDeAiDetection,
  slopReportToText,
  slopScore,
  validateAgainstBookRules,
  validateFanficChapter,
  type AntiAiAnalysisReport,
  type BookRules,
  type ChapterLengthSpec,
  type CharacterActionHit,
  type ChorusHit,
  type DeepChapterDecisionGates,
  type NovelReviewResult,
  type RuleFinding,
  type SilentStretch,
  type SlopHit,
  type SlopReport,
  type StatisticalFactorReport,
} from "@/lib/novel"
import {
  createDefaultStore,
  getAvoidWords,
  getDefaultUserMemoryPath,
  loadUserMemory,
  type UserMemoryStore,
} from "@/lib/user-memory"
import { useWikiStore } from "@/stores/wiki-store"

/** 单次机械报告返回 pinpoint 命中条目硬上限，防止超大草稿撑爆 MCP 响应。 */
const MAX_PINPOINT_HITS = 200
/** pinpoint 上下文片段左右各截取字符数。 */
const PINPOINT_SNIPPET_RADIUS = 20

export interface MechanicalGateInput {
  projectPath: string
  /** 待检测文本（可含 YAML frontmatter 与 H1 标题，门面会剥离后检测正文）。 */
  text: string
  /** 可选章号（1 起）；传入时启用 P0 确定性连续性引擎与过程库三口诀预检。 */
  chapterNumber?: number
  /** 可选题材标识（缺省读取当前项目配置的 genre）。 */
  genre?: string
  /** 可选单章目标字数（缺省读取当前项目配置的 chapterTargetChars）。 */
  targetChars?: number
  /** 可选书目角色名单（缺省只读加载 character-states.json）。 */
  characterNames?: readonly string[]
}

export interface MechanicalGateIssue {
  priority: "P0" | "P1"
  gate: "consistency" | "anti_ai"
  severity: "error" | "warning" | "info"
  type: string
  message: string
  evidence: string
  suggestion: string
  continuityMeta?: NovelReviewResult["continuityMeta"]
}

export interface MechanicalPinpointHit {
  id: string
  term: string
  category: string
  tier: "1A" | "1B" | "3" | "slop"
  /** 1-based 行号（相对剥离 frontmatter/标题后的正文）。 */
  line: number
  /** 1-based 列号（相对剥离 frontmatter/标题后的正文）。 */
  column: number
  startIndex: number
  endIndex: number
  snippet: string
  suggestion: string
}

export interface MechanicalGateBucketSummary {
  priority: "P0" | "P1"
  status: "failed" | "warning" | "mechanical_passed_pending_semantic"
  verdict: "fail" | "warning" | "pending"
  errorCount: number
  warningCount: number
  infoCount: number
  issues: MechanicalGateIssue[]
}

export interface MechanicalQualityGateSummary {
  priority: "P2"
  status: "pending"
  verdict: "pending"
  note: string
}

export interface MechanicalGateReport {
  mechanicalOnly: true
  semanticReviewCompleted: false
  verdict: "fail" | "warning" | "mechanical_pass_pending_semantic"
  blockingGate: "consistency" | "anti_ai" | null
  chapterNumber: number | null
  genre: string | null
  bodyStats: {
    rawChars: number
    bodyChars: number
    nonWhitespaceChars: number
    lineCount: number
    lengthSpec: ChapterLengthSpec
    lengthStatus: "ok" | "under_min" | "over_draft_max"
  }
  gates: {
    consistency: MechanicalGateBucketSummary
    anti_ai: MechanicalGateBucketSummary
    quality: MechanicalQualityGateSummary
  }
  decisionGates: DeepChapterDecisionGates
  issues: MechanicalGateIssue[]
  metrics: {
    slop: {
      penalty: number
      classification: "clean" | "warn" | "block"
      summary: string
      tier1Hits: SlopReport["tier1Hits"]
      tier2Hits: SlopReport["tier2Hits"]
      tier3Hits: SlopReport["tier3Hits"]
      sentenceLengthCV: number
      transitionOpenerRatio: number
      bypassCount: number
      cavityPatternPenalty: number
      cavityPatternHits: SlopHit[]
    }
    overCorrection: {
      humanizerCavityScore: number
      sentenceLengthCV: number
      fillerDensityPer1000: number
      fillerCount: number
      flags: string[]
      summary: string
    }
    pinpointHits: MechanicalPinpointHit[]
    pinpointTotalCount: number
    pinpointTruncated: boolean
    characterActions: CharacterActionHit[]
    chorusHits: ChorusHit[]
    silentStretches: SilentStretch[]
    statisticalFactors: {
      available: boolean
      hasWarnings: boolean
      warningCount: number
      summary: string
      calibrationSource: string
      factors: StatisticalFactorReport[]
    }
    avoidWordHits: Array<{ word: string; count: number }>
    bookRules: {
      loaded: boolean
      verdict: "comply" | "violate"
      findings: RuleFinding[]
    }
  }
  meta: {
    llmCalls: 0
    diskWrites: 0
    note: string
  }
}

export interface MechanicalGateDeps {
  readFileText: (path: string) => Promise<string>
  runContinuityPreflight: (
    projectPath: string,
    chapterNumber: number | undefined,
    options?: {
      chapterText?: string
      readOnly?: boolean
      includeNonBlockingAudit?: boolean
    },
  ) => Promise<NovelReviewResult[]>
  loadCharacterNames: (projectPath: string) => Promise<string[]>
  loadUserMemory: (projectPath: string) => Promise<UserMemoryStore>
  analyzeStatisticalFactors: (body: string) => Promise<AntiAiAnalysisReport | null>
  readDefaultTargetChars: () => number | undefined
  readDefaultGenre: () => string | undefined
}

let cachedCandidatePoolPromise: Promise<AntiAiCandidatePool | null> | null = null

async function getLazyCandidatePool(): Promise<AntiAiCandidatePool | null> {
  if (!cachedCandidatePoolPromise) {
    cachedCandidatePoolPromise = (async () => {
      try {
        const pool = new AntiAiCandidatePool()
        await pool.loadCorpus()
        return pool.loaded ? pool : null
      } catch {
        return null
      }
    })()
  }
  return cachedCandidatePoolPromise
}

const defaultDeps: MechanicalGateDeps = {
  readFileText: (path) => readFile(path),
  runContinuityPreflight: (projectPath, chapterNumber, options) =>
    runContinuityMechanicalPreflight(projectPath, chapterNumber, options),
  loadCharacterNames: async (projectPath) => {
    try {
      const store = await loadCharacterStates(projectPath)
      return (store.characters ?? [])
        .map((c) => c.characterName.trim())
        .filter((name) => name.length > 0)
    } catch {
      return []
    }
  },
  loadUserMemory: async (projectPath) => {
    try {
      return await loadUserMemory(getDefaultUserMemoryPath(projectPath))
    } catch {
      return createDefaultStore()
    }
  },
  analyzeStatisticalFactors: async (body) => {
    try {
      const pool = await getLazyCandidatePool()
      return pool ? pool.analyze(body) : null
    } catch {
      return null
    }
  },
  readDefaultTargetChars: () => useWikiStore.getState().novelConfig.chapterTargetChars,
  readDefaultGenre: () => useWikiStore.getState().novelConfig.genre,
}

/** 构造行起始偏移索引，供 O(log L) 计算 1-based 行列号。 */
function buildLineStartOffsets(text: string): number[] {
  const starts: number[] = [0]
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      starts.push(i + 1)
    }
  }
  return starts
}

/** 根据字符偏移查 1-based 行列号。 */
function offsetToLineColumn(lineStarts: readonly number[], offset: number): { line: number; column: number } {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return {
    line: lo + 1,
    column: offset - lineStarts[lo]! + 1,
  }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** 截取单行上下文片段（UTF-16 代理对安全，绝不在边界截断 emoji / CJK 扩展 B 字符）。 */
export function buildPinpointSnippet(text: string, startIndex: number, endIndex: number): string {
  let from = Math.max(0, Math.min(text.length, startIndex - PINPOINT_SNIPPET_RADIUS))
  if (from > 0 && from < text.length && isLowSurrogate(text.charCodeAt(from)) && isHighSurrogate(text.charCodeAt(from - 1))) {
    from -= 1
  }
  let to = Math.max(from, Math.min(text.length, endIndex + PINPOINT_SNIPPET_RADIUS))
  if (to > from && to < text.length && isHighSurrogate(text.charCodeAt(to - 1)) && isLowSurrogate(text.charCodeAt(to))) {
    to += 1
  }
  const raw = text.slice(from, to).replace(/\r?\n/g, " ")
  const prefix = from > 0 ? "…" : ""
  const suffix = to < text.length ? "…" : ""
  return `${prefix}${raw}${suffix}`
}

/** 将 JSON 反序列化的 book-rules 对象做防御性规范化；无效返回 EMPTY_BOOK_RULES。 */
function normalizeBookRules(raw: unknown): BookRules | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const toStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []

  const rules: BookRules = {
    version: typeof obj.version === "string" && obj.version.trim() ? obj.version : "1.0",
    prohibitions: toStringArray(obj.prohibitions),
    allowedDeviations: toStringArray(obj.allowedDeviations),
  }

  if (obj.protagonist && typeof obj.protagonist === "object" && !Array.isArray(obj.protagonist)) {
    const p = obj.protagonist as Record<string, unknown>
    if (typeof p.name === "string" && p.name.trim()) {
      rules.protagonist = {
        name: p.name.trim(),
        personalityLock: toStringArray(p.personalityLock),
        behavioralConstraints: toStringArray(p.behavioralConstraints),
      }
    }
  }

  if (obj.genreLock && typeof obj.genreLock === "object" && !Array.isArray(obj.genreLock)) {
    const g = obj.genreLock as Record<string, unknown>
    if (typeof g.primary === "string" && g.primary.trim()) {
      rules.genreLock = {
        primary: g.primary.trim(),
        forbidden: toStringArray(g.forbidden),
      }
    }
  }

  if (obj.eraConstraints && typeof obj.eraConstraints === "object" && !Array.isArray(obj.eraConstraints)) {
    const e = obj.eraConstraints as Record<string, unknown>
    rules.eraConstraints = {
      enabled: Boolean(e.enabled),
      anachronismTerms: toStringArray(e.anachronismTerms),
      ...(typeof e.period === "string" ? { period: e.period } : {}),
      ...(typeof e.region === "string" ? { region: e.region } : {}),
    }
  }

  if (obj.fanficMode === "canon" || obj.fanficMode === "au" || obj.fanficMode === "ooc" || obj.fanficMode === "cp") {
    rules.fanficMode = obj.fanficMode
  }

  return rules
}

async function loadBookRulesReadOnly(
  projectPath: string,
  readFileText: (path: string) => Promise<string>,
): Promise<{ loaded: boolean; rules: BookRules }> {
  const root = normalizePath(projectPath).replace(/\/+$/, "")
  const rulesPath = `${root}/.novel/book-rules.json`
  try {
    const raw = await readFileText(rulesPath)
    const parsed = normalizeBookRules(JSON.parse(raw))
    if (parsed) return { loaded: true, rules: parsed }
    return { loaded: false, rules: EMPTY_BOOK_RULES }
  } catch {
    return { loaded: false, rules: EMPTY_BOOK_RULES }
  }
}

function countLiteralOccurrences(text: string, term: string): number {
  if (!term) return 0
  let count = 0
  let pos = 0
  while (pos <= text.length) {
    const idx = text.indexOf(term, pos)
    if (idx === -1) break
    count += 1
    pos = idx + term.length
  }
  return count
}

function severityRank(severity: "error" | "warning" | "info"): number {
  if (severity === "error") return 0
  if (severity === "warning") return 1
  return 2
}

function summarizeBucket(
  priority: "P0" | "P1",
  issues: MechanicalGateIssue[],
): MechanicalGateBucketSummary {
  const sorted = [...issues].sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
  const errorCount = sorted.filter((i) => i.severity === "error").length
  const warningCount = sorted.filter((i) => i.severity === "warning").length
  const infoCount = sorted.filter((i) => i.severity === "info").length
  const status: MechanicalGateBucketSummary["status"] =
    errorCount > 0
      ? "failed"
      : warningCount > 0
        ? "warning"
        : "mechanical_passed_pending_semantic"
  const verdict: MechanicalGateBucketSummary["verdict"] =
    errorCount > 0
      ? "fail"
      : warningCount > 0
        ? "warning"
        : "pending"
  return {
    priority,
    status,
    verdict,
    errorCount,
    warningCount,
    infoCount,
    issues: sorted,
  }
}

/**
 * 执行零 LLM、零写盘的确定性机械门控检查（供 MCP `gate.check_mechanical` 调用）。
 */
export async function runMechanicalGateForMcp(
  input: MechanicalGateInput,
  depsOverrides?: Partial<MechanicalGateDeps>,
): Promise<MechanicalGateReport> {
  const deps: MechanicalGateDeps = { ...defaultDeps, ...depsOverrides }
  const rawText = input.text ?? ""
  const extracted = extractDeAiChapterBody(rawText)
  const body = extracted.trim().length > 0 ? extracted : rawText

  const effectiveGenre =
    typeof input.genre === "string" && input.genre.trim().length > 0
      ? input.genre.trim()
      : deps.readDefaultGenre()?.trim() || undefined
  const effectiveTargetChars =
    typeof input.targetChars === "number" && Number.isFinite(input.targetChars) && input.targetChars > 0
      ? input.targetChars
      : deps.readDefaultTargetChars()
  const lengthSpec = resolveChapterLengthSpec(effectiveTargetChars)
  const chapterNumber =
    typeof input.chapterNumber === "number" && Number.isInteger(input.chapterNumber) && input.chapterNumber >= 1
      ? input.chapterNumber
      : undefined

  // 并发执行所有只读 I/O（零磁盘写）
  const [continuityResults, bookRulesLoad, characterNames, userMemoryStore, statReport] =
    await Promise.all([
      deps.runContinuityPreflight(input.projectPath, chapterNumber, {
        chapterText: body,
        readOnly: true,
        includeNonBlockingAudit: true,
      }),
      loadBookRulesReadOnly(input.projectPath, deps.readFileText),
      input.characterNames !== undefined
        ? Promise.resolve([...input.characterNames].map((n) => n.trim()).filter((n) => n.length > 0))
        : deps.loadCharacterNames(input.projectPath),
      deps.loadUserMemory(input.projectPath),
      deps.analyzeStatisticalFactors(body),
    ])

  // ── P0：确定性连续性 + 书籍治理规则（BookRules）────────────────────────────
  const p0ReviewResults: NovelReviewResult[] = [...continuityResults]
  const bookRulesValidation = bookRulesLoad.rules.fanficMode
    ? validateFanficChapter(bookRulesLoad.rules, body, characterNames)
    : validateAgainstBookRules(bookRulesLoad.rules, body)

  for (const finding of bookRulesValidation.findings) {
    p0ReviewResults.push({
      severity: finding.severity === "error" ? "error" : "warning",
      type: "consistency_mechanical",
      message: finding.message,
      evidence: `${finding.code}: ${finding.term}`,
      relatedMemory: ".novel/book-rules.json",
      suggestion:
        finding.severity === "error"
          ? `违反书籍治理约束「${finding.term}」，请修改正文或在 book-rules.json 中显式加入 allowedDeviations`
          : `疑似违反时代/同人约束「${finding.term}」，请核对设定一致性`,
    })
  }

  const p0Issues: MechanicalGateIssue[] = p0ReviewResults.map((r) => ({
    priority: "P0",
    gate: "consistency",
    severity: r.severity,
    type: r.type,
    message: r.message,
    evidence: r.evidence,
    suggestion: r.suggestion,
    ...(r.continuityMeta ? { continuityMeta: r.continuityMeta } : {}),
  }))

  // ── P1：零 LLM 反 AI / 机械腔 / 行为重复 / 结构信号 / 避用词 / 字数边界 ─────
  const p1ReviewResults: NovelReviewResult[] = []

  // 1) Slop 分数 + 补漏模式
  const slopReport = slopScore(body)
  const slopClass = classifySlop(slopReport)
  const slopSummary = slopReportToText(slopReport)
  const cavityPatterns = cavityPatternPenalty(body)
  if (slopClass === "block") {
    p1ReviewResults.push({
      severity: "error",
      type: "anti_ai",
      message: `机械 slop 阻断: ${slopSummary || `penalty ${slopReport.slopPenalty.toFixed(1)}/10`}`,
      evidence: `penalty ${slopReport.slopPenalty.toFixed(1)}/10 (机械正则检测, 零 LLM)`,
      relatedMemory: "",
      suggestion: "降低 AI 味: 删总结腔/解释腔, 打破机械句式, 具体化情绪替代概述",
    })
  } else if (slopClass === "warn") {
    p1ReviewResults.push({
      severity: "warning",
      type: "anti_ai",
      message: `机械 slop 警告: ${slopSummary || `penalty ${slopReport.slopPenalty.toFixed(1)}/10`}`,
      evidence: `penalty ${slopReport.slopPenalty.toFixed(1)}/10 (机械正则检测, 零 LLM)`,
      relatedMemory: "",
      suggestion: "复核高频禁用词与机械句式，必要时定点替换",
    })
  }

  // 2) Pinpoint 静态定位命中（含 1-based 行列号 + 偏移 + 上下文片段）
  const deAiDetection = runDeAiDetection(body)
  const lineStarts = buildLineStartOffsets(body)
  const pinpointTotalCount = deAiDetection.hits.length
  const pinpointTruncated = pinpointTotalCount > MAX_PINPOINT_HITS
  const pinpointHits: MechanicalPinpointHit[] = deAiDetection.hits
    .slice(0, MAX_PINPOINT_HITS)
    .map((hit) => {
      const { line, column } = offsetToLineColumn(lineStarts, hit.startIndex)
      return {
        id: hit.id,
        term: hit.term,
        category: hit.category,
        tier: hit.tier,
        line,
        column,
        startIndex: hit.startIndex,
        endIndex: hit.endIndex,
        snippet: buildPinpointSnippet(body, hit.startIndex, hit.endIndex),
        suggestion: hit.suggestion,
      }
    })

  // 3) 改写器腔检测 (humanizer cavity)
  const overCorrection = overCorrectionReport(body)
  const overCorrectionSummary = overCorrectionToText(overCorrection)
  if (overCorrection.flags.length > 0) {
    p1ReviewResults.push({
      severity: "warning",
      type: "anti_ai",
      message: `改写痕迹警告 (humanizer 腔): ${overCorrection.flags.join("；")}`,
      evidence: overCorrectionSummary,
      relatedMemory: "",
      suggestion: "保留自然句长不均匀性与口语克制，避免为降 AI 分而过度改写",
    })
  }

  // 4) 角色行为模式重复
  const characterActions = detectCharacterActions(body, characterNames)
  const repeatedActions = characterActions.filter((h) => h.totalCount >= 3)
  if (repeatedActions.length > 0) {
    p1ReviewResults.push({
      severity: "warning",
      type: "character_behavior",
      message: `角色行为模式: ${repeatedActions.map((h) => `"${h.action}"×${h.totalCount}`).join(", ")}`,
      evidence: characterActionsToText(characterActions),
      relatedMemory: "",
      suggestion: "减少重复动作标签，用差异化微动作替代，避免角色标签化",
    })
  }

  // 5) 轮唱结构信号
  const chorusHits = detectChorusSing(body)
  if (chorusHits.length > 0) {
    p1ReviewResults.push({
      severity: "warning",
      type: "style",
      message: `轮唱对话信号: ${chorusHits.map((h) => `第${h.para}段起连续${h.shouts}段短喊话`).join("；")}`,
      evidence: JSON.stringify(chorusHits),
      relatedMemory: "",
      suggestion: "穿插动作、环境反应或压缩回合，打破连续短句轮唱",
    })
  }

  // 6) 角色静默段信号
  const silentStretches = detectSilentStretch(body, characterNames)
  if (silentStretches.length > 0) {
    p1ReviewResults.push({
      severity: "warning",
      type: "style",
      message: `角色长段静默: ${silentStretches.map((s) => `第${s.fromPara}-${s.toPara}段(${Math.round(s.ratio * 100)}%)`).join("；")}`,
      evidence: JSON.stringify(silentStretches),
      relatedMemory: "",
      suggestion: "核对主要角色是否无故掉线，必要时补充在场锚点",
    })
  }

  // 7) 四统计因子候选池（warn-only，降级安全）
  if (statReport && statReport.hasWarnings) {
    p1ReviewResults.push({
      severity: "warning",
      type: "anti_ai",
      message: `统计因子警告: ${statReport.summary}`,
      evidence: statReport.factors
        .filter((f) => f.warn)
        .map((f) => `${f.factor}=${f.value.toFixed(3)} (阈值 ${f.threshold})`)
        .join("; "),
      relatedMemory: "",
      suggestion: "统计信号仅供参考（不阻断），可结合段落长度与句式变化复核",
    })
  }

  // 8) 用户自定义避用词
  const avoidWords = getAvoidWords(userMemoryStore)
  const avoidWordHits: Array<{ word: string; count: number }> = []
  for (const word of avoidWords) {
    const count = countLiteralOccurrences(body, word)
    if (count > 0) avoidWordHits.push({ word, count })
  }
  if (avoidWordHits.length > 0) {
    p1ReviewResults.push({
      severity: "warning",
      type: "anti_ai",
      message: `命中用户避用词: ${avoidWordHits.map((h) => `「${h.word}」×${h.count}`).join("、")}`,
      evidence: avoidWordHits.map((h) => `${h.word}×${h.count}`).join(", "),
      relatedMemory: ".novel/user-memory.json",
      suggestion: "替换用户记忆中声明禁用的词汇",
    })
  }

  // 9) 章节字数规格边界（Unicode 码点口径，与 deep-chapter-prompts 一致）
  const nonWhitespaceChars = [...body.replace(/\s+/g, "")].length
  const lineCount = body.length === 0 ? 0 : body.split(/\r?\n/).length
  let lengthStatus: "ok" | "under_min" | "over_draft_max" = "ok"
  if (nonWhitespaceChars < lengthSpec.minChars) {
    lengthStatus = "under_min"
    p1ReviewResults.push({
      severity: "warning",
      type: "style",
      message: `章节字数低于下限：当前 ${nonWhitespaceChars} 字，下限 ${lengthSpec.minChars} 字（目标 ${lengthSpec.targetChars} 字）`,
      evidence: `nonWhitespaceChars=${nonWhitespaceChars}, minChars=${lengthSpec.minChars}, targetChars=${lengthSpec.targetChars}`,
      relatedMemory: "",
      suggestion: `建议补充有效情节细节至 ${lengthSpec.minChars}–${lengthSpec.draftMaxChars} 字区间`,
    })
  } else if (nonWhitespaceChars > lengthSpec.draftMaxChars) {
    lengthStatus = "over_draft_max"
    p1ReviewResults.push({
      severity: "warning",
      type: "style",
      message: `章节字数超出初稿上限：当前 ${nonWhitespaceChars} 字，上限 ${lengthSpec.draftMaxChars} 字（目标 ${lengthSpec.targetChars} 字）`,
      evidence: `nonWhitespaceChars=${nonWhitespaceChars}, draftMaxChars=${lengthSpec.draftMaxChars}, targetChars=${lengthSpec.targetChars}`,
      relatedMemory: "",
      suggestion: `建议压缩冗余铺陈或拆章，使单章保持在 ${lengthSpec.minChars}–${lengthSpec.draftMaxChars} 字区间`,
    })
  }

  const p1Issues: MechanicalGateIssue[] = p1ReviewResults.map((r) => ({
    priority: "P1",
    gate: "anti_ai",
    severity: r.severity,
    type: r.type,
    message: r.message,
    evidence: r.evidence,
    suggestion: r.suggestion,
  }))

  // ── 生产三门归并（semanticReviewCompleted = false，严禁冒充语义通过）────────
  const allReviewResults: NovelReviewResult[] = [...p0ReviewResults, ...p1ReviewResults]
  const decisionGates = buildDecisionGates(allReviewResults, 0, false, effectiveGenre, false)

  const consistencyBucket = summarizeBucket("P0", p0Issues)
  const antiAiBucket = summarizeBucket("P1", p1Issues)
  const qualityGate: MechanicalQualityGateSummary = {
    priority: "P2",
    status: "pending",
    verdict: "pending",
    note: "质量门控 (P2) 需经语义审查评估；本次仅完成零 LLM 机械预检，未执行语义审查。",
  }

  // 严守 Consistency(P0) > Anti-AI(P1) > Quality(P2)
  const blockingGate: "consistency" | "anti_ai" | null =
    consistencyBucket.errorCount > 0
      ? "consistency"
      : antiAiBucket.errorCount > 0
        ? "anti_ai"
        : null

  const hasAnyWarning = consistencyBucket.warningCount > 0 || antiAiBucket.warningCount > 0
  const verdict: MechanicalGateReport["verdict"] =
    blockingGate !== null
      ? "fail"
      : hasAnyWarning
        ? "warning"
        : "mechanical_pass_pending_semantic"

  return {
    mechanicalOnly: true,
    semanticReviewCompleted: false,
    verdict,
    blockingGate,
    chapterNumber: chapterNumber ?? null,
    genre: effectiveGenre ?? null,
    bodyStats: {
      rawChars: rawText.length,
      bodyChars: body.length,
      nonWhitespaceChars,
      lineCount,
      lengthSpec,
      lengthStatus,
    },
    gates: {
      consistency: consistencyBucket,
      anti_ai: antiAiBucket,
      quality: qualityGate,
    },
    decisionGates,
    issues: [...consistencyBucket.issues, ...antiAiBucket.issues],
    metrics: {
      slop: {
        penalty: slopReport.slopPenalty,
        classification: slopClass,
        summary: slopSummary,
        tier1Hits: slopReport.tier1Hits,
        tier2Hits: slopReport.tier2Hits,
        tier3Hits: slopReport.tier3Hits,
        sentenceLengthCV: slopReport.sentenceLengthCV,
        transitionOpenerRatio: slopReport.transitionOpenerRatio,
        bypassCount: slopReport.bypassCount ?? 0,
        cavityPatternPenalty: cavityPatterns.penalty,
        cavityPatternHits: cavityPatterns.hits,
      },
      overCorrection: {
        humanizerCavityScore: overCorrection.humanizerCavityScore,
        sentenceLengthCV: overCorrection.sentenceLengthCV,
        fillerDensityPer1000: overCorrection.fillerDensityPer1000,
        fillerCount: overCorrection.fillerCount,
        flags: overCorrection.flags,
        summary: overCorrectionSummary,
      },
      pinpointHits,
      pinpointTotalCount,
      pinpointTruncated,
      characterActions,
      chorusHits,
      silentStretches,
      statisticalFactors: {
        available: statReport !== null,
        hasWarnings: statReport?.hasWarnings ?? false,
        warningCount: statReport?.warningCount ?? 0,
        summary: statReport?.summary ?? "统计候选池不可用，已优雅降级跳过",
        calibrationSource: statReport?.calibrationSource ?? "unavailable",
        factors: statReport?.factors ?? [],
      },
      avoidWordHits,
      bookRules: {
        loaded: bookRulesLoad.loaded,
        verdict: bookRulesValidation.verdict,
        findings: bookRulesValidation.findings,
      },
    },
    meta: {
      llmCalls: 0,
      diskWrites: 0,
      note: "本报告由零 LLM、零写盘的确定性机械预检生成，不等同于完整语义审查。",
    },
  }
}
