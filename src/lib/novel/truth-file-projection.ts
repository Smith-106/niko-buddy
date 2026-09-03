/**
 * 48号报告 §六-⑤ runtime→人可读 truth-file 投影.
 *
 * 仲裁结论（B-ds vs B-glm 综合）：
 * - 取 B-ds 的「投影非真源」定位：投影只读来源派生，不写回 status.json（无回环）
 * - 取 B-glm 的「闭环补齐」语义：审查 agent 与人类共读的人可直读层
 * - 诊断标记（对齐 inkos state-projections.ts）：stale（已被取代）、blocked（冲突待收敛）
 *
 * 纯函数、确定性（同输入→同输出字节全等）、零 IO/LLM。调用方负责落盘与 ledger 记录。
 */

import type { TruthEntry } from "./truth-authority"
import { detectTruthConflicts, AUTHORITY_WEIGHT, type AuthorityLevel } from "./truth-authority"
import type { StateDelta } from "./state-delta-light-check"
import { deriveHookOps, type HookOp } from "./state-delta-light-check"

/** 投影诊断标记（对齐 inkos stale/blocked 语义）。 */
export type TruthProjectionMarker = "active" | "stale" | "blocked"

export interface TruthFileProjectionInput {
  /** 派生自 snapshot 的 TruthEntry[]（经 deriveTruthEntries）。 */
  truthEntries: TruthEntry[]
  /** 最近一章的 StateDelta（可选，用于 hookOps 投影）。 */
  stateDelta?: StateDelta | null
  /** 项目名（标题用）。 */
  projectName?: string
}

/**
 * 渲染人可读 truth-file markdown（纯函数）.
 * 结构：
 * # {projectName} 真值投影
 * ## 正典事实（按权威等级分组）
 *   - [active/stale/blocked] entryId: statement (level, revision)
 * ## 待收敛冲突（若有）
 * ## 状态增量操作（最近一章 hookOps，若有）
 *
 * 确定性：按 entryId 稳定排序，同输入→同输出字节全等（供 golden snapshot 比对）。
 */
export function renderTruthFileProjection(input: TruthFileProjectionInput): string {
  const { truthEntries, stateDelta, projectName } = input
  const lines: string[] = []
  lines.push(`# ${projectName ?? "项目"} 真值投影`)
  lines.push("")
  lines.push("> 自动投影（非真源）。事实内容以 Truth Files / status.json 为准。")
  lines.push("")

  // 冲突检测（诊断标记来源）
  const conflicts = detectTruthConflicts(truthEntries)
  const blockedSubjects = new Set(conflicts.filter((c) => c.severity === "error").map((c) => c.subject))

  // 按 authority level 分组（canon→superseded 降序），组内按 entryId 稳定排序
  const byLevel = new Map<AuthorityLevel, TruthEntry[]>()
  for (const e of truthEntries) {
    const list = byLevel.get(e.level) ?? []
    list.push(e)
    byLevel.set(e.level, list)
  }
  const levelOrder = (Object.keys(AUTHORITY_WEIGHT) as AuthorityLevel[])
    .sort((a, b) => AUTHORITY_WEIGHT[b] - AUTHORITY_WEIGHT[a])

  const hasAnyEntry = truthEntries.length > 0
  if (hasAnyEntry) {
    lines.push("## 事实条目")
    lines.push("")
    for (const level of levelOrder) {
      const entries = (byLevel.get(level) ?? []).sort((a, b) => a.entryId.localeCompare(b.entryId))
      if (entries.length === 0) continue
      lines.push(`### ${levelLabel(level)} (${entries.length})`)
      lines.push("")
      for (const e of entries) {
        const marker = deriveMarker(e, blockedSubjects)
        const markerTag = marker === "active" ? "" : ` [${markerLabel(marker)}]`
        const revTag = e.revision > 0 ? ` r${e.revision}` : ""
        lines.push(`- ${e.entryId}${markerTag}: ${e.statement} (${e.subject}${revTag})`)
      }
      lines.push("")
    }
  } else {
    lines.push("## 事实条目")
    lines.push("")
    lines.push("（暂无）")
    lines.push("")
  }

  // 冲突投影
  if (conflicts.length > 0) {
    lines.push("## 待收敛冲突")
    lines.push("")
    for (const c of conflicts) {
      const icon = c.severity === "error" ? "[blocked]" : "[warn]"
      lines.push(`- ${icon} ${c.message}`)
    }
    lines.push("")
  }

  // hookOps 投影
  if (stateDelta) {
    const ops = deriveHookOps(stateDelta)
    if (ops.length > 0) {
      lines.push(`## 状态增量操作（第 ${stateDelta.chapter} 章）`)
      lines.push("")
      for (const op of ops) {
        lines.push(`- ${op.op}: ${op.entity} — ${op.detail}`)
      }
      lines.push("")
    }
  }

  return lines.join("\n")
}

function deriveMarker(entry: TruthEntry, blockedSubjects: Set<string>): TruthProjectionMarker {
  if (entry.level === "superseded") return "stale"
  if (blockedSubjects.has(entry.subject)) return "blocked"
  return "active"
}

function markerLabel(m: TruthProjectionMarker): string {
  return m // active/stale/blocked 直接用
}

function levelLabel(level: AuthorityLevel): string {
  const labels: Record<AuthorityLevel, string> = {
    canon: "正典",
    established: "已确立",
    draft: "草稿",
    hypothesis: "推测",
    superseded: "已取代",
  }
  return labels[level]
}

/**
 * 投影幂等性验证（纯函数，供 spec golden snapshot 比对）.
 * 同输入两次投影输出字节全等 → true。
 */
export function isProjectionIdempotent(input: TruthFileProjectionInput): boolean {
  return renderTruthFileProjection(input) === renderTruthFileProjection(input)
}

/** 导出 HookOp 供消费方引用（透传 state-delta-light-check）。 */
export type { HookOp }
