import { createWatchdog, feedToken, pollWatchdog, type WatchdogState } from "./watchdog"

/**
 * context-compact.ts — §GAP-89-02 四级上下文压缩 + 压缩后恢复包 + 熔断器。
 *
 * 吸收 ainovel-cli `internal/agents/ctxpack/{strategy,restore}.go` 四级压缩
 * 管线（ToolResultMicrocompact → LightTrim → StoreSummaryCompact →
 * FullSummary，按代价从低到高逐级），落为 QMAI 主链 ContextPack 上的
 * 确定性纯函数压缩链 + 恢复包 + 熔断：
 *
 *   1. **microcompact**：零散小段（空串/空白）清理，零信息损失。
 *   2. **lightTrim**：按 dropOrder 逐级裁剪——超预算时先丢低优先级段，
 *      高优先级（canon/硬注入/任务）最后动。不是无序截断。
 *   3. **storeSummary**：用 store 里现成的章节摘要/角色快照/伏笔台账
 *      替换旧消息体（零 LLM 开销）——旧章节正文 → 摘要占位。
 *   4. **fullSummary**：仍超预算时整包折叠为摘要行 + 强制恢复包注入。
 *   - **压缩后恢复包**：每次压缩后自动注入当前任务 + 大纲锚点 + 角色快照
 *     首行，防止压缩后"失忆"（ainovel WriterRestorePack 语义，纯内存拼装，
 *     无 IO）。
 *   - **熔断器**：压缩连续失败（仍超预算）达阈值自动跳过并显式告警，
 *     半开模式下轮重试（复用 watchdog.ts 语义：连续失败计数 + 半开探测位）。
 *   - **CJK Token 估算**：中文按 runes×1.5（与 contextPackToPrompt 同源
 *     口径；token-estimator.ts 反向沿用本函数，防双口径漂移）。
 *
 * ## P0 硬护栏
 *   1. **protected 段永不压缩**：canonRules / hardInject / task / outline /
 *      mustAvoid 只截断为最后手段（budget_exceeded gap），绝不经摘要替换。
 *   2. **IC-02**：每次压缩/丢弃显式记 gap（type="compressed"，reason=
 *      "tier_compressible"），绝不静默。
 *   3. **机械层零 LLM**：摘要替换只用 pack 内已有摘要/快照文本，不调模型。
 *   4. 熔断跳过必须显式告警（返回 skipped=true + reason），不静默放行。
 */

// ============================================================================
// CJK token 估算（与 contextPackToPrompt 同源：中文 ≈1.5 字符/token）
// ============================================================================

/** 中文字符按 1.5 字符/token 估算（runes×1.5 口径的上界取整）。 */
export const CJK_CHARS_PER_TOKEN_EST = 1.5

export function estimateCompactTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[㐀-鿿]/g) ?? []).length
  const ascii = text.length - cjk
  return Math.ceil(ascii / 4 + cjk / CJK_CHARS_PER_TOKEN_EST)
}

// ============================================================================
// dropOrder：超预算时丢什么的有序策略
// ============================================================================

/**
 * dropOrder（AINovel assistant dropOrder 模式吸收）：
 * 数字越小越先丢。protected 段（canon/硬注入/任务/大纲/禁区）不在表内——
 * 它们永不经本策略丢弃，只在 fullSummary 做最后手段截断。
 */
export const CONTEXT_DROP_ORDER: Readonly<Record<string, number>> = {
  graphSearchResults: 10,
  searchResults: 20,
  references: 30,
  referenceBindings: 40,
  relatedChapters: 50,
  communitySummaries: 60,
  kbReferences: 70,
  recentChapterContents: 80,
  recentSummaries: 90,
  characterAuras: 100,
  cognitionStates: 110,
  relatedSettings: 120,
  techniqueBlocks: 130,
  previousChapterEnding: 140,
  timeline: 150,
  characterStates: 160,
  foreshadowingStates: 170,
  soulDoc: 180,
  writingStyle: 190,
  voiceStyleGuide: 200,
  revisionDirectives: 210,
  nextChapterAdvice: 220,
  mustDo: 230,
  chapterGoal: 240,
  recentStateDeltas: 250,
  narrativeVisibility: 260,
  worldBlueprint: 270,
}

/** 永不经 dropOrder 丢弃的 protected 段。 */
export const PROTECTED_COMPACT_FIELDS: ReadonlySet<string> = new Set([
  "task",
  "outline",
  "canonRules",
  "hardInject",
  "hardInjectUsage",
  "mustAvoid",
  "formerFacts",
  "gaps",
  "temporalFacts",
  "styleExemplars",
  "activeEntities",
  "contextUsage",
  "sourceTimingsMs",
  "kbMetrics",
  "kbRoutingGaps",
])

