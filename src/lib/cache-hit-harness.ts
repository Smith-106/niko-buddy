// Copyright (c) 2024 Niko-hub contributors. MIT License.
/**
 * G4b: 前缀缓存命中统计 harness（可重复跑出数字，**不把自测值当成上游回报**）。
 *
 * ## 为什么需要它
 *
 * 「缓存命中率」在仓里此前只有零散诊断字段（`cachedInputTokens` / `startGapMs`），
 * 没有任何**可重复**的口径能把「命中率到底是多少」算出来。没有可重复的口径，
 * 降费结论就只能靠感觉 —— 而感觉最容易变成编造。
 *
 * ## 两层口径（必须分开看，不得混用）
 *
 *   1. **实测层（measured）**：请求体由 `buildChatStablePrefix` +
 *      `composeStableSystemBlocks`（TASK-005 稳定前缀）拼出，复用用
 *      `serializeLlmRequestPayload`（llm-request-trace 的规范化字节序）做**字节级**
 *      最长公共前缀比较 —— 上游前缀缓存认的是字节，不是语义。得到的是「**理论上**
 *      可被复用的前缀 token 占比」（`reusedTokens / currentTokens`）。
 *   2. **模拟层（simulated）**：harness 不联网、拿不到上游 `usage`，所以它**没有**
 *      任何真实的 `cachedInputTokens`。`simulated.stats` 只是「假设上游把实测复用
 *      量原样回报」的推演值，字段名与线上同名是为了复用同一套汇总函数，但**外层
 *      已显式标注 `simulated: true` 且不得当作线上命中率引用**。
 *
 * 纪律：真实 trace（`traces`）里**不写** `cachedInputTokens` —— 把自测值写进
 * 与线上同名的字段会形成自证循环（`cacheHit = cachedInputTokens > 0` 恒真）。
 *
 * ## 两个场景（对应 G4b 的两条目标回归线）
 *
 * - **场景一 · 主对话二轮前缀复用**（目标 99.6%）：长会话第二轮。上一轮的整段
 *   请求（system + 历史 + 上一轮 user）必须原样成为本轮的字节前缀，本轮只追加
 *   「上一轮回答 + 本轮提问」。命中率 = 复用 token / 本轮输入 token，因此它由
 *   `历史体量 : 本轮新增体量` 的比例决定 —— 这也是「长会话第二轮才省钱」的量化表达。
 * - **场景二 · 审稿复用写作前缀**（目标 99.3%）：审稿请求不再自建 system，而是把
 *   写作请求的整段前缀（稳定段 + 章节草稿）原样复用，只在末尾追加审稿指令。
 *   命中率同理由 `写作前缀体量 : 审稿指令体量` 决定。
 *
 * ## 口径纪律
 *
 * 目标线是**下限**（回归线），实测值原样记录在 `hitRatePct` 里；未达目标就是未达，
 * 不允许改口径去凑数。`meetsTarget` 与 `gapPct` 一起输出，差距是负数就照实报。
 */

import {
  buildChatStablePrefix,
  buildStablePrefixTraceFields,
  composeStableSystemBlocks,
  type StablePrefix,
} from "@/lib/stable-prefix"
import {
  LlmRequestTraceCollector,
  buildLlmRequestCacheTrace,
  serializeLlmRequestPayload,
  summarizeLlmCacheHits,
  type LlmCacheHitStats,
  type LlmRequestCacheTrace,
} from "@/lib/llm-request-trace"
import type { ChatMessage } from "@/lib/llm-providers"
import { estimateTokens } from "@/lib/token-estimator"
import type { LlmConfig } from "@/stores/wiki-store"

/** 场景一的目标回归线（token 级命中率，%）。 */
export const CACHE_HIT_TARGET_MAIN_CHAT_PCT = 99.6
/** 场景二的目标回归线（token 级命中率，%）。 */
export const CACHE_HIT_TARGET_REVIEW_REUSE_PCT = 99.3

/**
 * harness 用的固定 provider/model 配置。
 *
 * 取 anthropic：它既有显式 cacheControl 断点、又会回 cachedInputTokens，是唯一
 * 能同时验证「显式断点」与「usage 命中」的通道。时间戳全部写死（不取 Date.now），
 * 保证同一个 harness 跑一万次得到同一组数字。
 */
