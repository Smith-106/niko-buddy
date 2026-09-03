import { describe, expect, it } from "vitest"
import type { CanonEdge } from "./canon-types"
import {
  effectiveCanonCreatedAt,
  effectiveCanonExpiredAt,
  isCanonEdgeEffectiveAt,
} from "./canon-types"

function edge(overrides: Partial<CanonEdge> = {}): CanonEdge {
  return {
    id: "e1",
    source_id: "s",
    target_id: "t",
    predicate: "rel",
    edge_kind: "world_fact",
    ...overrides,
  }
}

describe("canon-types G3 bi-temporal 契约 / 51 号报告", () => {
  it("round-trip：Rust 形态 JSON（含 created_at/expired_at）反序列化进 TS CanonEdge", () => {
    // 模拟 Rust serde 输出的 snake_case JSON。
    const rustJson = {
      id: "e1",
      source_id: "s",
      target_id: "t",
      predicate: "rel",
      edge_kind: "world_fact",
      valid_at: 5,
      invalid_at: null,
      digest: "",
      archived: false,
      recorded_revision: 3,
      created_at: 1_700_000_000,
      expired_at: null,
    }
    const e: CanonEdge = rustJson as CanonEdge
    expect(e.created_at).toBe(1_700_000_000)
    expect(e.expired_at).toBeNull()
    expect(e.valid_at).toBe(5)
  })

  it("旧数据无事务时间字段 → undefined，不报错（向后兼容）", () => {
    const e = edge({ valid_at: 5, invalid_at: 10 })
    expect(e.created_at).toBeUndefined()
    expect(e.expired_at).toBeUndefined()
  })

  it("effectiveCanonCreatedAt/ExpiredAt：事务时间缺失 → 回退故事时间", () => {
    const e = edge({ valid_at: 5, invalid_at: 10 })
    expect(effectiveCanonCreatedAt(e)).toBe(5)
    expect(effectiveCanonExpiredAt(e)).toBe(10)
  })

  it("effectiveCanonCreatedAt/ExpiredAt：事务时间存在 → 优先用事务时间", () => {
    const e = edge({ valid_at: 5, created_at: 1_700_000_000, expired_at: 1_700_999_999 })
    expect(effectiveCanonCreatedAt(e)).toBe(1_700_000_000)
    expect(effectiveCanonExpiredAt(e)).toBe(1_700_999_999)
  })

  it("isCanonEdgeEffectiveAt：事务时间窗口内 true，窗外 false", () => {
    const e = edge({ created_at: 1_700_000_000, expired_at: 1_700_999_999 })
    expect(isCanonEdgeEffectiveAt(e, 1_700_500_000)).toBe(true)
    expect(isCanonEdgeEffectiveAt(e, 1_999_999_999)).toBe(false)
  })

  it("isCanonEdgeEffectiveAt：无 expired_at → 视作仍有效（开放上界）", () => {
    const e = edge({ created_at: 1_700_000_000 })
    expect(isCanonEdgeEffectiveAt(e, 1_999_999_999)).toBe(true)
  })
})