// ============================================================================
// 压缩结果与熔断器
// ============================================================================

export type CompactLevel = "none" | "microcompact" | "lightTrim" | "storeSummary" | "fullSummary"

export interface CompactGap {
  type: "compressed"
  ref: string
  reason: "tier_compressible" | "budget_exceeded"
  originalLength: number
  retainedLength: number
}

export interface CompactResult {
  /** 压缩后的段表（key → 保留文本；数组段已序列化为 string）。 */
  sections: Record<string, string>
  /** 达到的压缩级别（none=无需压缩）。 */
  level: CompactLevel
  /** 压缩后恢复包文本（level≠none 时恒非空）。 */
  restorePack: string
  /** 本次压缩显式记账（IC-02）。 */
  gaps: CompactGap[]
  /** 压缩前后 token 估算。 */
  tokensBefore: number
  tokensAfter: number
  /** 熔断跳过（连续失败达阈值）：未压缩，原样返回 + 显式 reason。 */
  skipped: boolean
  skipReason: string
}

/** 熔断器状态（纯数据，可序列化；now 全部调用方注入）。 */
export interface CompactBreakerState {
  /** 连续压缩失败次数（仍超预算计 1 次，成功清零）。 */
  consecutiveFailures: number
  /** 失败阈值：达阈值进入 open（跳过压缩并告警）。 */
  failureThreshold: number
  /** 半开探测：open 后每 skipHalfOpenRounds 轮允许 1 次探测压缩。 */
  skipHalfOpenRounds: number
  /** 已跳过的轮数（半开计数用）。 */
  skippedRounds: number
  /** open 态（熔断中）。 */
  open: boolean
}

export const DEFAULT_COMPACT_FAILURE_THRESHOLD = 3
export const DEFAULT_COMPACT_HALF_OPEN_ROUNDS = 2

export function createCompactBreaker(
  opts: { failureThreshold?: number; skipHalfOpenRounds?: number } = {},
): CompactBreakerState {
  const failureThreshold =
    typeof opts.failureThreshold === "number" && Number.isFinite(opts.failureThreshold) && opts.failureThreshold > 0
      ? Math.floor(opts.failureThreshold)
      : DEFAULT_COMPACT_FAILURE_THRESHOLD
  const skipHalfOpenRounds =
    typeof opts.skipHalfOpenRounds === "number" && Number.isFinite(opts.skipHalfOpenRounds) && opts.skipHalfOpenRounds > 0
      ? Math.floor(opts.skipHalfOpenRounds)
      : DEFAULT_COMPACT_HALF_OPEN_ROUNDS
  return { consecutiveFailures: 0, failureThreshold, skipHalfOpenRounds, skippedRounds: 0, open: false }
}

/** 成功：清零失败计数，闭合熔断。 */
export function recordCompactSuccess(breaker: CompactBreakerState): void {
  breaker.consecutiveFailures = 0
  breaker.skippedRounds = 0
  breaker.open = false
}

/**
 * 失败（压缩后仍超预算）：失败计数+1；达阈值 → open（下轮跳过并告警）。
 * 返回是否 newly opened（供调用方一次性告警）。
 */
export function recordCompactFailure(breaker: CompactBreakerState): boolean {
  breaker.consecutiveFailures += 1
  if (!breaker.open && breaker.consecutiveFailures >= breaker.failureThreshold) {
    breaker.open = true
    breaker.skippedRounds = 0
    return true
  }
  return false
}

/**
 * open 态下是否允许本轮探测（半开）：每 skipHalfOpenRounds 次跳过允许 1 次试压缩。
 * 允许时重置 skippedRounds（探测轮不计跳过）。
 */
export function allowHalfOpenProbe(breaker: CompactBreakerState): boolean {
  if (!breaker.open) return true
  if (breaker.skippedRounds + 1 >= breaker.skipHalfOpenRounds) {
    breaker.skippedRounds = 0
    return true
  }
  breaker.skippedRounds += 1
  return false
}

// ============================================================================
// 恢复包（WriterRestorePack 语义：任务 + 大纲锚点 + 角色快照首行）
// ============================================================================

export interface RestorePackInput {
  task: string
  outline?: string
  characterStates?: string
  chapterGoal?: string
}

/** 恢复包预算字符数（ainovel restoreBudgetTokens=6000 token → 保守取 6000 字符）。 */
export const RESTORE_PACK_BUDGET_CHARS = 6000

/**
 * buildRestorePack：压缩后恢复包拼装（纯内存，无 IO）。
 * 任务全文 + 大纲锚点（前 2000 字符）+ 角色快照首行 + 章节目标，总量截断
 * 至 RESTORE_PACK_BUDGET_CHARS。恒非空（task 为空时退化为大纲锚点行）。
 */