const HARNESS_LLM_CONFIG: LlmConfig = {
  provider: "anthropic",
  apiKey: "harness-key",
  model: "claude-sonnet-4-5",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 204_800,
}

const HARNESS_BASE_TS = 1_700_000_000_000

/** 场景一的会话体量参数（写死 = 可复现）。 */
export const MAIN_CHAT_SCENARIO_INPUT = {
  /** 历史轮数（每轮 = 1 user + 1 assistant）。 */
  historyRounds: 56,
  /** 每轮 user 指令字符数。 */
  userCharsPerRound: 120,
  /** 每轮 assistant 正文（章节草稿摘录）字符数。 */
  assistantCharsPerRound: 640,
  /** 本轮新增：上一轮回答字符数。 */
  turnOneAnswerChars: 120,
  /** 本轮新增：本轮用户追问字符数。 */
  turnTwoQuestionChars: 40,
} as const

/** 场景二的体量参数（写死 = 可复现）。 */
export const REVIEW_SCENARIO_INPUT = {
  /** 写作请求里的章节草稿字符数（长篇一章的正文量级）。 */
  draftChars: 14_000,
  /** 写作请求里的细纲字符数。 */
  outlineChars: 1_200,
  /** 写作请求的用户指令字符数。 */
  writingInstructionChars: 160,
  /** 审稿请求追加的审稿指令字符数。 */
  reviewInstructionChars: 80,
} as const

const SKILL_PROMPT = [
  "## 技能：章节续写",
  "- 严格沿用既有设定：人名、地名、时间线、已建立的道具与伏笔不得改名或重置。",
  "- 每章只推进一个主要事件，结尾留一个未解决的钩子。",
  "- 对话要推动情节，不要用来解释设定。",
  "- 禁止出现元叙述：不要写「本章将」「接下来」。",
].join("\n")

const DRAFT_UNIT = "夜色压在城墙上，风从缺口灌进来，他把那枚旧铜钥匙在掌心里转了半圈，忽然听见远处传来一声闷响。"

const OUTLINE_UNIT = "第一幕：主角在城门受阻，守军要求出示通行符。第二幕：他以旧铜钥匙换来一次单独问话的机会。"

const QUESTION_UNIT = "继续写下一章，保持同样的节奏和视角，不要解释创作思路。"

const ANSWER_UNIT = "已按上一章的伏笔续写，结尾停在他推开门的那一刻。"

const REVIEW_UNIT = "请按章节输出规则审查上面的草稿，指出三处最需要返修的地方，不要改写正文。"

/** 生成确定性的 CJK 文本（按单元重复后截断，长度精确）。 */
function cjkText(targetChars: number, unit: string): string {
  if (targetChars <= 0) return ""
  const repeated = unit.repeat(Math.ceil(targetChars / unit.length) + 1)
  return repeated.slice(0, targetChars)
}

/**
 * 两个字符串的字节级（UTF-16 码元级）最长公共前缀长度。
 *
 * 逐码元比较而不是逐 token 比较：上游缓存按字节判等，token 只是计费单位。
 * 先比长度再做二分没有收益（这里两侧都是几千到几万字符，线性比较足够快），
 * 直接线性扫描，语义最直白。
 */
export function longestCommonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1
  return index
}

/** 一次「上一轮 vs 本轮」的前缀复用测量。 */
export interface PrefixReuseMeasurement {
  /** 公共前缀的字符数（字节级判等结果）。 */
  reusedChars: number
  /** 本轮请求的字符数。 */
  currentChars: number
  /** 公共前缀的 token 估算（= 真正被上游缓存复用的 token）。 */
  reusedTokens: number
  /** 本轮请求的 token 估算（= 本轮输入 token）。 */
  currentTokens: number
  /** reusedTokens / currentTokens × 100。 */
  hitRatePct: number
}

/**
 * 测量两次请求之间的前缀复用。
 *
 * 入参是 `serializeLlmRequestPayload` 的产物（规范化 JSON），所以比较的是
 * 「发给上游的字节」，而不是消息对象的字段值 —— 后者会把「字段相同但序列化
 * 顺序不同」误判成命中。
 */
export function measurePrefixReuse(previousPayload: string, currentPayload: string): PrefixReuseMeasurement {
  const reusedChars = longestCommonPrefixLength(previousPayload, currentPayload)
  const reusedText = currentPayload.slice(0, reusedChars)
  const reusedTokens = estimateTokens(reusedText)
  const currentTokens = estimateTokens(currentPayload)
  return {
    reusedChars,
    currentChars: currentPayload.length,
    reusedTokens,
    currentTokens,
    hitRatePct: currentTokens > 0 ? (reusedTokens / currentTokens) * 100 : 0,
  }
}

