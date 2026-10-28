/**
 * Quality Foundation v1 / FR-S1: outline thril structure soft-gate.
 * Source: .workflow/harvest-staging/outline-thrill-checkpoints.md (5 checks).
 * Soft-gate only — does not replace Consistency. FIX-1 conflict is flagged and
 * cannot be treated as a literary “pass”.
 *
 * 大纲层改造（2026-10-28）：本文件同时是 thril 结构要求的单一口径——
 * `buildThrillOutlinePromptBlock` 把同一组检查点写成给大纲模型的硬要求，
 * 评估（`evaluateOutlineThrillCheckpoints`）与提示词共用 THRILL_CHECKPOINT_*，
 * 不再另建平行清单。
 */

import type { NovelReviewResult } from "./review-adapter"

export type ThrillCheckpointId =
  | "crisis_info_early"
  | "pressure_release"
  | "protagonist_agency"
  | "chapter_end_hook"
  | "fix1_no_conflict"

export type ThrillCheckStatus = "pass" | "fail" | "unknown"

export interface ThrillCheckResult {
  id: ThrillCheckpointId
  status: ThrillCheckStatus
  label: string
  evidence?: string
  /** FIX-1 failures must not be cleared by thril soft-ack alone. */
  hardLiteraryConstraint?: boolean
}

export const THRILL_CHECKPOINT_ORDER: ThrillCheckpointId[] = [
  "crisis_info_early",
  "pressure_release",
  "protagonist_agency",
  "chapter_end_hook",
  "fix1_no_conflict",
]

export const THRILL_CHECKPOINT_LABELS: Record<ThrillCheckpointId, string> = {
  crisis_info_early: "危机信息是否在前 40% 有可感压力（非纯说明）？",
  pressure_release: "压抑→释放是否至少一条可指认链条？",
  protagonist_agency: "主角能动选择是否推动局面（非纯旁观）？",
  chapter_end_hook: "章末钩是否给出下一阶段具体期待（不提前揭 Offer/机制名）？",
  fix1_no_conflict: "是否与 FIX-1 延迟揭露冲突？",
}

/** Patterns that suggest early mechanism/Offer spoilers (FIX-1 conflict). */
const FIX1_SPOILER_RE =
  /最终存活|唯一存活|真相是|Offer\s*是|机制名|提前揭|全员真相|凶手就是|答案是：/i

const CRISIS_HINT_RE =
  /危机|压力|威胁|倒计时|追杀|绝境|崩盘|崩坏|冲突|对峙|死局|困局|紧逼|逼近/

const PRESSURE_RELEASE_RE =
  /压抑|释放|反转|破局|转机|喘息|反击|翻盘|高潮|爆发|顿挫/

const AGENCY_HINT_RE =
  /决定|选择|主动|出手|反抗|反击|计划|布局|推动|拒绝|答应|赴|前往|设局/

const HOOK_HINT_RE =
  /下章|下一|未完|悬念|钩子|预示|留下|却见|突然|门外|来电|信封|倒计时|未揭/

/**
 * 抗欺骗（2026-10-28）：孤立关键词不足以判 pass。
 *
 * 背景：原实现只做 `RE.test(text)`。章纲里塞一个"压抑"或"反击"就能让审计变绿，
 * 而实际内容仍是"冲突是什么"一句空话。本组判定要求**共现密度**：光有词不够，
 * 必须在同一句里同时出现"施压方/情境 + 代价或结果"这类可指认链条。
 *
 * 同时接受两种写法（既有 STRONG_OUTLINE 这类自然叙述不得被误杀）：
 *   ① 显式标签：`压抑铺垫：…` / `压力释放：…` / `主角能动性：…` / `章末钩：…`
 *   ② 自然叙述：同一句内既有压力线索又有释放/代价线索
 */
const SENTENCE_SPLIT_RE = /[。；\n]+/

/** 按句切分（保留足够上下文给共现判定）。 */
function splitSentences(text: string): string[] {
  return text.split(SENTENCE_SPLIT_RE).map((s) => s.trim()).filter((s) => s.length > 0)
}

