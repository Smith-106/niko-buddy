/**
 * aura-homogenization.ts — 波2-C：角色库同质化量化告警 + 声音漂移按章统计。
 *
 * 共识计划（hub `.workflow/tmp/consensus-plan-v1.md` 波2 + 模块 16 深化）：
 *   - GLM P2 缺口「character-homogenization」：角色库同质化量化告警与声音漂移
 *     检测缺失——验收：同质化指标超阈值产生结构化告警事件并可追溯来源角色对；
 *   - DS P1 缺口「角色库同质化量化」：相似度超阈值产出告警事件与可点开证据，
 *     声音漂移按章统计入账本。
 *
 * 机械口径（ADR-19 零模型调用，确定性可测）：
 *   - 同质化相似度 = 角色 auraSeeds 文本的字符 2-gram shingle 集 Jaccard；
 *     ≥ 阈值（缺省 0.5）的**角色对** → 结构化告警（来源角色对可追溯，
 *     evidenceRefs = 双方 entryId）；
 *   - 声音漂移 = 各章 voiceSeeds 相对基线 seeds 的 Jaccard 距离
 *     （drift = 1 - similarity），按章升序统计 + 超阈值章标记告警事件；
 *   - 告警事件 kind=stage（过程告警非运行错误），payload.alert 显式标记。
 *
 * 机械层：纯函数，零 IO / 零时钟 / 零模型调用；事件对象只产出输入形态。
 *
 * @license MIT © Niko Buddy
 */

import type { CharacterArchetypeEntry } from "./asset-library"
import type { RunEventAppendInput } from "./run-event-ledger-store"

// ============================================================================
// 相似度（字符 2-gram shingle Jaccard；确定性）
// ============================================================================

/** 文本 → 字符 2-gram shingle 集（单字符文本降级为自身）。 */
function shingles(text: string): Set<string> {
  const set = new Set<string>()
  for (let i = 0; i < text.length - 1; i += 1) {
    set.add(text.slice(i, i + 2))
  }
  if (text.length === 1) set.add(text)
  return set
}

/** 种子文本并集 shingle 集。 */
function unionShingles(seeds: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const seed of seeds) {
    for (const sh of shingles(seed)) out.add(sh)
  }
  return out
}

/** 种子文本并集 shingle 集（跨模块公共别名；同质化/VIS-CONT 共用机械口径）。 */
export function unionShinglesFromTexts(seeds: readonly string[]): Set<string> {
  return unionShingles(seeds)
}

/** Jaccard 相似度（任一空集 → null：无从比较，不臆造 0）。 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number | null {
  if (a.size === 0 || b.size === 0) return null
  let inter = 0
  for (const item of a) if (b.has(item)) inter += 1
  return inter / (a.size + b.size - inter)
}

// ============================================================================
// 同质化告警（角色对级）
// ============================================================================

/** 同质化告警（来源角色对可追溯）。 */
export interface HomogenizationAlert {
  readonly entryIdA: string
  readonly entryIdB: string
  /** aura 种子 shingle Jaccard 相似度（0..1）。 */
  readonly similarity: number
  readonly threshold: number
  /** 双方完全相同的种子文本（血缘重叠实锤，可为空——shingle 级同质也告警）。 */
  readonly sharedSeeds: readonly string[]
}

/**
 * 同质化量化检测（纯函数）：两两比较 auraSeeds，相似度 ≥ threshold 的角色对
 * 按相似度降序 + entryId 字典序稳定排序。任一方无种子 → 跳过该对（无从比较）。
 */
export function detectAuraHomogenization(
  entries: readonly CharacterArchetypeEntry[],
  threshold = 0.5,
): readonly HomogenizationAlert[] {
  if (threshold < 0 || threshold > 1) {
    throw new AuraHomogenizationError(`threshold 越界 [0,1]: ${threshold}`)
  }
  const alerts: HomogenizationAlert[] = []
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i] as CharacterArchetypeEntry
      const b = entries[j] as CharacterArchetypeEntry
      const aSeeds = a.auraSeeds ?? []
      const bSeeds = b.auraSeeds ?? []
      if (aSeeds.length === 0 || bSeeds.length === 0) continue
      const similarity = jaccardSimilarity(unionShingles(aSeeds), unionShingles(bSeeds))
      if (similarity === null || similarity < threshold) continue
      const aSet = new Set(aSeeds)
      alerts.push({
        entryIdA: a.entryId,
        entryIdB: b.entryId,
        similarity,
        threshold,
        sharedSeeds: bSeeds.filter((seed) => aSet.has(seed)),
      })
    }
  }
  return alerts.sort((x, y) =>
    x.similarity !== y.similarity ? y.similarity - x.similarity : x.entryIdA < y.entryIdA ? -1 : 1,
  )
}