/** 单个场景的测量结果。 */
export interface CacheHitScenarioResult extends PrefixReuseMeasurement {
  id: string
  name: string
  /** 目标回归线（%）。 */
  targetHitRatePct: number
  /** 实测 − 目标（负数 = 未达，照实输出）。 */
  gapPct: number
  meetsTarget: boolean
  /** 参与比较的请求条数（场景一 = 2，场景二 = 2）。 */
  requests: number
}

export interface CacheHitHarnessReport {
  scenarios: CacheHitScenarioResult[]
  /**
   * 落成的真实 trace。
   *
   * **不写 `cachedInputTokens`**：harness 不联网，没有上游 usage。真实 trace 的
   * `cacheHit` / `savedTokens` 只允许由上游回报填充，绝不拿自测值代填（否则
   * `cacheHit = cachedInputTokens > 0` 就成了自证）。
   */
  traces: LlmRequestCacheTrace[]
  /** 实测层：字节级最长公共前缀（理论可复用前缀占比，不是上游命中率）。 */
  measured: CacheHitMeasuredSummary
  /** 模拟层：假设上游把实测复用量原样回报时的汇总（**不是线上口径**）。 */
  simulated: CacheHitSimulatedSummary
  /**
   * 线上实测层（G4）：`runCacheHitHarness()` **恒为 null** —— harness 不联网，
   * 拿不到上游 usage。只有 `cache-hit-measure.real-llm.spec.ts` 真发请求后
   * 才可能填值；未测时保持 null，**绠不拿另外两层的数字顶替**。
   */
  liveMeasured: CacheHitLiveMeasuredSummary | null
  /** 两个场景的 token 级命中率均值（仅作对照，不是目标线）。 */
  averageHitRatePct: number
}

/**
 * 线上实测层（G4）：**真发请求后从上游 `usage` 读到的**缓存命中读数。
 *
 * 与另外两层的区别：
 *  - `measured`（byte-lcp）：字节级最长公共前缀，证明「前缀稳定」，不等于按缓存计价；
 *  - `simulated`：假设上游原样回报的推演，`simulated: true`；
 *  - `liveMeasured`：本层，只有真读过上游 usage 才有值；**没测就是 `null`**。
 *
 * 纪律：本层不允许由 harness 自己推演填充。`runCacheHitHarness()` 恒返回
 * `null`，只有 `cache-hit-measure.real-llm.spec.ts` 真发请求后才可能产出读数。
 */
export interface CacheHitLiveMeasuredSummary {
  /** 读数来源（端点 / 模型 / 时间），用于追溯。 */
  measuredFrom: { endpoint?: string; model?: string; at: string }
  /** 冷请求读数。 */
  cold: { cachedTokens: number; inputTotalTokens?: number; hitRatePct: number | null; usageKey: string }
  /** 热请求读数（同前缀第二次请求）。 */
  warm: { cachedTokens: number; inputTotalTokens?: number; hitRatePct: number | null; usageKey: string }
  /** 口径标记：恒为 `upstream-usage`。 */
  basis: "upstream-usage"
}

/** 实测层汇总（口径 = 字节级 LCP，不依赖任何上游回报）。 */
export interface CacheHitMeasuredSummary {
  /** 参与汇总的请求条数。 */
  requests: number
  /** 可复用前缀 token 估算（各场景 reusedTokens 之和）。 */
  reusedTokens: number
  /** 本轮输入 token 估算（各场景 currentTokens 之和）。 */
  currentTokens: number
  /** reusedTokens / currentTokens × 100。 */
  hitRatePct: number
  /** 口径标记：恒为 `byte-lcp`（字节级最长公共前缀实测）。 */
  basis: "byte-lcp"
}

/**
 * 模拟层汇总 —— **显式标注 simulated**。
 *
 * `stats` 字段名与线上汇总同构是为了复用 `summarizeLlmCacheHits`；但它由
 * 「假设 cachedInputTokens = 实测复用 token」推演而来，不能当作线上命中率引用。
 * 读这个字段前请先读 `simulated` / `note`。
 */