/** 单句内压力→释放共现（自然叙述路径）。 */
function sentenceHasPressureChain(sentence: string): boolean {
  return PRESSURE_RELEASE_RE.test(sentence)
    && /(被|遭|由|逼|压|绝境|追杀|威胁|债务|催收|倒计时|代价|只好|不得不|却|反而|结果|当场|最终)/.test(sentence)
}

/** 单句内主角能动共现（自然叙述路径）：能动词 + 动作对象/结果。 */
function sentenceHasAgencyChain(sentence: string): boolean {
  return AGENCY_HINT_RE.test(sentence)
    && /(局|条款|合同|对方|局面|谈判|反击|漏洞|计划|代价|推动|当面|当众|提前|录音|证据)/.test(sentence)
}

/** 单句内章末钩共现（自然叙述路径）：钩子词 + 下一阶段指向。 */
function sentenceHasHookChain(sentence: string): boolean {
  return HOOK_HINT_RE.test(sentence)
    && /(下|下一阶段|接下来|将要|仍未|尚未|而|却|面对|审核|表格|一栏|倒计时)/.test(sentence)
}

/**
 * 标签后必须跟**实质内容**，不能只是「有压力」「有释放」这类空壳。
 * 判定：标签冒号后的片段需同时满足（a）足够长（b）含具体名词/动作，
 * 且不含「有X」「存在X」「出现X」这类无信息量的占位写法。
 */
const SUBSTANCE_RE = /[一-龥A-Za-z0-9「」“”]{2,}/
const EMPTY_SHELL_RE = /^(有|存在|出现|发生|具备|包含|涉及)?\s*(压力|释放|压抑|能动|钩子|悬念|冲突|反转)[。，、；;\s]*$/

/** 从「标签：xxx」中取出 xxx，判断是否为实质内容（非空壳）。 */
function labelHasSubstance(text: string, labelRe: RegExp): boolean {
  const re = new RegExp(labelRe.source + "([^。；\n]{0,200})", "s")
  const m = text.match(re)
  if (!m) return false
  const body = (m[2] ?? "").trim()
  if (body.length < 12) return false
  if (EMPTY_SHELL_RE.test(body)) return false
  // 实质内容：至少含两个具体词（人名/机构/动作），而非纯抽象词
  const concrete = body.match(/[一-龥]{2,}/g) ?? []
  return concrete.length >= 3 && SUBSTANCE_RE.test(body)
}

const LABEL_PRESSURE_RE = /(压抑铺垫|压抑|施压|压力铺垫|压迫)\s*[：:]/s
const LABEL_RELEASE_RE = /(压力释放|释放|反击|翻盘|破局|转机|反转)\s*[：:]/s
const LABEL_AGENCY_RE = /(主角能动性|能动性|主动选择|主角选择)\s*[：:]/s
const LABEL_HOOK_RE = /(章末钩|章末钩子|章尾钩子|结尾钩子)\s*[：:]/s

/**
 * 可指认的压抑→释放链条。
 *
 * 接受三种形态（前两种是既有正确写法，不得误杀）：
 *   ① 显式标签：`压抑铺垫：…` / `压力释放：…`
 *   ② 同一句内压力→释放共现（自然叙述的紧凑写法）
 *   ③ 跨句但成对出现：段落里既有压力线索又有释放线索，且至少一句给出具体情境
 *      （人物/机构 + 代价或结果）——这是“谁施压、付什么代价、在哪释放”的可指认性
 *
 * 裸关键词堆砌（“有冲突、有压抑、有释放、有反转”）不满足 ③，因为缺少具体情境句。
 */
function hasIdentifiablePressureChain(text: string): boolean {
  if (labelHasSubstance(text, LABEL_PRESSURE_RE) || labelHasSubstance(text, LABEL_RELEASE_RE)) return true
  const sentences = splitSentences(text)
  if (sentences.some(sentenceHasPressureChain)) return true
  // ③ 跨句成对 + 具体情境
  const hasPressureCue = /(逼|压|绝境|威胁|债务|催收|倒计时|被|遭|翻倍|翻三倍|到期|排异|锁)/.test(text)
  const hasReleaseCue = /(拆穿|反将|改口|反击|破局|翻盘|转机|释放|喘息|争取|救下|当场)/.test(text)
  const hasConcreteScene = sentences.some((s) =>
    /(中介|公司|客服|催收|风控|对手|沈鸢|柯叔|周砚|林小满|陈默|白曦)/.test(s)
    && /(翻|到期|排异|锁|羞辱|回收|代价|只够|改口|降价|拆穿|反将|救下|争取)/.test(s))
  return hasPressureCue && hasReleaseCue && hasConcreteScene
}