export function buildRestorePack(input: RestorePackInput): string {
  const lines: string[] = []
  const task = (input.task ?? "").trim()
  lines.push(`## 当前任务\n${task || "(任务缺失：以大纲锚点为准)"}`)
  const outlineAnchor = (input.outline ?? "").replace(/\s+/g, " ").trim().slice(0, 2000)
  if (outlineAnchor) lines.push(`## 大纲锚点\n${outlineAnchor}`)
  const goal = (input.chapterGoal ?? "").trim().slice(0, 500)
  if (goal) lines.push(`## 章节目标\n${goal}`)
  const firstStateLine = (input.characterStates ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (firstStateLine) lines.push(`## 角色快照\n${firstStateLine.slice(0, 500)}`)
  const text = lines.join("\n\n")
  return text.length <= RESTORE_PACK_BUDGET_CHARS
    ? text
    : text.slice(0, RESTORE_PACK_BUDGET_CHARS) + "…"
}

// ============================================================================
// 四级压缩链
// ============================================================================

export interface CompactOptions {
  /** token 预算（估算口径见 estimateCompactTokens）。 */
  tokenBudget: number
  /** 旧章节正文替换摘要用的现成摘要（storeSummary 级）：调用方从 pack.recentSummaries 取。 */
  chapterSummaries?: string[]
  /** 熔断器（不传则每次都压缩，无熔断）。 */
  breaker?: CompactBreakerState
  /** restore 包输入（不传则从 sections 自动提取 task/outline/快照）。 */
  restore?: RestorePackInput
}

function sectionText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .join("\n")
  }
  if (value === null || value === undefined) return ""
  return String(value)
}

function totalTokens(sections: Record<string, string>): number {
  let total = 0
  for (const text of Object.values(sections)) total += estimateCompactTokens(text)
  return total
}

/**
 * compactContextSections：四级逐级压缩（按代价从低到高）。
 *
 * 输入为已序列化的段表（key → 文本）；protected 段（PROTECTED_COMPACT_FIELDS）
 * 永不经 lightTrim/storeSummary 丢弃。各级均显式记 gap。
 *
 * 熔断：breaker.open 且半开不允许探测 → skipped=true 原样返回 + reason；
 * 压缩后仍超预算 → recordCompactFailure（达阈值 newly-open 时 skipReason 告警）。
 */
