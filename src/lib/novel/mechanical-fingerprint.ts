/**
 * mechanical-fingerprint.ts — P1-1 统计指纹自检 (零 LLM/IO, A19 机械层)
 *
 * 共识 (V2-ds stat-fingerprint / V2-glm mechanical-fingerprint / V1-ds r-verify):
 * QMAI 现有 de-ai-rules T19 的「突发性/熵」只在 LLM prompt 文本里描述,
 * 没有确定性度量。本模块补齐句长分布 (mean/std/CV/分位)、Shannon 熵、
 * 突发性 (burstiness)、句首多样性、高频词重复率 —— 纯算术, 输出 0-1 分 + band。
 *
 * 用途:
 *   - 改写前后指纹对比 (before/after delta) — humanizer-x Pass4 思路
 *   - narrative-echo-detector / de-ai-selfcheck 复用
 *   - Track B soft 参考, 不设产品硬门
 *
 * 参考 (只读): humanizer-x SKILL.md Pass3 统计调优 (perplexity/burstiness/entropy)
 * 思路, 但不引入 LLM perplexity (ADR-19 零 LLM/IO 确定性层)。
 */

import { normalizeSourceText } from "./normalize-source-text"

/** 指纹 band: 各维度 0-1 自然化得分 (越高越像人写) */
export type FingerprintBand = "unnatural" | "borderline" | "natural"

/** 文本统计指纹 (0-1 各维度) */
export interface FingerprintResult {
  /** 句长分布特征 */
  sentence: {
    mean: number
    std: number
    cv: number
    p25: number
    p75: number
    /** 句长分布 Shannon 熵 (归一化到 [0,1]) */
    entropy: number
  }
  /** 突发性: 短长句交替程度 (0=匀速, 1=强烈交替) */
  burstiness: number
  /** 句首多样性: 独特句首占比 */
  openerDiversity: number
  /** 高频词重复率: 最常用词占全部词比例 (过高=词汇贫乏) */
  topWordRepetition: number
  /** 0-1 综合自然化得分 (各维加权) */
  score: number
}

/** 分句: 中文句末标点 + 英文句号, 保留句长 (字符数) */
function splitSentences(text: string): string[] {
  if (!text || text.trim().length === 0) return []
  return text
    .split(/[。！？.?!]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
}

/** 句长分布 Shannon 熵 (归一化到 [0,1] — 均匀分布=1) */
function sentenceEntropy(lengths: number[]): number {
  if (lengths.length === 0) return 0
  const buckets = new Map<number, number>()
  for (const l of lengths) {
    // 长度分桶 (5 字符一桶, 上限 60+)
    const bucket = Math.min(12, Math.floor(l / 5))
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
  }
  let entropy = 0
  for (const c of buckets.values()) {
    const p = c / lengths.length
    entropy -= p * Math.log2(p)
  }
  const maxEntropy = Math.log2(13) // 13 桶
  return maxEntropy > 0 ? entropy / maxEntropy : 0
}

/** 突发性 (Burstiness): (std - mean) / (std + mean) 规范化到 [0,1] */
function burstiness(std: number, mean: number): number {
  if (mean === 0) return 0
  const b = (std - mean) / (std + mean)
  return Math.max(0, Math.min(1, (b + 1) / 2))
}

/** 分位 (nearest-rank, 与 de-ai-percentile 一致) */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]!
}

/**
 * 统计指纹自检 (零 LLM)。
 *
 * 算法:
 *   - 句长 CV: 0.2-0.7 为自然区间 (中文短句为主 CV 偏低, 参考 mechanical
 *     SENTENCE_CV_LOW_THRESHOLD=0.1; 35 号 DD-3 S7 实测 human P50=0.51); CV 过低=机械齐整, 过高=人为造不规则
 *   - 熵: 接近均匀分布=1 (自然), 集中=0
 *   - 突发性: 中等区间 (0.3-0.7) 自然; 过高=假不规则, 过低=匀速
 *   - 句首多样性: 独特句首 / 总句数
 *   - 高频词重复: 频率最高词占全部字符比例 (中文按字计算)
 *
 * 输出 score 0-1 (越高越像自然文本), band 划分:
 *   <0.35 unnatural / <0.6 borderline / >=0.6 natural
 */
