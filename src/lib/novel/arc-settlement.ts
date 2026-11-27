/**
 * arc-settlement.ts — G4 弧末结算编排契约层
 *
 * 背景: control-kernel routeNextArcStep 已有
 *   arc_review → summary → volume_summary → expand → new_volume
 * 事务顺序, campaign-runner 跨章循环尚未调用。本模块只沉淀编排契约
 * (触发判定 + 下一步推导), 不做任何 IO / 状态读写 / 模型调用,
 * 由后续 campaign-runner 接线消费。
 *
 * 机械层 (ADR-19): 纯函数, 零 IO / 零时钟 / 零模型调用。
 *
 * @license MIT © Niko Buddy
 */

import type { OutlineModel } from "./outline-model"
import type { VolumeMeta } from "./volume"

/** 弧末结算步骤 (G4 编排契约层命名, 顺序见 ARC_SETTLEMENT_ORDER)。 */
export type ArcSettlementStep =
  | "arc_review"
  | "summary"
  | "volume_summary"
  | "expand"
  | "new_volume"

/**
 * 弧末结算事务顺序 (与 control-kernel routeNextArcStep 同序)。
 * 只读常量, nextArcSettlementStep 按此顺序推导下一个未完成步骤。
 */
export const ARC_SETTLEMENT_ORDER: readonly ArcSettlementStep[] = [
  "arc_review",
  "summary",
  "volume_summary",
  "expand",
  "new_volume",
]

/** 弧边界解析来源（纯数据输入，零 IO / 零 LLM）。 */
export interface ArcBoundarySources {
  /** 结构化大纲模型（.novel/outline-model.json） */
  outlineModel?: OutlineModel | null
  /** 包含当前章的卷册元数据列表（来自 getChapterVolumes） */
  volumes?: readonly VolumeMeta[] | null
  /** 调用方显式指定的弧尾章号集合（1-based 正整数） */
  explicitArcEnds?: readonly number[] | null
}

function isPositiveChapter(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 1
}

/**
 * 为指定章号解析其所属弧/卷的弧尾章号 (纯函数，零 IO / 零时钟 / 零 LLM)。
 *
 * 优先级：
 * 1. `explicitArcEnds`：取大于等于 `chapterNumber` 的最小合法正整数（不重复触发已过去的历史弧尾）。
 * 2. `outlineModel`：若命中章且章节带非空 `arc` 标签，取同卷内该连续弧段的末章号；
 *    若命中章但无 `arc` 标签（或落在该卷起止章范围内），取该卷末章号。
 * 3. `volumes`：在包含 `chapterNumber` 且 `chapterRangeEnd >= chapterNumber` 的卷元数据中，
 *    取最小的 `chapterRangeEnd`。
 * 4. 以上均无有效边界时返回 `null`（永不臆造边界）。
 */
export function resolveArcEndChapterForChapter(
  chapterNumber: number,
  sources: ArcBoundarySources = {},
): number | null {
  if (!isPositiveChapter(chapterNumber)) return null

  // 1. 显式弧尾边界优先
  if (sources.explicitArcEnds && sources.explicitArcEnds.length > 0) {
    let nearestExplicit: number | null = null
    for (const candidate of sources.explicitArcEnds) {
      if (!isPositiveChapter(candidate) || candidate < chapterNumber) continue
      if (nearestExplicit === null || candidate < nearestExplicit) {
        nearestExplicit = candidate
      }
    }
    if (nearestExplicit !== null) return nearestExplicit
  }

  // 2. 结构化大纲模型（先匹配具体章的连续弧段，再退化到所属卷末章）
  const modelVolumes = sources.outlineModel?.volumes
  if (Array.isArray(modelVolumes) && modelVolumes.length > 0) {
    const sortedVolumes = modelVolumes.slice().sort((a, b) => a.number - b.number)
    let enclosingVolumeEnd: number | null = null

    for (const volume of sortedVolumes) {
      if (!Array.isArray(volume.chapters) || volume.chapters.length === 0) continue
      const chapters = volume.chapters
        .filter((ch) => isPositiveChapter(ch.chapter))
        .slice()
        .sort((a, b) => a.chapter - b.chapter)
      if (chapters.length === 0) continue

      const exactIdx = chapters.findIndex((ch) => ch.chapter === chapterNumber)
      if (exactIdx !== -1) {
        const currentArc = typeof chapters[exactIdx].arc === "string" ? chapters[exactIdx].arc.trim() : ""
        if (currentArc.length > 0) {
          let endIdx = exactIdx
          while (endIdx + 1 < chapters.length) {
            const nextArc = typeof chapters[endIdx + 1].arc === "string" ? chapters[endIdx + 1].arc.trim() : ""
            if (nextArc !== currentArc) break
            endIdx += 1
          }
          return chapters[endIdx].chapter
        }
        return chapters[chapters.length - 1].chapter
      }

      const minChapter = chapters[0].chapter
      const maxChapter = chapters[chapters.length - 1].chapter
      if (chapterNumber >= minChapter && chapterNumber <= maxChapter) {
        if (enclosingVolumeEnd === null || maxChapter < enclosingVolumeEnd) {
          enclosingVolumeEnd = maxChapter
        }
      }
    }

    if (enclosingVolumeEnd !== null) return enclosingVolumeEnd
  }

  // 3. 卷册元数据回退
  if (sources.volumes && sources.volumes.length > 0) {
    let nearestVolumeEnd: number | null = null
    for (const vol of sources.volumes) {
      if (!isPositiveChapter(vol.chapterRangeEnd)) continue
      if (vol.chapterRangeEnd < chapterNumber) continue
      if (vol.chapterRangeStart !== undefined) {
        if (!isPositiveChapter(vol.chapterRangeStart) || chapterNumber < vol.chapterRangeStart) {
          continue
        }
      }
      if (nearestVolumeEnd === null || vol.chapterRangeEnd < nearestVolumeEnd) {
        nearestVolumeEnd = vol.chapterRangeEnd
      }
    }
    if (nearestVolumeEnd !== null) return nearestVolumeEnd
  }

  return null
}

/**
 * 是否触发弧末结算 (纯函数)。
 * @param chapterNumber 当前章号 (1-based)
 * @param arcEndChapter 弧尾章号, null = 未知/无弧边界 → 永不触发
 * @returns chapterNumber >= arcEndChapter 时 true, 否则 false
 */
export function shouldTriggerArcSettlement(
  chapterNumber: number,
  arcEndChapter: number | null,
): boolean {
  if (arcEndChapter === null) return false
  return chapterNumber >= arcEndChapter
}

/**
 * 推导下一个未完成的结算步骤 (纯函数)。
 * 按 ARC_SETTLEMENT_ORDER 事务顺序返回第一个不在 done 中的步骤;
 * 全部完成返回 null。done 乱序/重复均不影响结果, 不突变入参。
 */
export function nextArcSettlementStep(
  done: readonly ArcSettlementStep[],
): ArcSettlementStep | null {
  const finished = new Set<ArcSettlementStep>(done)
  for (const step of ARC_SETTLEMENT_ORDER) {
    if (!finished.has(step)) return step
  }
  return null
}