export function compactContextSections(
  input: Record<string, string | undefined>,
  options: CompactOptions,
): CompactResult {
  const sections: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    const text = typeof v === "string" ? v : ""
    if (text) sections[k] = text
  }
  const tokensBefore = totalTokens(sections)
  const restoreInput: RestorePackInput = options.restore ?? {
    task: sections.task ?? "",
    outline: sections.outline,
    characterStates: sections.characterStates,
    chapterGoal: sections.chapterGoal,
  }
  const restorePack = buildRestorePack(restoreInput)
  const gaps: CompactGap[] = []
  const budget = options.tokenBudget

  const finish = (
    level: CompactLevel,
    skipped: boolean,
    skipReason: string,
  ): CompactResult => ({
    sections: { ...sections },
    level,
    restorePack,
    gaps,
    tokensBefore,
    tokensAfter: totalTokens(sections),
    skipped,
    skipReason,
  })

  if (!(budget > 0) || tokensBefore <= budget) {
    if (options.breaker) recordCompactSuccess(options.breaker)
    return finish("none", false, "")
  }

  // 熔断 open 态：半开探测位决定跳过还是试压缩。
  if (options.breaker?.open && !allowHalfOpenProbe(options.breaker)) {
    return finish("none", true, `压缩熔断器 open：连续失败 ${options.breaker.consecutiveFailures} 次，跳过压缩并告警（半开 ${options.breaker.skipHalfOpenRounds} 轮后探测）`)
  }

  // L1 microcompact：清理零散空白（零信息损失）。
  let changed = false
  for (const [k, text] of Object.entries(sections)) {
    if (PROTECTED_COMPACT_FIELDS.has(k)) continue
    const cleaned = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
    if (cleaned.length < text.length) {
      gaps.push({ type: "compressed", ref: k, reason: "tier_compressible", originalLength: text.length, retainedLength: cleaned.length })
      sections[k] = cleaned
      changed = true
    }
  }
  if (totalTokens(sections) <= budget) {
    if (options.breaker) recordCompactSuccess(options.breaker)
    return finish(changed ? "microcompact" : "none", false, "")
  }

  // L2 lightTrim：按 dropOrder 逐级裁剪（高优先级最后动）。
  const ordered = Object.keys(sections)
    .filter((k) => !PROTECTED_COMPACT_FIELDS.has(k) && CONTEXT_DROP_ORDER[k] !== undefined)
    .sort((a, b) => (CONTEXT_DROP_ORDER[a] ?? 999) - (CONTEXT_DROP_ORDER[b] ?? 999))
  // 未登记段：视为最低优先级之末（先丢），防登记遗漏导致预算失控。
  const unlisted = Object.keys(sections).filter(
    (k) => !PROTECTED_COMPACT_FIELDS.has(k) && CONTEXT_DROP_ORDER[k] === undefined,
  )
  for (const key of [...unlisted, ...ordered]) {
    if (totalTokens(sections) <= budget) break
    const text = sections[key]
    if (!text) continue
    // 先半裁（保留前 1/3，至少 200 字符）；仍超则整段丢弃。
    const keepLen = Math.max(200, Math.floor(text.length / 3))
    if (text.length > keepLen) {
      gaps.push({ type: "compressed", ref: key, reason: "tier_compressible", originalLength: text.length, retainedLength: keepLen })
      sections[key] = text.slice(0, keepLen) + "…"
    } else {
      gaps.push({ type: "compressed", ref: key, reason: "tier_compressible", originalLength: text.length, retainedLength: 0 })
      delete sections[key]
    }
  }
  if (totalTokens(sections) <= budget) {
    if (options.breaker) recordCompactSuccess(options.breaker)
    return finish("lightTrim", false, "")
  }

  // L3 storeSummary：旧章节正文 → 现成摘要占位（零 LLM）。
  const summaries = (options.chapterSummaries ?? []).filter((s) => s.trim()).slice(0, 5)
  if (sections.recentChapterContents && summaries.length > 0) {
    const original = sections.recentChapterContents
    const replacement = summaries.map((s, i) => `【第近${i + 1}章摘要】${s.slice(0, 600)}`).join("\n")
    gaps.push({ type: "compressed", ref: "recentChapterContents", reason: "tier_compressible", originalLength: original.length, retainedLength: replacement.length })
    sections.recentChapterContents = replacement
  }
  if (totalTokens(sections) <= budget) {
    if (options.breaker) recordCompactSuccess(options.breaker)
    return finish("storeSummary", false, "")
  }

  // L4 fullSummary：整包折叠为摘要行（protected 段截断为最后手段，记 budget_exceeded）。
  for (const key of Object.keys(sections)) {
    if (PROTECTED_COMPACT_FIELDS.has(key)) continue
    const text = sections[key]
    gaps.push({ type: "compressed", ref: key, reason: "tier_compressible", originalLength: text.length, retainedLength: 0 })
    delete sections[key]
  }
  for (const key of ["mustAvoid", "outline", "canonRules"]) {
    const text = sections[key]
    if (text && totalTokens(sections) > budget) {
      const keepLen = Math.max(500, Math.floor(text.length / 2))
      gaps.push({ type: "compressed", ref: key, reason: "budget_exceeded", originalLength: text.length, retainedLength: keepLen })
      sections[key] = text.slice(0, keepLen) + "…"
    }
  }
  // task / hardInject 永不截断（最后手段也不动）。

  if (options.breaker) {
    if (totalTokens(sections) <= budget) {
      recordCompactSuccess(options.breaker)
      return finish("fullSummary", false, "")
    }
    const newlyOpened = recordCompactFailure(options.breaker)
    return finish(
      "fullSummary",
      false,
      newlyOpened ? `压缩连续失败 ${options.breaker.consecutiveFailures} 次：熔断器 open，下轮跳过压缩并告警` : "",
    )
  }
  return finish("fullSummary", false, "")
}

// ============================================================================
// watchdog 桥接：压缩可视为一次"心跳"（feedToken），卡死判定复用 pollWatchdog
// ============================================================================

export interface CompactWatchdog {
  state: WatchdogState
}

/** 创建压缩链路看门狗（stall 阈值沿用 watchdog 默认 90s，可覆盖）。 */
export function createCompactWatchdog(opts: { stallTimeoutMs?: number; now?: number } = {}): CompactWatchdog {
  return { state: createWatchdog(opts) }
}

/** 压缩成功一次即一次心跳（防"压缩链路卡死"误判）。 */
export function feedCompactHeartbeat(watchdog: CompactWatchdog, now: number): void {
  feedToken(watchdog.state, now)
}

/** 轮询压缩链路是否卡死（复用 watchdog poll 语义）。 */
export function pollCompactWatchdog(watchdog: CompactWatchdog, now: number) {
  return pollWatchdog(watchdog.state, now)
}

/** sectionText 别名导出（显式记账口径统一用；trimContextPack 预算账目沿用
 * JSON 序列化口径，两处口径差异已在 trim.spec 记账不变量中断言覆盖）。 */
export { sectionText as compactSectionText }
