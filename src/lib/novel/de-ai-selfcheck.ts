/**
 * de-ai-selfcheck.ts — P1-3 去 AI 改写 4-pass 自检 (零 LLM 打分层)
 *
 * 共识 (V3-ds/hy3 4-pass-pipeline + selfcheck-scoring 7 维 / V2 统计指纹):
 * humanizer-x Pass4 (8-point 自检) + ultimate-humanizer 5D 映射到 QMAI,
 * 但保持 ADR-19: 打分全机械, LLM 只做改写本身。
 *
 * 管道重排 (与现有 de-ai-batch scheduler 接线):
 *   P1 机械分级清扫 (mechanical-slop-detector + cavity patterns)
 *   P2 LLM 改写 (adapter + preserve-lock 遮蔽 + dual-pass 片段 + cavity guard)
 *   P3 preserve-lock 还原 (restore + verify 缺失报告)
 *   P4 自检 (本模块 7 维评分 + 统计指纹 before/after delta)
 *
 * 输出 PASS/REVIEW (Track B soft, 非产品硬门 — signalDisclosure 立场)。
 */

import { statisticalFingerprint, fingerprintDelta, type FingerprintResult } from "./mechanical-fingerprint"
import { slopScore, type SlopReport } from "./mechanical-slop-detector"

/** 7 维自检维度 */
export type SelfCheckDimension =
  | "词汇"     // slop 词残留
  | "句式"     // 句长多样性 CV / 熵
  | "对白"     // 对话标签多样性
  | "叙事"     // 转场/总结腔
  | "心理"     // 情绪概括
  | "场景"     // 模板场景
  | "节奏"     // 段落长度分布

/** 单维结果 */
export interface SelfCheckDimResult {
  dimension: SelfCheckDimension
  /** 0-1 该维干净度 (越高越自然) */
  score: number
  /** 简评 */
  note: string
}

/** 自检结果 */
export interface SelfCheckResult {
  dimensions: SelfCheckDimResult[]
  /** 综合分 0-1 */
  overall: number
  verdict: "PASS" | "REVIEW"
  /** 指纹 before/after delta */
  fingerprintDelta: { scoreDelta: number; improved: boolean }
  /** Track B soft — 非产品硬门 */
  productHardGate: false
  /** 简评 */
  summary: string
}

/** 7 维默认权重 (和为 1) */
export const SELFCHECK_WEIGHTS: Record<SelfCheckDimension, number> = {
  "词汇": 0.2,
  "句式": 0.2,
  "对白": 0.1,
  "叙事": 0.15,
  "心理": 0.15,
  "场景": 0.1,
  "节奏": 0.1,
}

/** PASS 阈值 (综合分 >= 此值 PASS)。
 *  35 号 DD-3 标定 S8: 0.6→0.7（实测 human P5=0.92 空档 0.22 → 上调零误杀且
 *  ai REVIEW 5/30→13/30 判别力翻倍；Track B soft，productHardGate:false 不变）。 */
export const SELFCHECK_PASS_THRESHOLD = 0.7

/** 句式维: 基于指纹子项 */
function scoreSyntax(r: FingerprintResult): number {
  // CV 在 0.2-0.5 自然; 熵高自然
  const cvScore = r.sentence.cv >= 0.15 && r.sentence.cv <= 0.55 ? 1
    : r.sentence.cv < 0.15 ? r.sentence.cv / 0.15
    : Math.max(0, 1 - Math.abs(r.sentence.cv - 0.55) / 0.3)
  return Math.min(1, 0.6 * cvScore + 0.4 * r.sentence.entropy)
}

/** 节奏维: 段落长度分布 (段落 CV) */
function scoreRhythm(rawText: string): number {
  const paragraphs = rawText.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 0)
  if (paragraphs.length < 3) return 0.7 // 短文本不确定, 给中性分
  const lens = paragraphs.map((p) => p.length)
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length
  if (mean === 0) return 0.5
  const variance = lens.reduce((s, l) => s + (l - mean) ** 2, 0) / lens.length
  const cv = Math.sqrt(variance) / mean
  // 段落 CV 0.3-0.9 自然
  return cv >= 0.3 && cv <= 0.9 ? 1 : cv < 0.3 ? cv / 0.3 : Math.max(0, 1 - (cv - 0.9) / 0.8)
}

