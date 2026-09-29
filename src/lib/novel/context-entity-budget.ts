// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT
//
// context-entity-budget.ts — F4 (Round-1 评估)：activeEntities tier 预算截断。
//
// 从 context-engine.ts（2978 行巨石）拆出的第一个纯函数子模块：
// `truncateActiveEntitiesByBudget` + `ContextEntity` 类型。零依赖 context-engine
//（只依赖 ContextGap/ContextBudget 类型），context-engine 经 re-export 保持
// 既有 import 面不变（context-engine.spec.ts 等 7 个 spec 不动）。
//
// 语义与原实现逐字一致：rank0（relevance:high / location:chapter-N）floor 全保；
// rank1/rank2 按 tier cap 配额丢弃超额 entity，原序保持；截断记显式 gap。

import type { ContextBudget } from "@/lib/context-budget"

/** 与 context-engine.ts ContextGap 结构一致的最小面（避免循环 import）。 */
export interface EntityBudgetGap {
  type: "compressed" | "truncated" | "load_failed"
  ref: string
  reason: "budget_exceeded" | "tier_compressible" | "datasource_error"
  originalLength: number
  retainedLength: number
}

export interface ContextEntity {
  entityId: string
  name: string
  type: string
  tags?: string[]
}

/**
 * EPIC-003 / ADR-32 / TASK-003 (RPC-4 Track B): compressible-with-floor 预算截断
 * （TASK-004 仅出数字，本函数落地）。rank0 entity（relevance:high 或
 * location:chapter-N 当前章节）floor 保护全保；rank1/rank2 按 tier cap
 * （rank1CompressibleCap / rank2CompressibleCap）压缩。原序保持（仅按 tier 配额
 * 丢弃超额 entity，不重排），故 flag=false 时 activeEntities 原序不变（D4）。
 *
 * IC-02：rank1/rank2 被 tier cap 截断时返回显式 ContextGap（type 'truncated'，
 * reason 'tier_compressible'）——绝不静默。调用方 push 到 pack.gaps。
 * budget 为 undefined（无 build 预算场景，如单测直调）时原样返回不截断不记 gap。
 */
export function truncateActiveEntitiesByBudget(
  entities: ContextEntity[],
  budget: ContextBudget["activeEntitiesBudget"] | undefined,
  chapterNumber: number,
): { entities: ContextEntity[]; gap: EntityBudgetGap | null } {
  if (!budget) {
    return { entities, gap: null }
  }
  const rankOf = (e: ContextEntity): number => {
    const tagStr = (e.tags ?? []).join(" ")
    if (tagStr.includes("relevance:high")) return 0
    if (chapterNumber && tagStr.includes(`location:chapter-${chapterNumber}`)) return 0
    if (tagStr.includes("relevance:low")) return 2
    return 1
  }
  let rank1Used = 0
  let rank2Used = 0
  const kept: ContextEntity[] = []
  let truncated = false
  for (const e of entities) {
    const r = rankOf(e)
    if (r === 0) {
      kept.push(e)
    } else if (r === 1) {
      if (rank1Used < budget.rank1CompressibleCap) {
        kept.push(e)
        rank1Used++
      } else {
        truncated = true
      }
    } else {
      if (rank2Used < budget.rank2CompressibleCap) {
        kept.push(e)
        rank2Used++
      } else {
        truncated = true
      }
    }
  }
  const originalLength = entities.length
  const retainedLength = kept.length
  // IC-02: active_entities_truncated —— 压缩 tier 被预算截断时显式记 gap。
  const gap: EntityBudgetGap | null = truncated
    ? { type: "truncated", ref: "activeEntities", reason: "tier_compressible", originalLength, retainedLength }
    : null
  return { entities: kept, gap }
}