export interface CacheHitSimulatedSummary {
  /** 恒为 true：提醒调用方这不是上游回报。 */
  simulated: true
  /** 口径说明（人读）。 */
  note: string
  /** 推演出的命中汇总（由模拟 trace 算出，不是线上 usage）。 */
  stats: LlmCacheHitStats
}

interface ScenarioBuild {
  id: string
  name: string
  targetHitRatePct: number
  stablePrefix: StablePrefix
  previousMessages: ChatMessage[]
  currentMessages: ChatMessage[]
  /** 场景内的请求起始时间（写死，保证可复现）。 */
  previousStartedAt: number
  currentStartedAt: number
}

/**
 * 场景一：主对话二轮。
 *
 * 组装方式与 chat-panel-context-assembly 一致：稳定段带 cacheControl 断点，
 * 动态段（资料库索引 / 页面 / 上下文包）跟在后面。第二轮**不重建** system，
 * 而是在上一轮整段消息之后追加「上一轮回答 + 本轮提问」—— 只有这样才能让
 * 上一轮请求成为本轮的字节前缀（重建 system 会让动态段一抖动就整段失效）。
 */
function buildMainChatScenario(): ScenarioBuild {
  const params = MAIN_CHAT_SCENARIO_INPUT
  const stablePrefix = buildChatStablePrefix({ novelMode: true, skillPrompt: SKILL_PROMPT })
  const dynamicParts = [
    "## 资料库索引\n" + cjkText(600, "第一章 城门|第二章 铜钥匙|第三章 旧城墙|"),
    "## 页面列表\n" + cjkText(900, "城门设定：守军换防在子时，通行符由巡夜校尉签发。"),
    "## 资料页面\n\n" + cjkText(1_500, "旧铜钥匙来自第一幕的守城老兵，编号与城防图上的第七格对应。"),
  ]
  const systemBlocks = composeStableSystemBlocks(stablePrefix, dynamicParts)

  const history: ChatMessage[] = []
  for (let round = 1; round <= params.historyRounds; round += 1) {
    history.push({
      role: "user",
      content: `第${round}轮：` + cjkText(params.userCharsPerRound, QUESTION_UNIT),
    })
    history.push({
      role: "assistant",
      content: cjkText(params.assistantCharsPerRound, DRAFT_UNIT),
    })
  }

  const previousMessages: ChatMessage[] = [
    { role: "system", content: systemBlocks },
    ...history,
    { role: "user", content: cjkText(params.turnTwoQuestionChars, "写第57章，衔接上一章的断点。") },
  ]
  const currentMessages: ChatMessage[] = [
    ...previousMessages,
    { role: "assistant", content: cjkText(params.turnOneAnswerChars, ANSWER_UNIT) },
    { role: "user", content: cjkText(params.turnTwoQuestionChars, "继续，保持同一视角。") },
  ]

  return {
    id: "main-chat-second-turn",
    name: "场景一 · 主对话二轮前缀复用",
    targetHitRatePct: CACHE_HIT_TARGET_MAIN_CHAT_PCT,
    stablePrefix,
    previousMessages,
    currentMessages,
    previousStartedAt: HARNESS_BASE_TS,
    currentStartedAt: HARNESS_BASE_TS + 60_000,
  }
}

/**
 * 场景二：审稿复用写作前缀。
 *
 * 写作请求的 system 已经是「稳定段（带断点）+ 章节草稿 + 细纲」，审稿请求
 * 只在这段之后追加审稿指令 —— 不重建 system、不换 skillPrompt。这正是
 * 「审稿复用写作前缀」的实现口径：审稿一旦自建 system，稳定段哈希就变，
 * 上游缓存整段作废（命中率归零）。
 */
function buildReviewReuseScenario(): ScenarioBuild {
  const params = REVIEW_SCENARIO_INPUT
  const stablePrefix = buildChatStablePrefix({ novelMode: true, skillPrompt: SKILL_PROMPT })
  const dynamicParts = [
    "## 章节草稿\n\n" + cjkText(params.draftChars, DRAFT_UNIT),
    "## 本章细纲\n" + cjkText(params.outlineChars, OUTLINE_UNIT),
  ]
  const systemBlocks = composeStableSystemBlocks(stablePrefix, dynamicParts)

  const previousMessages: ChatMessage[] = [
    { role: "system", content: systemBlocks },
    { role: "user", content: cjkText(params.writingInstructionChars, "按细纲把这一章写完，只输出正文。") },
  ]
  const currentMessages: ChatMessage[] = [
    ...previousMessages,
    { role: "user", content: cjkText(params.reviewInstructionChars, REVIEW_UNIT) },
  ]

  return {
    id: "review-reuses-writing-prefix",
    name: "场景二 · 审稿复用写作前缀",
    targetHitRatePct: CACHE_HIT_TARGET_REVIEW_REUSE_PCT,
    stablePrefix,
    previousMessages,
    currentMessages,
    previousStartedAt: HARNESS_BASE_TS + 10 * 60_000,
    currentStartedAt: HARNESS_BASE_TS + 11 * 60_000,
  }
}

