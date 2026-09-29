// Copyright © Niko Buddy
// SPDX-License-Identifier: MIT
//
// context-pack-format-helpers.ts — F4-4 (Round-4 评估)：pack 格式化纯函数簇。
//
// 从 context-engine.ts（2813 行巨石）拆出的第四个纯函数子模块：
// narrativeVisibilitySummary / extractSceneCharacters /
// applySectionCharBudget / charsPerTokenOfPack。零运行时依赖 context-engine
//（仅 type-only 引用 ContextPack；NarrativeStateStore type-only 引自
// narrative-state，与 snapshot-paths.ts 同款编译期擦除模式，无运行时循环）；
// context-engine 经 re-export 保持既有 import 面不变（trim/droporder/
// budget/wiring 等 spec 不动）。

import type { ContextPack } from "./context-engine"
import type { NarrativeStateStore } from "./narrative-state"

// MIG-003: 叙事信息差可见性摘要渲染——统计已知/未知声明 + 各角色视角
// 可见声明数。空 store（无声明/无可见性）→ ""，调用方转 undefined 不渲染。
export function narrativeVisibilitySummary(store: NarrativeStateStore | null): string {
  if (!store || !Array.isArray(store.declarations) || store.declarations.length === 0) return ""
  const lines: string[] = []
  const knownByChar = new Map<string, number>()
  for (const v of store.visibilities ?? []) {
    if (v.state === "known") {
      knownByChar.set(v.characterId, (knownByChar.get(v.characterId) ?? 0) + 1)
    }
  }
  lines.push(`叙事声明共 ${store.declarations.length} 条`)
  for (const [char, n] of knownByChar) {
    lines.push(`- ${char} 视角可见 ${n} 条`)
  }
  return lines.length > 1 ? lines.join("\n") : ""
}

export function extractSceneCharacters(rawData: Record<string, unknown>): string {
  const parts: string[] = []
  const snapshots = (typeof rawData.snapshots === "object" && rawData.snapshots !== null
    ? rawData.snapshots
    : {}) as { characterStates?: unknown }
  const snapshotCharStates = snapshots.characterStates
  if (typeof snapshotCharStates === "string" && snapshotCharStates.trim()) {
    parts.push(snapshotCharStates)
  }
  const fallbackCharStates = typeof rawData.fallbackCharacterStates === "string" ? rawData.fallbackCharacterStates : undefined
  if (typeof fallbackCharStates === "string" && fallbackCharStates.trim()) {
    parts.push(fallbackCharStates)
  }
  return parts.join("\n\n")
}

export function applySectionCharBudget(
  content: string | string[] | undefined | null,
  budget: number | undefined,
): string | string[] {
  if (content == null) return ""
  if (!budget || budget <= 0) return content
  if (Array.isArray(content)) {
    const out: string[] = []
    let used = 0
    for (const item of content) {
      if (used >= budget) break
      const room = budget - used
      if (item.length <= room) {
        out.push(item)
        used += item.length
      } else {
        out.push(item.slice(0, room) + "…")
        break
      }
    }
    return out
  }
  return content.length <= budget ? content : content.slice(0, budget) + "…"
}

export function charsPerTokenOfPack(pack: ContextPack): number {
  const text = JSON.stringify(pack)
  if (text.length === 0) return 4
  const cjkCount = (text.match(/[\u3400-\u9FFF]/g) ?? []).length
  const cjkRatio = cjkCount / text.length
  const ratio = 1 / (cjkRatio / 1.5 + (1 - cjkRatio) / 4)
  // RV-014：退化输入兜底 — 非有限/非正比率回退纯 ASCII 口径（4），杜绝 NaN 归一化。
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 4
}