/** 对白维: 对话标签多样性 */
function scoreDialogue(rawText: string): number {
  const labels = rawText.match(/[」”"']?[^。\n]{0,12}[：:][^。\n]{0,30}[」”"']/g) ?? []
  if (labels.length === 0) return 0.8 // 无对白不罚
  const unique = new Set(labels.map((l) => l.slice(-8, -4)))
  return unique.size / labels.length >= 0.4 ? 1 : Math.max(0, unique.size / labels.length / 0.4)
}

/** 词汇维: slop penalty 映射 */
function scoreVocabulary(slop: SlopReport): number {
  return Math.max(0, 1 - slop.slopPenalty / 8)
}

/** 叙事/心理/场景: 用 TIER1/2/3 命中加权近似 */
function scoreNarrative(slop: SlopReport): number {
  const t1 = slop.tier1Hits.reduce((s, h) => s + h.count, 0)
  return Math.max(0, 1 - t1 / 6)
}
function scorePsychology(slop: SlopReport): number {
  const t3 = slop.tier3Hits.reduce((s, h) => s + h.count, 0)
  return Math.max(0, 1 - t3 / 8)
}
function scoreScene(slop: SlopReport): number {
  const t2 = slop.tier2Hits.reduce((s, h) => s + h.count, 0)
  return Math.max(0, 1 - t2 / 8)
}

/**
 * 4-pass 自检入口 (P4): 对改写后文本打分 + 指纹 delta。
 * 调用方 (scheduler) 传入改写前指纹 before 用于 delta 对比。
 */
export function runDeAiSelfCheck(
  originalText: string,
  rewrittenText: string,
): SelfCheckResult {
  const fpBefore = statisticalFingerprint(originalText)
  const fpAfter = statisticalFingerprint(rewrittenText)
  const slop = slopScore(rewrittenText)

  const dims: SelfCheckDimResult[] = [
    { dimension: "词汇", score: scoreVocabulary(slop), note: `slopPenalty=${slop.slopPenalty.toFixed(1)}` },
    { dimension: "句式", score: scoreSyntax(fpAfter), note: `CV=${fpAfter.sentence.cv.toFixed(2)} θ=${fpAfter.sentence.entropy.toFixed(2)}` },
    { dimension: "对白", score: scoreDialogue(rewrittenText), note: `标签多样性` },
    { dimension: "叙事", score: scoreNarrative(slop), note: `tier1=${slop.tier1Hits.length}` },
    { dimension: "心理", score: scorePsychology(slop), note: `tier3=${slop.tier3Hits.length}` },
    { dimension: "场景", score: scoreScene(slop), note: `tier2=${slop.tier2Hits.length}` },
    { dimension: "节奏", score: scoreRhythm(rewrittenText), note: `段落CV` },
  ]

  const overall = dims.reduce((s, d) => s + d.score * SELFCHECK_WEIGHTS[d.dimension], 0)
  const delta = fingerprintDelta(fpBefore, fpAfter)

  return {
    dimensions: dims,
    overall: Math.round(overall * 100) / 100,
    verdict: overall >= SELFCHECK_PASS_THRESHOLD ? "PASS" : "REVIEW",
    fingerprintDelta: { scoreDelta: delta.scoreDelta, improved: delta.improved },
    productHardGate: false,
    summary: `selfcheck overall=${(overall * 100).toFixed(0)}/100 ${overall >= SELFCHECK_PASS_THRESHOLD ? "PASS" : "REVIEW"} fpDelta=${delta.scoreDelta > 0 ? "+" : ""}${delta.scoreDelta}`,
  }
}

/** 文本化自检报告 (供审计 / 人工审查) */
export function selfCheckToText(r: SelfCheckResult): string {
  const lines: string[] = [
    `去 AI 4-pass 自检 (Track B soft): ${r.verdict} overall=${r.overall.toFixed(2)}`,
    `指纹 delta: ${r.fingerprintDelta.scoreDelta > 0 ? "+" : ""}${r.fingerprintDelta.scoreDelta} (${r.fingerprintDelta.improved ? "improved" : "not improved"})`,
  ]
  for (const d of r.dimensions) {
    lines.push(`- ${d.dimension}: ${(d.score * 100).toFixed(0)} (${d.note})`)
  }
  return lines.join("\n")
}
