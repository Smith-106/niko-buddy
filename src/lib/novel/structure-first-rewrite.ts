/**
 * Structure-first rewrite helpers — inject ChapterStructurePlan into residual
 * rewrite / task-brief text without orphaning the plan (scene-breakdown failure mode).
 *
 * Pure helpers. Default deep-chapter orchestration remains fail-open (Track A).
 */

import {
  buildStructurePlanPromptBlock,
  type ChapterStructurePlan,
  validateChapterStructurePlan,
} from "./chapter-structure-plan"
import type { ResidualRewritePolicyDecision } from "./residual-rewrite-policy"
import {
  L9_OVERALL_STRETCH_MEDIAN,
  L9_OVERALL_TEST_CONTROL_MEDIAN,
} from "./literary-experiment-protocol"

/**
 * Append validated structure plan block to an existing task brief.
 * Returns original brief unchanged when plan invalid/null.
 */
export function appendStructurePlanToTaskBrief(
  taskBrief: string,
  plan: ChapterStructurePlan | null | undefined,
): string {
  const base = (taskBrief ?? "").trimEnd()
  if (!plan) return taskBrief ?? ""
  const v = validateChapterStructurePlan(plan)
  if (!v.ok) return taskBrief ?? ""
  const block = buildStructurePlanPromptBlock(plan)
  if (!block.trim()) return taskBrief ?? ""
  if (!base) return block
  return `${base}\n\n${block}`
}

/**
 * Constraint block for residual rewrite prompts when policy has decided.
 */
export function buildStructureFirstRewriteConstraint(
  plan: ChapterStructurePlan | null | undefined,
  residualDecision: ResidualRewritePolicyDecision | null | undefined,
): string {
  const lines: string[] = [
    "",
    "【Structure-first 改写约束】",
    "- 主杠杆：structure thril-pacing 全章结构改写（开篇压迫→能动转折→章末钩）。",
    "- 禁止将 densify-only / short-compress / 纯 micro-thril 作为 residual 高分章主杠杆。",
    `- overall≥${L9_OVERALL_STRETCH_MEDIAN} 是书稿里程碑 stretch（结案/L9 宣称），不是 Track A 产品硬门（productHardGate=false）。`,
    `- 改写测试控制线 overall≥${L9_OVERALL_TEST_CONTROL_MEDIAN}：为稳定保住 ≥${L9_OVERALL_STRETCH_MEDIAN}，KEEP/抛光循环以 ${L9_OVERALL_TEST_CONTROL_MEDIAN} 为控制目标；结案宣称仍认 truepack N≥5 overall≥${L9_OVERALL_STRETCH_MEDIAN}。`,
  ]

  if (residualDecision) {
    lines.push(
      `- 策略判定：accept=${residualDecision.accept} band=${residualDecision.residualBand} mode=${residualDecision.mode}`,
    )
    lines.push(`- 原因：${residualDecision.reason}`)
    if (residualDecision.requiredMode) {
      lines.push(`- 要求模式：${residualDecision.requiredMode}`)
    }
    lines.push(`- productHardGate=${residualDecision.productHardGate}`)
  }

  if (plan && validateChapterStructurePlan(plan).ok) {
    lines.push(buildStructurePlanPromptBlock(plan))
  } else {
    lines.push(
      "- （无有效 ChapterStructurePlan：先补 plan 再写；勿 densify 硬堆）",
    )
  }

  return lines.join("\n")
}

/**
 * True when brief already contains a structure plan injection marker.
 */
export function taskBriefHasStructurePlan(taskBrief: string): boolean {
  return /【ChapterStructurePlan/u.test(taskBrief ?? "")
}
