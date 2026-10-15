// MIT License
// Copyright (c) 2026 Niko Buddy
// SPDX-License-Identifier: MIT

/**
 * cruise-wiring.ts — H2-H3 接线层（G3 仲裁 × G4 结算 → 内核步骤名）。
 *
 * 背景：
 * - G3 契约 cruise-arbitration.ts（buildArbitrationRequest/applyArbitrationDirective）
 * - G4 编排 arc-settlement.ts（shouldTriggerArcSettlement/nextArcSettlementStep，
 *   步骤名 summary/expand）
 * - 内核 control-sentinels.ts ARC_TRANSITION_STEPS 用名 arc_summary/expand_arc
 *
 * 本模块只做纯函数接线，不碰 runner 主循环，不做 IO / 时钟 / 模型调用：
 * - ARBITRATION_TO_KERNEL_STEP + mapSettlementStepToKernel：G4 步骤名 → 内核步骤名
 * - decidePausedChapter：paused 章节的仲裁指令 → 下一跳三态（retry/skip/paused）
 */

import type { ArcSettlementStep } from "./arc-settlement"
import type {
  ArbitrationDirective,
  ArbitrationRequest,
} from "./cruise-arbitration"

/**
 * G4 结算步骤名 → 内核 ARC_TRANSITION_STEPS 步骤名。
 * summary → arc_summary，expand → expand_arc，其余直通。
 */
export const ARBITRATION_TO_KERNEL_STEP: Record<ArcSettlementStep, string> = {
  arc_review: "arc_review",
  summary: "arc_summary",
  volume_summary: "volume_summary",
  expand: "expand_arc",
  new_volume: "new_volume",
}

/**
 * 映射单个结算步骤到内核步骤名（纯函数）。
 */
export function mapSettlementStepToKernel(step: ArcSettlementStep): string {
  return ARBITRATION_TO_KERNEL_STEP[step]
}

/** paused 章节的下一跳决策。 */
export interface PausedChapterDecision {
  disposition: "retry" | "skip" | "paused"
  taskBrief?: string
}

/**
 * 决策 paused 章节的下一跳（纯函数）：
 * - directive 为 null → paused（等待人工）
 * - retry-rebrief → retry，并带回 revisedBrief
 * - skip-chapter → skip
 * - abort-campaign → paused
 *
 * @throws retry-rebrief 但 revisedBrief 缺失/空白时抛错——与 G3 契约一致。
 */
export function decidePausedChapter(
  request: ArbitrationRequest,
  directive: ArbitrationDirective | null,
): PausedChapterDecision {
  void request
  if (directive === null) {
    return { disposition: "paused" }
  }
  if (directive.action === "retry-rebrief") {
    const raw = directive.revisedBrief ?? ""
    if (raw.trim().length === 0) {
      throw new Error("retry-rebrief 缺少 revisedBrief")
    }
    return { disposition: "retry", taskBrief: raw }
  }
  if (directive.action === "skip-chapter") {
    return { disposition: "skip" }
  }
  return { disposition: "paused" }
}
