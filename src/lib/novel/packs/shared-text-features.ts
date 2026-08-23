/**
 * shared-text-features.ts — T24 共享特征预计算 + 核心 pack 组合入口
 *
 * 蓝图 §6 T24 (TASK-P3-24) 要求 5:
 *   "共享特征预计算: n-gram/句式统计算一次供多 pack 复用（避免重复扫描全文）"。
 *
 * 设计:
 *   - precomputeTextFeatures(rawText): 对章节正文做一次扫描，产出句式/段落/
 *     n-gram/标点四类统计特征（SharedTextFeatures），由 composeCoreRulePacks
 *     计算一次后注入多个 pack 工厂复用——各 pack 规则不再各自重扫全文。
 *   - composeCoreRulePacks(inputs): T24 四包组合入口（continuity / anti-ai-mech /
 *     anti-ai-llm / quality-six-dim），共享同一份 SharedTextFeatures 实例；
 *     产物交由 T23 combinePacks() 冻结组合（run 前冻结，禁动态注册——
 *     冻结职责归 rule-stack.combinePacks，本模块只产未冻包定义）。
 *
 * 边界:
 *   - 不含 literary-craft-pack / craft-rule-registry（归 T28，并行任务隔离）。
 *   - 机械层零模型调用 (ADR-19): 本模块纯算术统计，无 IO / 无网络 / 无模型调用。
 *   - Draft-first (ADR-08): 只读输入文本，不写任何会话状态。
 *
 * @license MIT © QMAI
 */

import { normalizeText } from "../mechanical-slop-detector"
import type { ContinuityInput, ContinuityOverrideStore, ContinuityEngineConfig } from "../deterministic-continuity-engine"
import type { AntiAiTextOrigin } from "../anti-ai-candidate-pool"
import {
  createAntiAiMechPack,
  type AntiAiPoolLike,
} from "./anti-ai-mech-pack"
import { createAntiAiLlmPack, type AntiAiLlmFindingInput } from "./anti-ai-llm-pack"
import { createContinuityPack, EMPTY_CONTINUITY_INPUT } from "./continuity-pack"
import { createQualitySixDimPack, type QualitySixDimInputs } from "./quality-six-dim-pack"
import type { RulePackDefinition } from "../rule-stack"
import { AntiAiCandidatePool } from "../anti-ai-candidate-pool"

// ============================================================================
// 共享特征类型
// ============================================================================

/** 中文标点统计字符集（与 anti-ai-candidate-pool 标点指纹同集）。 */
export const SHARED_PUNCTUATION_CHARS = "，。！？、；：\u201c\u201d''…—·～"

/**
 * 共享文本特征（一次扫描、多 pack 复用）。
 * 全部字段为派生只读统计，不含正文原文（normalizedText 除外——供需要
 * 防绕过预处理文本的机械扫描消费，不外泄到 finding message, 守 CWE-532）。
 */
export interface SharedTextFeatures {
  /** 原文长度（字符）。 */
  readonly rawLength: number
  /** 防绕过预处理后的文本（零宽剥离/同形字还原，复用 mechanical-slop-detector.normalizeText）。 */
  readonly normalizedText: string
  /** S1a 预处理旁路计数（bypassCount 透传）。 */
  readonly bypassCount: number
  /** 句长数组（按中文句末标点分句后的每句字符数）。 */
  readonly sentenceLengths: readonly number[]
  /** 句长变异系数 CV = stddev/mean（越低越机械）。 */
  readonly sentenceLengthCV: number
  /** 段落长度数组（按换行分段后的每段字符数）。 */
  readonly paragraphLengths: readonly number[]
  /** 段落长度变异系数 CV。 */
  readonly paragraphLengthCV: number
  /** token 总数（按标点/空白切分）。 */
  readonly tokenCount: number
  /** 句级 3-gram 总数。 */
  readonly trigramTotal: number
  /** 句级 3-gram 去重后数量（unique/total = 多样性参照）。 */
  readonly trigramUnique: number
  /** 标点出现计数（SHARED_PUNCTUATION_CHARS 内字符）。 */
  readonly punctuationCounts: Readonly<Record<string, number>>
  /** 标点总数。 */
  readonly punctuationTotal: number
}