/**
 * 跑一遍 harness，返回可重复的实测数字。
 *
 * 纯函数（除了 await 稳定前缀哈希）：不读时钟、不读 store、不联网。同一个
 * 输入永远得到同一组 `hitRatePct` —— 这是它作为回归线的前提。
 */
export async function runCacheHitHarness(): Promise<CacheHitHarnessReport> {
  const builds = [buildMainChatScenario(), buildReviewReuseScenario()]
  const collector = new LlmRequestTraceCollector()
  /** 模拟层单独的 collector：真实 trace 里绝不出现自测的 cachedInputTokens。 */
  const simulatedCollector = new LlmRequestTraceCollector()
  const scenarios: CacheHitScenarioResult[] = []

  for (const build of builds) {
    const previousPayload = serializeLlmRequestPayload(build.previousMessages)
    const currentPayload = serializeLlmRequestPayload(build.currentMessages)
    const measurement = measurePrefixReuse(previousPayload, currentPayload)
    const gapPct = measurement.hitRatePct - build.targetHitRatePct

    // 稳定前缀占位（TASK-005）：版本 + 哈希 + token 估算一并落进 trace。
    const traceFields = await buildStablePrefixTraceFields(build.stablePrefix)
    const traceInput = {
      config: HARNESS_LLM_CONFIG,
      stablePrefix: { version: build.stablePrefix.version, ...traceFields },
      startedAt: build.currentStartedAt,
      finishedAt: build.currentStartedAt + 1_500,
      firstResponseAt: build.currentStartedAt + 400,
      // 真实 trace：只写能确认的量（本轮输入 token）。`cachedInputTokens` 缺失 =
      // 「上游没报」——不拿自测的复用量代填。
      usage: {
        inputTokens: measurement.currentTokens,
        outputTokens: 0,
      },
      status: "success" as const,
    }
    collector.record(buildLlmRequestCacheTrace(traceInput))
    // 模拟层：显式把实测复用量当作「假设的上游回报」，只用于演示口径。
    simulatedCollector.record(
      buildLlmRequestCacheTrace({
        ...traceInput,
        usage: {
          inputTokens: measurement.currentTokens,
          outputTokens: 0,
          cachedInputTokens: measurement.reusedTokens,
        },
      }),
    )

    scenarios.push({
      id: build.id,
      name: build.name,
      targetHitRatePct: build.targetHitRatePct,
      gapPct,
      meetsTarget: gapPct >= 0,
      requests: 2,
      ...measurement,
    })
  }

  const traces = collector.snapshot().requests
  const simulatedStats = summarizeLlmCacheHits(simulatedCollector.snapshot().requests)
  const averageHitRatePct = scenarios.length > 0
    ? scenarios.reduce((sum, scenario) => sum + scenario.hitRatePct, 0) / scenarios.length
    : 0
  const reusedTokens = scenarios.reduce((sum, scenario) => sum + scenario.reusedTokens, 0)
  const currentTokens = scenarios.reduce((sum, scenario) => sum + scenario.currentTokens, 0)
  const measured: CacheHitMeasuredSummary = {
    requests: scenarios.reduce((sum, scenario) => sum + scenario.requests, 0),
    reusedTokens,
    currentTokens,
    hitRatePct: currentTokens > 0 ? (reusedTokens / currentTokens) * 100 : 0,
    basis: "byte-lcp",
  }

  return {
    scenarios,
    traces,
    measured,
    simulated: {
      simulated: true,
      note: "假设上游把实测复用量原样回报（cachedInputTokens = byte-LCP 复用 token）；harness 不联网，这不是线上命中率",
      stats: simulatedStats,
    },
    averageHitRatePct,
    // G4：harness 不联网 → 实测层恒为空（见 CacheHitLiveMeasuredSummary 纪律）。
    liveMeasured: null,
  }
}