/**
 * 可指认的能动选择。
 *
 * “主角主动做了什么具体动作”本身就是能动证据——不必强求出现“决定/选择/主动”
 * 这类元词（真实章纲常直接写动作：拆穿、反将、设局、录音取证）。
 *
 * 接受三种形态：
 *   ① 显式标签：`主角能动性：…`
 *   ② 能动词 + 动作对象/手段共现
 *   ③ 具体能动动作 + 施动主体/结果（动作词本身就是能动性证明）
 *
 * 裸堆砌（“主角做出选择并决定反抗”）不满足 ③：只有元词，没有具体动作与结果。
 */
function hasIdentifiableAgency(text: string): boolean {
  if (labelHasSubstance(text, LABEL_AGENCY_RE)) return true
  const sentences = splitSentences(text)
  if (sentences.some(sentenceHasAgencyChain)) return true
  const hasAgencyCue = AGENCY_HINT_RE.test(text)
  const hasMeans = /(设局|条款|合同|录音|证据|见证|谈判|反将|拆穿|提前|主动|布局|拒绝|当场)/.test(text)
  if (hasAgencyCue && hasMeans) return true
  // ③ 具体能动动作 + 结果：动作发生在具体主体/对象上，并产生可观测后果
  const CONCRETE_ACTION_RE = /(拆穿|反将|设局|录音|取证|谈判|争取|拒付|拖延|伪造|识破|救下|反诉|申请|拆机|炼成|解锁|利用|钻|撬|逼问|当众)/
  const CONCRETE_OUTCOME_RE = /(改口|降价|争取到|成功|救下|解锁|炼成|识破|让对方|反被|只好|当场|获得|拿到|打开|推迟|暂缓|反将一军)/
  return CONCRETE_ACTION_RE.test(text) && CONCRETE_OUTCOME_RE.test(text)
}

/** 可指认的章末钩：显式标签，或任一句内钩子词 + 下一阶段指向共现。 */
function hasIdentifiableHook(text: string): boolean {
  if (labelHasSubstance(text, LABEL_HOOK_RE)) return true
  return splitSentences(text).some(sentenceHasHookChain)
}

export interface EvaluateThrillOptions {
  /** When outline is empty, all non-FIX1 checks → unknown */
  allowUnknown?: boolean
}

/** 单章 thril 审计结果（大纲层整本扫）。 */
export interface OutlineThrillChapterAudit {
  chapterNumber: number
  title: string
  results: ThrillCheckResult[]
  /** 未通过的检查点 id（fix1 失败也会出现在这里）。 */
  gaps: ThrillCheckpointId[]
}

/**
 * 按章切分大纲正文（纯函数，零 I/O）：支持 `### 第12章 标题`、`## 第12章`、
 * `**第12章**` 等常见章头。无法识别章头时返回整段作为单章（chapterNumber=0）。
 */