// ============================================================================
// 内部统计工具（与 mechanical-slop-detector / anti-ai-candidate-pool 同口径正则）
// ============================================================================

/** 按中文句末标点分句，返回每句长度（口径同 mechanical-slop-detector.splitSentences）。 */
function splitSentenceLengths(text: string): number[] {
  if (!text || text.trim().length === 0) return []
  return text
    .split(/[。！？.?!]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.length)
}

/** 按换行分段，返回每段长度（口径同 anti-ai-candidate-pool.splitParagraphs）。 */
function splitParagraphLengths(text: string): number[] {
  if (!text || text.trim().length === 0) return []
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => p.length)
}

/** 按 token 切分（口径同 anti-ai-candidate-pool.tokenize）。 */
function tokenize(text: string): string[] {
  return text.split(/[，。！？、；：""''（）\s\n]+/).filter((t) => t.length > 0)
}

/** 句级 word n-gram 提取（口径同 anti-ai-candidate-pool.extractWordNGrams）。 */
function extractWordNGrams(tokens: string[], n: number): string[] {
  const ngrams: string[] = []
  for (let i = 0; i <= tokens.length - n; i++) {
    ngrams.push(tokens.slice(i, i + n).join(""))
  }
  return ngrams
}

/** 变异系数 CV = stddev / mean（空/零均值安全返回 0）。 */
function coefficientOfVariation(lengths: readonly number[]): number {
  if (lengths.length === 0) return 0
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length
  if (mean === 0) return 0
  const variance = lengths.reduce((sum, l) => sum + (l - mean) ** 2, 0) / lengths.length
  return Math.sqrt(variance) / mean
}

// ============================================================================
// 公共 API — 预计算
// ============================================================================

/**
 * 一次扫描计算全部共享特征。纯函数：不修改输入，无副作用。
 * 空文本安全：各统计返回空数组/0，不抛错。
 */
export function precomputeTextFeatures(rawText: string): SharedTextFeatures {
  const { text, bypassCount = 0 } = normalizeText(rawText)

  const sentenceLengths = splitSentenceLengths(text)
  const paragraphLengths = splitParagraphLengths(text)
  const tokens = tokenize(text)
  const trigrams = extractWordNGrams(tokens, 3)
  const trigramCounts = new Map<string, number>()
  for (const ng of trigrams) {
    trigramCounts.set(ng, (trigramCounts.get(ng) ?? 0) + 1)
  }

  const punctuationCounts: Record<string, number> = {}
  let punctuationTotal = 0
  for (const ch of text) {
    if (SHARED_PUNCTUATION_CHARS.includes(ch)) {
      punctuationCounts[ch] = (punctuationCounts[ch] ?? 0) + 1
      punctuationTotal++
    }
  }

  return {
    rawLength: rawText.length,
    normalizedText: text,
    bypassCount,
    sentenceLengths,
    sentenceLengthCV: coefficientOfVariation(sentenceLengths),
    paragraphLengths,
    paragraphLengthCV: coefficientOfVariation(paragraphLengths),
    tokenCount: tokens.length,
    trigramTotal: trigrams.length,
    trigramUnique: trigramCounts.size,
    punctuationCounts,
    punctuationTotal,
  }
}

// ============================================================================
// 公共 API — 核心四包组合入口
// ============================================================================

/**
 * 默认池惰性构造（单例复用避免重复加载语料）。
 * 仅在 composeCoreRulePools 未注入 pool 且 chapterContent 提供时触发。
 */
let _defaultPoolForCompose: AntiAiCandidatePool | null = null
function getDefaultPoolForCompose(): AntiAiCandidatePool {
  if (!_defaultPoolForCompose) {
    _defaultPoolForCompose = new AntiAiCandidatePool()
    _defaultPoolForCompose.loadCorpus()
  }
  return _defaultPoolForCompose
}

