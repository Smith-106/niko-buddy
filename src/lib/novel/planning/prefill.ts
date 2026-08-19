/**
 * Wave 3 计划模式 — task-brief 预填层。
 *
 * 镜像 structure-plan 先例（appendStructurePlanToTaskBrief）：
 * fail-open（null → 原样返回）+ marker 防重复 + append-only（绝不重写既有字段）。
 * 逐节合并会扰动 countTaskBriefStructureHits 机械门控 — 从机制上排除。
 */

import type { ChapterPlanView } from "./types"

/** 预填块 marker（防重复注入） */
export const PLANNING_BLOCK_MARKER = "【本章确定性范围】"

/** 预填块字符上限 */
export const PLANNING_BLOCK_CAP = 1200

/**
 * 渲染【本章确定性范围】块（纯机械，零 LLM）。
 * 超限带「（已截断）」标记。
 */
export function buildPlanningPrefillBlock(plan: ChapterPlanView): string {
  const lines: string[] = []
  lines.push(`${PLANNING_BLOCK_MARKER}（计划模式预填）`)

  // 伏笔债务
  const fs = plan.foreshadowing
  if (fs.status === "degraded") {
    lines.push("- 伏笔债务：数据源不可用")
  } else if (fs.report) {
    const critical = fs.report.items.filter((i) => i.debtLevel === "critical")
    const warning = fs.report.items.filter((i) => i.debtLevel === "warning")
    lines.push(`- 伏笔债务：debtScore=${fs.report.debtScore}；critical ${critical.length} / warning ${warning.length} / 未回收 ${fs.report.items.length}`)
    for (const item of critical.slice(0, 3)) {
      lines.push(`  - [critical] ${item.name}（第${item.plantedChapter}章植入，已 ${item.chaptersSincePlanted} 章未推进）`)
    }
    for (const item of warning.slice(0, 3)) {
      lines.push(`  - [warning] ${item.name}（第${item.plantedChapter}章植入，已 ${item.chaptersSincePlanted} 章未推进）`)
    }
  }

  // 角色出场
  const chars = plan.characters
  if (chars.status === "degraded") {
    lines.push("- 角色出场：数据源不可用")
  } else {
    const due = chars.items.filter((c) => !c.inCurrentOutline && c.chaptersSinceSeen !== undefined && c.chaptersSinceSeen >= 10)
    lines.push(`- 角色出场：本章大纲命中 ${chars.items.filter((c) => c.inCurrentOutline).length} 人`)
    for (const c of chars.items.filter((i) => i.inCurrentOutline).slice(0, 4)) {
      lines.push(`  - ${c.name}（上次出场第${c.lastSeenChapter ?? "?"}章${c.status ? `，状态：${c.status}` : ""}${c.isAlive === false ? "，已退场" : ""}）`)
    }
    if (due.length > 0) {
      lines.push(`  - 逾期未出场：${due.map((c) => `${c.name}（上次第${c.lastSeenChapter}章，已 ${c.chaptersSinceSeen} 章未出场）`).join("；")}`)
    }
  }

  // 支线推进
  const threads = plan.threads
  if (threads.status === "degraded") {
    lines.push("- 支线推进：数据源不可用")
  } else {
    lines.push(`- 支线推进：开放 ${threads.openCount} 条`)
    for (const t of threads.items.filter((i) => i.arcState === "Falling" || i.arcState === "Climax" || i.arcState === "Rising").slice(0, 4)) {
      const violation = t.transitionViolation ? `（${t.transitionViolation}）` : ""
      lines.push(`  - [${t.arcState}] ${t.title}${violation}`)
    }
  }

  const block = lines.join("\n")
  if (block.length > PLANNING_BLOCK_CAP) {
    return `${block.slice(0, PLANNING_BLOCK_CAP)}（已截断）`
  }
  return block
}

/**
 * 追加预填块到 task-brief（fail-open：plan 为 null/undefined → 原样返回）。
 * append-only：base 原样保留，块追加在末尾。
 */
export function appendPlanningBlockToTaskBrief(
  taskBrief: string,
  plan: ChapterPlanView | null | undefined,
): string {
  if (!plan) return taskBrief
  const block = buildPlanningPrefillBlock(plan)
  if (!taskBrief) return block
  return `${taskBrief}\n\n${block}`
}

/** marker 防重复注入（镜像 taskBriefHasStructurePlan） */
export function taskBriefHasPlanningBlock(taskBrief: string): boolean {
  return taskBrief.includes(PLANNING_BLOCK_MARKER)
}