export function splitOutlineIntoChapters(
  outlineText: string,
): Array<{ chapterNumber: number; title: string; text: string }> {
  const text = (outlineText ?? "").trim()
  if (!text) return []
  const headerRe = /^(?:#{1,6}\s*|\*\*\s*)?第\s*(\d+)\s*章[:：\s]*(.*)$/
  const lines = text.split(/\r?\n/)
  const chapters: Array<{ chapterNumber: number; title: string; text: string }> = []
  let current: { chapterNumber: number; title: string; text: string } | null = null
  for (const line of lines) {
    const match = line.trim().replace(/\*\*$/, "").match(headerRe)
    if (match) {
      if (current) chapters.push(current)
      current = {
        chapterNumber: Number.parseInt(match[1]!, 10),
        title: match[2]!.replace(/\*\*$/, "").trim(),
        text: line,
      }
    } else if (current) {
      current.text += `\n${line}`
    }
  }
  if (current) chapters.push(current)
  if (chapters.length === 0) {
    return [{ chapterNumber: 0, title: "", text }]
  }
  return chapters
}

/**
 * 整本大纲 thril 结构审计（纯函数，零 I/O）：逐章跑同一套检查点，
 * 输出每章缺口与全书汇总。用于「大纲层改造」前后对比与选题。
 */
export function auditOutlineThrillByChapter(outlineText: string): {
  chapters: OutlineThrillChapterAudit[]
  /** 检查点 → 未通过章数。 */
  missingTally: Partial<Record<ThrillCheckpointId, number>>
  /** 全部检查点都过的章数。 */
  fullPassCount: number
  /** 每章平均通过数（0-5）。 */
  averagePassPerChapter: number
} {
  const chapters = splitOutlineIntoChapters(outlineText).map((chapter) => {
    const results = evaluateOutlineThrillCheckpoints(chapter.text)
    return {
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      results,
      gaps: results.filter((r) => r.status !== "pass").map((r) => r.id),
    }
  })
  const missingTally: Partial<Record<ThrillCheckpointId, number>> = {}
  for (const chapter of chapters) {
    for (const id of chapter.gaps) missingTally[id] = (missingTally[id] ?? 0) + 1
  }
  const fullPassCount = chapters.filter((c) => c.gaps.length === 0).length
  const totalPass = chapters.reduce(
    (sum, c) => sum + c.results.filter((r) => r.status === "pass").length,
    0,
  )
  return {
    chapters,
    missingTally,
    fullPassCount,
    averagePassPerChapter: chapters.length === 0 ? 0 : totalPass / chapters.length,
  }
}

/**
 * 大纲层 thril 硬要求（写给大纲/章纲生成模型的提示块）。
 *
 * 与评估器共用同一组检查点与标签：模型被要求写出的，正是后续软门会检查的，
 * 避免「大纲按另一套标准写、审查按这一套扣分」。
 *
 * @param options.chapterNumber 可选章号，写入标题便于模型逐章落位
 * @param options.includeFix1 是否包含 FIX-1 禁提前揭穿（默认包含）
 */
export function buildThrillOutlinePromptBlock(options: {
  chapterNumber?: number | null
  includeFix1?: boolean
} = {}): string {
  const includeFix1 = options.includeFix1 !== false
  const chapterNumber = options.chapterNumber
  const title =
    chapterNumber != null && Number.isFinite(chapterNumber)
      ? `【thril 结构硬要求 — 第${Math.trunc(chapterNumber)}章】`
      : "【thril 结构硬要求】"
  const structural: ThrillCheckpointId[] = [
    "crisis_info_early",
    "pressure_release",
    "protagonist_agency",
    "chapter_end_hook",
  ]
  const lines: string[] = [
    title,
    "以下四条必须在大纲/章纲里写出可指认的具体内容，不能只写“有冲突”“有反转”这类空话：",
  ]
  for (const id of structural) {
    lines.push(`- ${THRILL_CHECKPOINT_LABELS[id]}（${id}）`)
  }
  lines.push(
    "- 压迫→释放至少要有一条可指认的链条：谁施压、主角付出什么代价、在哪里释放。",
    "- 主角必须是推动局面的能动方，不能全程旁观或被救。",
    "- 章末钩要给出下一阶段的具体期待，不得只写“留下悬念”。",
  )
  if (includeFix1) {
    lines.push(
      `- ${THRILL_CHECKPOINT_LABELS.fix1_no_conflict}（fix1_no_conflict）：禁止提前揭露 Offer、最终存活者、机制名或“真相是”。`,
    )
  }
  return lines.join("\n")
}

/**
 * 大纲生成提示的 thril 段（中文口径，供 outline-generation / 章纲模板复用）。
 *
 * 与 `buildThrillOutlinePromptBlock` 同一来源，仅多一层「章节细纲」落位措辞。
 */
export function buildThrillChapterOutlinePromptBlock(chapterNumber?: number | null): string {
  return [
    buildThrillOutlinePromptBlock({ chapterNumber }),
    "",
    "落位要求（章节细纲）：",
    "- 「爽点设计」必须写出：本章核心爽点、铺垫、兼现方式、兼点后的新压力。",
    "- 「章尾钩子」必须写出：结尾落点、悬念或反转、下一章期待。",
    "- 若本章确实不设大爽点，必须写明“微爽点/期待点”具体是什么，不得留空。",
  ].join("\n")
}

/**
 * Heuristic evaluate outline (or scene brief) text against 5 thril checkpoints.
 * Pure — no I/O. Status unknown when signal weak; fail only on clear FIX-1 spoilers
 * or total absence of structural cues when text is long enough to expect them.
 */
export function evaluateOutlineThrillCheckpoints(
  outlineText: string,
  options: EvaluateThrillOptions = {},
): ThrillCheckResult[] {
  const text = (outlineText ?? "").trim()
  const allowUnknown = options.allowUnknown !== false

  if (!text) {
    return THRILL_CHECKPOINT_ORDER.map((id) => ({
      id,
      status: id === "fix1_no_conflict" ? "pass" : "unknown",
      label: THRILL_CHECKPOINT_LABELS[id],
      evidence: id === "fix1_no_conflict" ? "empty outline — no spoiler text" : "empty outline",
      hardLiteraryConstraint: id === "fix1_no_conflict" ? true : undefined,
    }))
  }

  const earlySlice = text.slice(0, Math.max(80, Math.floor(text.length * 0.4)))
  const lateSlice = text.slice(Math.floor(text.length * 0.55))

  const crisisEarly = CRISIS_HINT_RE.test(earlySlice)
  const pressure = PRESSURE_RELEASE_RE.test(text)
  const agency = AGENCY_HINT_RE.test(text)
  const hook = HOOK_HINT_RE.test(lateSlice) || HOOK_HINT_RE.test(text.slice(-200))
  const fix1Conflict = FIX1_SPOILER_RE.test(text)

  // 抗欺骗：关键词命中只是必要条件，还必须有可指认的结构内容。
  // 裸关键词（如只写“有冲突”“出现反转”）→ unknown，不认 pass。
  const pressureChain = hasIdentifiablePressureChain(text)
  const agencyChain = hasIdentifiableAgency(text)
  const hookChain = hasIdentifiableHook(text)

  const longEnough = text.length >= 80

  return [
    {
      id: "crisis_info_early",
      status: crisisEarly ? "pass" : longEnough ? "fail" : allowUnknown ? "unknown" : "fail",
      label: THRILL_CHECKPOINT_LABELS.crisis_info_early,
      evidence: crisisEarly ? "early-slice crisis cue" : "no crisis/pressure cue in first ~40%",
    },
    {
      id: "pressure_release",
      status: pressureChain ? "pass" : longEnough ? "fail" : allowUnknown ? "unknown" : "fail",
      label: THRILL_CHECKPOINT_LABELS.pressure_release,
      evidence: pressureChain
        ? "identifiable pressure→release chain (谁施压/付什么代价/在哪释放)"
        : pressure
          ? "bare keyword without identifiable chain (谁施压/付什么代价/在哪释放)"
          : "no pressure→release cue",
    },
    {
      id: "protagonist_agency",
      status: agencyChain ? "pass" : longEnough ? "fail" : allowUnknown ? "unknown" : "fail",
      label: THRILL_CHECKPOINT_LABELS.protagonist_agency,
      evidence: agencyChain
        ? "identifiable agency (可指认的能动选择)"
        : agency
          ? "bare agency keyword without identifiable choice"
          : "no protagonist agency cue",
    },
    {
      id: "chapter_end_hook",
      status: hookChain ? "pass" : longEnough ? "fail" : allowUnknown ? "unknown" : "fail",
      label: THRILL_CHECKPOINT_LABELS.chapter_end_hook,
      evidence: hookChain
        ? "identifiable chapter-end hook (下一阶段具体期待)"
        : hook
          ? "bare hook keyword without identifiable next-stage expectation"
          : "no chapter-end hook cue",
    },
    {
      id: "fix1_no_conflict",
      status: fix1Conflict ? "fail" : "pass",
      label: THRILL_CHECKPOINT_LABELS.fix1_no_conflict,
      evidence: fix1Conflict ? "possible early reveal / FIX-1 conflict phrasing" : "no FIX-1 spoiler pattern",
      hardLiteraryConstraint: true,
    },
  ]
}

export function summarizeThrillSoftGate(results: ThrillCheckResult[]): {
  passCount: number
  failCount: number
  unknownCount: number
  fix1Blocked: boolean
  allStructuralOk: boolean
} {
  const passCount = results.filter((r) => r.status === "pass").length
  const failCount = results.filter((r) => r.status === "fail").length
  const unknownCount = results.filter((r) => r.status === "unknown").length
  const fix1Blocked = results.some((r) => r.id === "fix1_no_conflict" && r.status === "fail")
  const structural = results.filter((r) => r.id !== "fix1_no_conflict")
  const allStructuralOk = structural.every((r) => r.status === "pass" || r.status === "unknown")
  return { passCount, failCount, unknownCount, fix1Blocked, allStructuralOk }
}

/**
 * Soft-gate report for thinking UI. Never hard-stops generation by itself.
 * FIX-1 fail is called out as non-ackable literary constraint.
 */
export function formatThrillSoftGateThinking(results: ThrillCheckResult[]): string {
  const sum = summarizeThrillSoftGate(results)
  const lines = [
    "大纲 thril 结构软门（不替代 Consistency；可继续生成，但请人工确认）：",
    ...results.map((r) => {
      const mark = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "?"
      const hard = r.hardLiteraryConstraint && r.status === "fail" ? " [FIX-1 硬约束，不可用 thril 勾选绕过]" : ""
      return `- [${mark}] ${r.label}${r.evidence ? ` — ${r.evidence}` : ""}${hard}`
    }),
    "",
    `汇总：pass=${sum.passCount} fail=${sum.failCount} unknown=${sum.unknownCount}`
      + (sum.fix1Blocked ? "；存在 FIX-1 冲突提示" : ""),
    "继续生成 = 隐式 acknowledge 结构软门（非静默跳过）。",
  ]
  return lines.join("\n")
}

/**
 * Map to NovelReviewResult. Structural fails → warning; FIX-1 fail → warning
 * with type that Track B polish must not treat as clearable literary pass.
 * Soft-gate never emits severity error (process gate, not Track A).
 */
export function thrillResultsToReviewResults(
  results: ThrillCheckResult[],
  chapter?: number,
): NovelReviewResult[] {
  return results
    .filter((r) => r.status !== "pass")
    .map((r) => {
      const isFix1 = r.id === "fix1_no_conflict"
      return {
        severity: "warning" as const,
        type: isFix1 ? "outline_thrill_fix1" : "outline_thrill_soft_gate",
        message: r.label,
        evidence: r.evidence ?? r.status,
        relatedMemory: "outline",
        suggestion: isFix1
          ? "FIX-1：勿提前揭露 Offer/最终存活等机制名；修正大纲后再写。不可用 thril 软勾选绕过。"
          : "建议在开写前补强章纲结构；软门可继续，但不等于文学过关。",
        continuityMeta: {
          subtype: r.id,
          ref: `outline-thrill:${r.id}`,
          chapter: chapter ?? 0,
        },
      }
    })
}

/** Full preflight: evaluate + thinking string + review results. */
export function runOutlineThrillSoftGate(
  outlineText: string,
  chapter?: number,
): {
  results: ThrillCheckResult[]
  thinking: string
  reviewResults: NovelReviewResult[]
  summary: ReturnType<typeof summarizeThrillSoftGate>
} {
  const results = evaluateOutlineThrillCheckpoints(outlineText)
  return {
    results,
    thinking: formatThrillSoftGateThinking(results),
    reviewResults: thrillResultsToReviewResults(results, chapter),
    summary: summarizeThrillSoftGate(results),
  }
}

/**
 * Runtime preflight status for UI / measurement logs.
 * Soft-gate never hard-blocks generation; FIX-1 fail is non-ackable as literary pass.
 */
export interface OutlineThrillSoftGateRuntimeStatus {
  enabled: boolean
  chapterKey: string
  acknowledged: boolean
  fix1Blocked: boolean
  allStructuralOk: boolean
  passCount: number
  failCount: number
  unknownCount: number
  /** True when generation may continue (always true unless caller treats FIX-1 as hard stop). */
  mayContinueGeneration: true
  /** Explicit product rule: thril soft-gate is not Track A. */
  productHardGate: false
  results: ThrillCheckResult[]
  thinking: string
}

export function getOutlineThrillSoftGateRuntimeStatus(options: {
  outlineText?: string
  chapter?: number | null
  enabled?: boolean
  ackMap?: Record<string, boolean> | null
}): OutlineThrillSoftGateRuntimeStatus {
  const enabled = options.enabled !== false
  const chapterKey = thrilAckChapterKey(options.chapter)
  if (!enabled) {
    return {
      enabled: false,
      chapterKey,
      acknowledged: false,
      fix1Blocked: false,
      allStructuralOk: true,
      passCount: 0,
      failCount: 0,
      unknownCount: 0,
      mayContinueGeneration: true,
      productHardGate: false,
      results: [],
      thinking: "大纲 thril 软门已关闭（novelConfig.outlineThrillSoftGateEnabled=false）。",
    }
  }
  const results = evaluateOutlineThrillCheckpoints(options.outlineText ?? "")
  const summary = summarizeThrillSoftGate(results)
  const acknowledged = isThrillSoftGateAcknowledged(options.ackMap, options.chapter)
  return {
    enabled: true,
    chapterKey,
    acknowledged,
    fix1Blocked: summary.fix1Blocked,
    allStructuralOk: summary.allStructuralOk,
    passCount: summary.passCount,
    failCount: summary.failCount,
    unknownCount: summary.unknownCount,
    mayContinueGeneration: true,
    productHardGate: false,
    results,
    thinking: formatThrillSoftGateThinkingWithAck(results, acknowledged),
  }
}

/** Chapter key for thril soft-gate acknowledge map (0 = unknown chapter). */
export function thrilAckChapterKey(chapter?: number | null): string {
  if (chapter == null || !Number.isFinite(chapter)) return "0"
  return String(Math.trunc(chapter))
}

/** True when user explicitly acknowledged soft-gate for this chapter (not FIX-1 bypass). */
export function isThrillSoftGateAcknowledged(
  ackMap: Record<string, boolean> | null | undefined,
  chapter?: number | null,
): boolean {
  if (!ackMap) return false
  return ackMap[thrilAckChapterKey(chapter)] === true
}

/** Immutable set/clear of chapter acknowledge flags. */
export function setThrillSoftGateAcknowledged(
  ackMap: Record<string, boolean> | null | undefined,
  chapter: number | null | undefined,
  acknowledged: boolean,
): Record<string, boolean> {
  const key = thrilAckChapterKey(chapter)
  const next = { ...(ackMap ?? {}) }
  if (acknowledged) next[key] = true
  else delete next[key]
  return next
}

/**
 * Annotate thinking when soft-gate has / needs explicit acknowledge.
 * FIX-1 fail is never cleared by acknowledge.
 */
export function formatThrillSoftGateThinkingWithAck(
  results: ThrillCheckResult[],
  acknowledged: boolean,
): string {
  const base = formatThrillSoftGateThinking(results)
  const sum = summarizeThrillSoftGate(results)
  if (sum.fix1Blocked) {
    return [
      base,
      "",
      "【FIX-1】检测到延迟揭露冲突提示：即使已点「确认 thril 软门」，也不可视为结构/文学过关；请改大纲后再写。",
    ].join("\n")
  }
  if (acknowledged) {
    return [
      base,
      "",
      "【已确认】用户已对本分章显式确认 thril 软门（结构提示仍保留在审查列表；非 Track A 硬门）。",
    ].join("\n")
  }
  return [
    base,
    "",
    "【待确认】可在审查中心点击「确认 thril 软门」后再生成；若直接继续生成，仍视为隐式确认（非静默跳过）。",
  ].join("\n")
}
