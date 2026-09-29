// @vitest-environment node
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// context-entity-budget.spec — F4（Round-1 评估）拆分产物单测：
// truncateActiveEntitiesByBudget 纯函数边界（与 context-engine 内联实现语义一致）。

import { describe, expect, it } from "vitest"
import { truncateActiveEntitiesByBudget, type ContextEntity } from "./context-entity-budget"

function mkEntity(id: string, tags: string[] = []): ContextEntity {
  return { entityId: id, name: id, type: "character", tags }
}

const BUDGET = { rank1CompressibleCap: 1, rank2CompressibleCap: 1 } as never

describe("context-entity-budget (F4 split)", () => {
  it("budget undefined → 原样返回不截断不记 gap", () => {
    const entities = [mkEntity("a"), mkEntity("b")]
    const r = truncateActiveEntitiesByBudget(entities, undefined, 5)
    expect(r.entities).toBe(entities)
    expect(r.gap).toBeNull()
  })

  it("rank0（relevance:high / 当前章 location）floor 全保", () => {
    const entities = [
      mkEntity("high", ["relevance:high"]),
      mkEntity("loc", ["location:chapter-5"]),
      mkEntity("mid1"),
      mkEntity("mid2"),
      mkEntity("low1", ["relevance:low"]),
      mkEntity("low2", ["relevance:low"]),
    ]
    const r = truncateActiveEntitiesByBudget(entities, BUDGET, 5)
    const ids = r.entities.map((e) => e.entityId)
    expect(ids).toContain("high")
    expect(ids).toContain("loc")
    expect(ids).toContain("mid1")
    expect(ids).not.toContain("mid2")
    expect(ids).toContain("low1")
    expect(ids).not.toContain("low2")
    expect(r.gap).not.toBeNull()
    expect(r.gap?.type).toBe("truncated")
    expect(r.gap?.ref).toBe("activeEntities")
    expect(r.gap?.originalLength).toBe(6)
    expect(r.gap?.retainedLength).toBe(4)
  })

  it("配额内不截断 → gap 为 null 且原序不变", () => {
    const entities = [mkEntity("a"), mkEntity("b", ["relevance:low"])]
    const r = truncateActiveEntitiesByBudget(entities, BUDGET, 5)
    expect(r.entities.map((e) => e.entityId)).toEqual(["a", "b"])
    expect(r.gap).toBeNull()
  })
})