/** composeCoreRulePacks 输入（各域可选；缺省域产出空规则包，packIds 保持稳定）。 */
export interface CorePackInputs {
  /** 章节正文（共享特征预计算的唯一扫描对象；缺省时各文本类包走各自的空态）。 */
  readonly chapterContent?: string
  /**
   * 文本来源声明（20260823 #34 前置埋点；调用方声明，不可判定时缺省）。
   * 纯元数据透传至 anti-ai mech 包报告打标，不影响任何门控结果。
   */
  readonly origin?: AntiAiTextOrigin
  /** #34 sink 报告暴露钩子（透传给 mech 包 onPoolReport；详见 anti-ai-mech-pack.ts）*/
  readonly onPoolReport?: (report: import("../anti-ai-candidate-pool").AntiAiAnalysisReport | null) => void
  /** 连续性引擎入参（checkContinuity 的 ReadonlyStore 同构 + 可选 config/override）。 */
  readonly continuity?: ContinuityInput & {
    readonly config?: ContinuityEngineConfig
    readonly overrides?: ContinuityOverrideStore
  }
  /** T19 候选池实例（可注入 stub；缺省惰性构造默认池，保留 DI 覆盖）。 */
  readonly pool?: AntiAiPoolLike
  /** LLM 审查产出（anti-AI 相关 findings 投影；结构化最小接口，见 anti-ai-llm-pack）。 */
  readonly llmFindings?: readonly AntiAiLlmFindingInput[]
  /** 六维评审结果（quality-six-dim pack 输入）。 */
  readonly sixDimResults?: QualitySixDimInputs["results"]
}

/**
 * 组合 T24 核心四包（continuity / anti-ai-mech / anti-ai-llm / quality-six-dim）。
 *
 * 共享预计算契约：
 *   - chapterContent 提供时 precomputeTextFeatures **只调一次**，同一 features
 *     实例注入 anti-ai-mech 与 quality-six-dim 两包（n-gram/句式统计不重扫全文）；
 *   - 连续性 findings 由 continuity-pack 内部对 checkContinuity 单次求值并 memo，
 *     各规则共享同一 findings 数组（同章不重复跑引擎）。
 *
 * 冻结语义：本函数返回**未冻结**的 RulePackDefinition[]；调用方必须经
 * T23 combinePacks() 完成规范化排序 + 深度冻结后再 runRuleStack()
 * （run 前冻结，禁动态注册——守 rule-stack D4 口径）。
 */
export function composeCoreRulePacks(inputs: CorePackInputs): RulePackDefinition[] {
  const features =
    inputs.chapterContent !== undefined ? precomputeTextFeatures(inputs.chapterContent) : undefined

  const continuityPack = inputs.continuity
    ? createContinuityPack({
        foreshadowing: inputs.continuity.foreshadowing,
        subplots: inputs.continuity.subplots,
        characters: inputs.continuity.characters,
        snapshots: inputs.continuity.snapshots,
        currentChapter: inputs.continuity.currentChapter,
        ...(inputs.continuity.config ? { config: inputs.continuity.config } : {}),
        ...(inputs.continuity.overrides ? { overrides: inputs.continuity.overrides } : {}),
      })
    : createContinuityPack(EMPTY_CONTINUITY_INPUT)

  // 生产池装配：调用方未注入 pool 时惰性构造默认池实例（保留 DI 覆盖，
  // 等价于 quickAntiAiAnalysis 的默认池，使 renderer 可直连）。
  // 见 DEBT-20260824-T24-01 偿还注记。
  const defaultPool = !inputs.pool && inputs.chapterContent !== undefined
    ? getDefaultPoolForCompose()
    : undefined
  const pool = inputs.pool ?? defaultPool

  const antiAiMechPack = createAntiAiMechPack({
    ...(inputs.chapterContent !== undefined ? { text: inputs.chapterContent } : {}),
    ...(features ? { features } : {}),
    ...(pool ? { pool } : {}),
    ...(inputs.origin ? { origin: inputs.origin } : {}),
    ...(inputs.onPoolReport ? { onPoolReport: inputs.onPoolReport } : {}),
  })

  const antiAiLlmPack = createAntiAiLlmPack({
    findings: inputs.llmFindings ?? [],
  })

  const qualitySixDimPack = createQualitySixDimPack({
    results: inputs.sixDimResults ?? {},
    ...(features ? { features } : {}),
  })

  return [continuityPack, antiAiMechPack, antiAiLlmPack, qualitySixDimPack]
}