export function statisticalFingerprint(rawText: string): FingerprintResult {
  const { text } = normalizeSourceText(rawText)
  const sentences = splitSentences(text)
  if (sentences.length === 0) {
    return {
      sentence: { mean: 0, std: 0, cv: 0, p25: 0, p75: 0, entropy: 0 },
      burstiness: 0,
      openerDiversity: 0,
      topWordRepetition: 0,
      score: 0,
    }
  }

  const lengths = sentences.map((s) => s.length)
  const mean = lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0
  const variance =
    lengths.length > 0
      ? lengths.reduce((s, l) => s + (l - mean) ** 2, 0) / lengths.length
      : 0
  const std = Math.sqrt(variance)
  const cv = mean > 0 ? std / mean : 0
  const sorted = [...lengths].sort((a, b) => a - b)

  // 句首多样性: 每句前 2 个字符作签名, 独特签名占比
  const openers = sentences.map((s) => s.slice(0, 2))
  const uniqueOpeners = new Set(openers)
  const openerDiversity =
    openers.length > 0 ? uniqueOpeners.size / openers.length : 0

  // 高频词重复率: 按单字频率 (中文无词界, 用字符近似)
  const chars = text.replace(/\s+/g, "")
  const freq = new Map<string, number>()
  for (const c of chars) freq.set(c, (freq.get(c) ?? 0) + 1)
  let topCount = 0
  for (const n of freq.values()) {
    if (n > topCount) topCount = n
  }
  const topWordRepetition = chars.length > 0 ? topCount / chars.length : 0

  // 综合评分 (0-1, 各维贡献)
  // - CV: 自然区间 0.2-0.7 → 1.0, 越偏离越低 (线性衰减)
  //   35 号 DD-3 标定 S7: 0.2-0.5→0.2-0.7（实测 human P50=0.51 恰在旧窗沿、P75=0.58 出窗）
  let cvScore = 0
  if (cv >= 0.2 && cv <= 0.7) cvScore = 1
  else if (cv < 0.2) cvScore = cv / 0.2
  else cvScore = Math.max(0, 1 - (cv - 0.7) / 0.7)

  const entropyScore = sentenceEntropy(lengths)
  const burstScore = burstiness(std, mean)

  // 突发性: 0.3-0.7 自然, 极端值 (接近 0 或 1) 是信号
  const burstNatural = 1 - Math.abs(burstScore - 0.5) / 0.5
  // 句首多样性: >0.6 自然
  const openerScore = Math.min(1, openerDiversity / 0.6)
  // 高频词: <0.15 自然 (中文常用字"的/了/他"占比高也正常, 上限放宽到 0.2)
  const repScore = topWordRepetition < 0.2 ? 1 : Math.max(0, 1 - (topWordRepetition - 0.2) / 0.2)

  const score = Math.max(
    0,
    Math.min(
      1,
      0.35 * cvScore + 0.2 * entropyScore + 0.15 * burstNatural + 0.15 * openerScore + 0.15 * repScore,
    ),
  )

  return {
    sentence: {
      mean,
      std,
      cv,
      p25: percentile(sorted, 25),
      p75: percentile(sorted, 75),
      entropy: entropyScore,
    },
    burstiness: burstScore,
    openerDiversity: openerDiversity,
    topWordRepetition: topWordRepetition,
    score,
  }
}

/** band 划分 */
export function fingerprintBand(score: number): FingerprintBand {
  if (score < 0.35) return "unnatural"
  if (score < 0.6) return "borderline"
  return "natural"
}

/** 文本化指纹报告 (供 LLM prompt / 审计) */
export function fingerprintToText(r: FingerprintResult): string {
  return [
    `统计指纹 (Track B soft): score=${r.score.toFixed(2)} band=${fingerprintBand(r.score)}`,
    `- 句长: mean=${r.sentence.mean.toFixed(1)} std=${r.sentence.std.toFixed(1)} CV=${r.sentence.cv.toFixed(2)} p25=${r.sentence.p25} p75=${r.sentence.p75} 熵=${r.sentence.entropy.toFixed(2)}`,
    `- 突发性=${r.burstiness.toFixed(2)} 句首多样性=${r.openerDiversity.toFixed(2)} 高频词重复=${r.topWordRepetition.toFixed(3)}`,
  ].join("\n")
}

/** 改写前后指纹对比 (delta) — humanizer-x Pass4 自检思路 */
export function fingerprintDelta(
  before: FingerprintResult,
  after: FingerprintResult,
): { scoreDelta: number; improved: boolean; summary: string } {
  const scoreDelta = after.score - before.score
  return {
    scoreDelta: Math.round(scoreDelta * 100) / 100,
    improved: scoreDelta > 0,
    summary: scoreDelta > 0
      ? `改写后指纹自然化 +${(scoreDelta * 100).toFixed(0)}` 
      : `改写后指纹自然化 ${(scoreDelta * 100).toFixed(0)} (未改善 or 过度改写)`,
  }
}