/** 同质化告警事件输入（kind=stage，payload.alert 显式标记）。 */
export function homogenizationAlertEvents(input: {
  readonly alerts: readonly HomogenizationAlert[]
  readonly ts: string
}): RunEventAppendInput[] {
  if (input.ts.length === 0) throw new AuraHomogenizationError("ts 为空：事件落账前必须注入时间戳（零时钟纪律）")
  if (input.alerts.length === 0) return []
  return [
    {
      ts: input.ts,
      kind: "stage" as const,
      actor: "system" as const,
      evidenceRefs: input.alerts.flatMap((alert) => [`aura:${alert.entryIdA}`, `aura:${alert.entryIdB}`]),
      payload: {
        alert: "aura-homogenization",
        threshold: input.alerts[0]?.threshold ?? null,
        pairs: input.alerts.map((alert) => ({
          entryIdA: alert.entryIdA,
          entryIdB: alert.entryIdB,
          similarity: alert.similarity,
          sharedSeeds: alert.sharedSeeds,
        })),
      },
    },
  ]
}

// ============================================================================
// 声音漂移（按章统计）
// ============================================================================

/** 单章声音样本（章级 voice 种子）。 */
export interface ChapterVoiceSample {
  readonly chapterId: number
  /** 本章声音种子（voiceProfile 锚文本）。 */
  readonly voiceSeeds: readonly string[]
}

/** 单章漂移统计。 */
export interface ChapterVoiceDrift {
  readonly chapterId: number
  /** 与基线的 shingle Jaccard 相似度（0..1；样本空 → null 不臆造）。 */
  readonly similarity: number | null
  /** drift = 1 - similarity（相似度 null → null）。 */
  readonly drift: number | null
  /** drift ≥ 阈值 → 告警章。 */
  readonly alert: boolean
}

/**
 * 声音漂移按章统计（纯函数）：各章 voiceSeeds vs 基线 seeds 的 Jaccard；
 * 输出按 chapterId 升序（确定性）；drift ≥ threshold（缺省 0.6）标记告警。
 */
export function computeVoiceDrift(
  samples: readonly ChapterVoiceSample[],
  baselineSeeds: readonly string[],
  threshold = 0.6,
): readonly ChapterVoiceDrift[] {
  if (threshold < 0 || threshold > 1) {
    throw new AuraHomogenizationError(`threshold 越界 [0,1]: ${threshold}`)
  }
  const baseline = unionShingles(baselineSeeds)
  return [...samples]
    .sort((a, b) => a.chapterId - b.chapterId)
    .map((sample) => {
      const similarity = jaccardSimilarity(unionShingles(sample.voiceSeeds), baseline)
      const drift = similarity === null ? null : 1 - similarity
      return { chapterId: sample.chapterId, similarity, drift, alert: drift !== null && drift >= threshold }
    })
}

/** 声音漂移告警事件输入（每告警章一条，payload.alert=voice-drift）。 */
export function voiceDriftAlertEvents(input: {
  readonly series: readonly ChapterVoiceDrift[]
  readonly ts: string
  readonly bookId?: string
}): RunEventAppendInput[] {
  if (input.ts.length === 0) throw new AuraHomogenizationError("ts 为空：事件落账前必须注入时间戳（零时钟纪律）")
  return input.series
    .filter((chapter) => chapter.alert)
    .map((chapter) => ({
      ts: input.ts,
      kind: "stage" as const,
      actor: "system" as const,
      bookId: input.bookId,
      chapterId: chapter.chapterId,
      evidenceRefs: [`voice-drift:ch${chapter.chapterId}`],
      payload: {
        alert: "voice-drift",
        chapterId: chapter.chapterId,
        drift: chapter.drift,
        similarity: chapter.similarity,
      },
    }))
}

/** aura-homogenization 错误。 */
export class AuraHomogenizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AuraHomogenizationError"
  }
}