/** 人类可读的 harness 输出（命令行 / 日志 / 交付物里贴的都是这一份）。 */export function formatCacheHitReport(report: CacheHitHarnessReport): string {
  const lines: string[] = ["G4b 前缀缓存命中 harness（实测层 = 字节级 LCP）"]
  for (const scenario of report.scenarios) {
    lines.push(
      `${scenario.name}: ${scenario.hitRatePct.toFixed(2)}%`
      + `（目标 ≥ ${scenario.targetHitRatePct}%，${scenario.meetsTarget ? "达标" : "未达"}`
      + `，gap ${scenario.gapPct >= 0 ? "+" : ""}${scenario.gapPct.toFixed(2)}pp）`
      + ` 复用 ${scenario.reusedTokens}/${scenario.currentTokens} tokens`
      + `，请求 ${scenario.requests} 条`,
    )
  }
  lines.push(
    `实测汇总（${report.measured.basis}）: 可复用前缀 ${report.measured.reusedTokens}/${report.measured.currentTokens} tokens`
    + `（${report.measured.hitRatePct.toFixed(2)}%），请求 ${report.measured.requests} 条`,
  )
  // 模拟层显式标注：不与实测层并排冒充线上口径。
  lines.push(
    `模拟汇总（simulated，不是上游回报）: 命中请求 ${report.simulated.stats.hits}/${report.simulated.stats.requests}`
    + `（${report.simulated.stats.hitRatePct.toFixed(2)}%），`
    + `节省 ${report.simulated.stats.savedTokens}/${report.simulated.stats.inputTokens} tokens`
    + `（${report.simulated.stats.savedInputPct.toFixed(2)}%）`,
  )
  lines.push(`模拟口径：${report.simulated.note}`)
  // 线上实测层：只有真读过上游 usage 才有值。null 时显式声明「未测」，
  // 绝不拿上面两层数字顶替（那是自证）。
  if (report.liveMeasured) {
    const { cold, warm, measuredFrom, basis } = report.liveMeasured
    const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(2)}%`)
    lines.push(
      `线上实测层（${basis}，${measuredFrom.model ?? "?"} @ ${measuredFrom.at}）: `
      + `冷 ${cold.cachedTokens}/${cold.inputTotalTokens ?? "?"} tokens（${pct(cold.hitRatePct)}，键 ${cold.usageKey}），`
      + `热 ${warm.cachedTokens}/${warm.inputTotalTokens ?? "?"} tokens（${pct(warm.hitRatePct)}，键 ${warm.usageKey}）`,
    )
  } else {
    lines.push("线上实测层: 未测（无上游 usage 读数；见 cache-hit-measure.real-llm.spec.ts）")
  }
  return lines.join("\n")
}

/**
 * G4 实测层的**唯一构造入口**。
 *
 * 为什么要强制走构造函数：`liveMeasured` 如果可以被随手写一个字面量，就失去了
 * 「只有真读过上游 usage 才能有值」的约束。这里把 `basis` 固定成
 * `upstream-usage`，并要求调用方交出原始 `usageKey`（证据），让伪造变成显式行为
 * 而不是顺手为之。
 */
export function buildLiveMeasuredSummary(input: {
  measuredFrom: { endpoint?: string; model?: string; at: string }
  cold: { cachedTokens: number; inputTotalTokens?: number; hitRate: number | null; usageKey: string }
  warm: { cachedTokens: number; inputTotalTokens?: number; hitRate: number | null; usageKey: string }
}): CacheHitLiveMeasuredSummary {
  const normalize = (m: {
    cachedTokens: number
    inputTotalTokens?: number
    hitRate: number | null
    usageKey: string
  }) => ({
    cachedTokens: m.cachedTokens,
    inputTotalTokens: m.inputTotalTokens,
    // 命中率越界（>1 或 <0）说明分母口径错了——宁可置 null 也不输出荒谬数字。
    hitRatePct: m.hitRate === null || m.hitRate < 0 || m.hitRate > 1 ? null : m.hitRate * 100,
    usageKey: m.usageKey,
  })
  return {
    measuredFrom: input.measuredFrom,
    cold: normalize(input.cold),
    warm: normalize(input.warm),
    basis: "upstream-usage",
  }
}
