/**
 * trend-radar.ts — 波3-A：热门题材雷达（RadarSignal → kb 产物，出处强制）。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 波3 + 模块 3 深化）：
 *   - GLM P2 缺口「radar」：热门题材雷达 RadarSignal→kb 产物缺失——验收：
 *     RadarSignal 仅经生成器产出只读 kb 产物且每条信号强制携带可验证出处；
 *   - 雷达信号是**参考情报**不是真源：禁第二真源原则下，信号仅可经生成器
 *     出口固化为只读产物（deepFreeze + contentHash），手工编辑被守恒校验检出。
 *
 * 机械口径：
 *   - 每条 RadarSignal 强制 sourceRef（可验证出处，schema min(1) + 构建端
 *     fail-loud 复核）；无出处的信号在构建出口即拒绝（不静默入库）；
 *   - 产物构建：schema 校验 + signalId 去重 + 按热度降序稳定排序 +
 *     确定性 contentHash（stableStringify + FNV-1a，与 asset-library 同法）；
 *   - probeTrendRadarHealth：对已加载产物复核出处/重复/守恒（外部写入的
 *     产物同样受检——产物不是真源）。
 *
 * 机械层（ADR-19）：纯函数 + zod，零 IO / 零时钟（generatedAt 注入）/
 * 零模型调用。
 *
 * @license MIT © QMAI
 */

import { z } from "zod"
import { computeLibraryHash, stableStringify } from "./asset-library"

// ============================================================================
// 契约
// ============================================================================

/** RadarSignal 契约（strict；sourceRef 出处强制）。 */
export const RADAR_SIGNAL_SCHEMA = z
  .object({
    signalId: z.string().min(1).max(128),
    topic: z.string().min(1).max(128),
    /** 热度 0..100（机械标量，来源在 sourceRef）。 */
    heat: z.number().min(0).max(100),
    /** 可验证出处（强制非空：榜单/平台/检索证据引用）。 */
    sourceRef: z.string().min(1).max(512),
  })
  .strict()

export type RadarSignal = z.infer<typeof RADAR_SIGNAL_SCHEMA>

export const TREND_RADAR_ARTIFACT_SCHEMA_VERSION = 1 as const

/** 雷达产物（生成器出口只读；deepFreeze）。 */
export interface TrendRadarArtifact {
  readonly schemaVersion: typeof TREND_RADAR_ARTIFACT_SCHEMA_VERSION
  readonly generatorVersion: string
  readonly generatedAt: string
  /** 按热度降序 + signalId 字典序稳定排序。 */
  readonly signals: readonly RadarSignal[]
  /** 由 signals 确定性重建（篡改即失配）。 */
  readonly contentHash: string
}

/** 雷达健康探针结果。 */
export interface TrendRadarHealth {
  readonly totalSignals: number
  /** 出处为空的信号 id（violation；构建端已 fail-loud，此处兜底复核外部产物）。 */
  readonly missingProvenance: readonly string[]
  /** 重复 signalId（同一产物内）。 */
  readonly duplicates: readonly string[]
  /** 守恒校验（contentHash 重建失配 = 手工编辑被检出）。 */
  readonly conserved: boolean
  readonly status: "ok" | "violation"
}

/** 雷达构建错误。 */
export class TrendRadarError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TrendRadarError"
  }
}

// ============================================================================
// 生成器出口
// ============================================================================

/**
 * 构建雷达产物（生成器出口，唯一固化通道）：
 *   - 每条信号 schema 校验 + sourceRef 复核（空出处 fail-loud）；
 *   - signalId 全局唯一（重复 fail-loud）；
 *   - 排序确定性（heat 降序 → signalId 字典序）+ 深度冻结 + contentHash。
 */
export function buildTrendRadarArtifact(input: {
  readonly generatorVersion: string
  readonly generatedAt: string
  readonly signals: readonly RadarSignal[]
}): TrendRadarArtifact {
  if (input.generatorVersion.length === 0) throw new TrendRadarError("generatorVersion 为空")
  if (input.generatedAt.length === 0) throw new TrendRadarError("generatedAt 为空（零时钟纪律：由调用方注入）")
  const parsed = input.signals.map((signal) => RADAR_SIGNAL_SCHEMA.parse(signal))
  const seen = new Set<string>()
  for (const signal of parsed) {
    if (signal.sourceRef.trim().length === 0) {
      throw new TrendRadarError(`信号 ${signal.signalId} 出处为空：出处强制（每条信号必须携带可验证 sourceRef）`)
    }
    if (seen.has(signal.signalId)) {
      throw new TrendRadarError(`信号 id 重复: ${signal.signalId}`)
    }
    seen.add(signal.signalId)
  }
  const signals = [...parsed]
    .sort((a, b) => (a.heat !== b.heat ? b.heat - a.heat : a.signalId < b.signalId ? -1 : 1))
    .map((signal) => Object.freeze({ ...signal }))
  const contentHash = computeLibraryHash(`trend-radar:${stableStringify(signals)}`)
  return Object.freeze({
    schemaVersion: TREND_RADAR_ARTIFACT_SCHEMA_VERSION,
    generatorVersion: input.generatorVersion,
    generatedAt: input.generatedAt,
    signals,
    contentHash,
  })
}

/** 守恒复核（与 asset-library 同法：由 signals 确定性重建 hash）。 */
export function verifyTrendRadarConservation(artifact: TrendRadarArtifact): { conserved: boolean; expectedHash: string; actualHash: string } {
  const expected = computeLibraryHash(`trend-radar:${stableStringify(artifact.signals)}`)
  return { conserved: expected === artifact.contentHash, expectedHash: expected, actualHash: artifact.contentHash }
}

/**
 * 健康探针（对产物复核：出处强制 / id 唯一 / 守恒）——外部写入的 kb 产物
 * 同样受检（产物不是真源）。
 */
export function probeTrendRadarHealth(artifact: TrendRadarArtifact): TrendRadarHealth {
  const missingProvenance = artifact.signals.filter((s) => s.sourceRef.trim().length === 0).map((s) => s.signalId)
  const counts = new Map<string, number>()
  for (const signal of artifact.signals) counts.set(signal.signalId, (counts.get(signal.signalId) ?? 0) + 1)
  const duplicates = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id)
  const conserved = verifyTrendRadarConservation(artifact).conserved
  const status = missingProvenance.length === 0 && duplicates.length === 0 && conserved ? "ok" : "violation"
  return { totalSignals: artifact.signals.length, missingProvenance, duplicates, conserved, status }
}