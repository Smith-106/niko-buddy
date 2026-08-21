/**
 * canon-graph-client.spec.ts — T14 投影薄客户端收敛测试。
 *
 * 守三项契约：
 *   1. 投影正确性：snake_case 原始边 → camelCase `CanonFact`，字段一一映射。
 *   2. 禁句柄外泄：投影产物绝不含 `known_by` / `digest`（POV 防泄密地基）。
 *   3. IPC 契约：invoke 命令名 + 参数形态（camelCase 顶层 + snake_case 嵌套）正确。
 *
 * mock invoke（与 export.spec.ts 同模式），不依赖 Tauri 运行时。
 */

import { describe, expect, it, vi, beforeEach } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import {
  FORBIDDEN_HANDLE_KEYS,
  assertNoHandleLeak,
  getFactsKnownBy,
  projectEdge,
  projectEdges,
  queryCanonEdges,
  queryCanonEdgesBatch,
  type CanonEdgeFilter,
  type CanonEdgeKind,
  type CanonFact,
  type RawCanonEdge,
} from "./canon-graph-client"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}))

const invokeMock = vi.mocked(invoke)

beforeEach(() => {
  invokeMock.mockReset()
})

/** 构造一条 full 字段原始边（含内部句柄 known_by / digest）。 */
function fullRawEdge(): RawCanonEdge {
  return {
    id: "e1",
    source_id: "alice",
    target_id: "dagger",
    predicate: "OWNS",
    edge_kind: "world_fact",
    valid_at: 1,
    invalid_at: 10,
    reference_time: 5,
    known_by: ["alice", "bob"],
    revealed_at: 3,
    confidence: 0.9,
    source_chapter: 2,
    digest: "abc123",
    beat_label: "midpoint",
    beat_hit: true,
    foreshadow_planted_at: 4,
    hook_type: "mystery",
    payoff_chapter: 9,
    archived: true,
  }
}

/** 构造一条 empty 可选字段的原始边（缺省走 ?? null / ?? false 分支）。 */
function sparseRawEdge(): RawCanonEdge {
  return {
    id: "e2",
    source_id: "src",
    target_id: "tgt",
    predicate: "REL",
    edge_kind: "motivation",
  }
}

describe("getFactsKnownBy（T13 canon_facts_known_by 投影封装）", () => {
  it("带 atChapter：invoke 参数形态正确，投影剥离 known_by/digest 且字段映射正确", async () => {
    invokeMock.mockResolvedValue({ edges: [fullRawEdge()], max_revision: 7 })

    const facts = await getFactsKnownBy("proj-1", "alice", 5)

    expect(invokeMock).toHaveBeenCalledWith("canon_facts_known_by", {
      projectId: "proj-1",
      pov: "alice",
      atChapter: 5,
    })
    expect(facts).toHaveLength(1)
    const f = facts[0]
    expect(f).toEqual({
      id: "e1",
      sourceId: "alice",
      targetId: "dagger",
      predicate: "OWNS",
      edgeKind: "world_fact",
      validAt: 1,
      invalidAt: 10,
      referenceTime: 5,
      revealedAt: 3,
      confidence: 0.9,
      sourceChapter: 2,
      beatLabel: "midpoint",
      beatHit: true,
      foreshadowPlantedAt: 4,
      hookType: "mystery",
      payoffChapter: 9,
      archived: true,
    })
    // 禁句柄外泄：投影产物不得含内部句柄键
    expect("knownBy" in f).toBe(false)
    expect("digest" in f).toBe(false)
    expect(f).not.toHaveProperty("known_by")
    expect(f).not.toHaveProperty("digest")
  })

  it("不带 atChapter：atChapter 传 null（Rust Option<i32> = None）", async () => {
    invokeMock.mockResolvedValue({ edges: [], max_revision: 0 })

    await getFactsKnownBy("proj-1", "alice")

    expect(invokeMock).toHaveBeenCalledWith("canon_facts_known_by", {
      projectId: "proj-1",
      pov: "alice",
      atChapter: null,
    })
  })

  it("空边集返回空数组，且不触发断言失败", async () => {
    invokeMock.mockResolvedValue({ edges: [], max_revision: 0 })
    const facts = await getFactsKnownBy("p", "alice", 3)
    expect(facts).toEqual([])
  })
})

describe("queryCanonEdges（T13 canon_query 投影封装）", () => {
  it("snake_case 嵌套 filter 直传，返回投影事实且不含句柄", async () => {
    invokeMock.mockResolvedValue({ edges: [fullRawEdge(), sparseRawEdge()], max_revision: 2 })

    const filter: CanonEdgeFilter = {
      known_by: "alice",
      valid_at_chapter: 5,
      edge_kinds: ["world_fact", "motivation"] as CanonEdgeKind[],
      predicates: ["OWNS"],
      entity_ids: ["alice"],
      archived: false,
      limit: 50,
    }
    const facts = await queryCanonEdges("proj-1", filter)

    expect(invokeMock).toHaveBeenCalledWith("canon_query", {
      projectId: "proj-1",
      filter,
    })
    expect(facts).toHaveLength(2)
    // sparse 边走 ?? null / ?? false 分支
    expect(facts[1].validAt).toBeNull()
    expect(facts[1].archived).toBe(false)
    for (const f of facts) {
      expect(f).not.toHaveProperty("known_by")
      expect(f).not.toHaveProperty("digest")
    }
  })
})

describe("queryCanonEdgesBatch（T13 canon_query_batch 投影封装）", () => {
  it("多 filter 单 invoke，结果顺序与 filters 一一对应", async () => {
    invokeMock.mockResolvedValue({
      results: [[fullRawEdge()], [], [sparseRawEdge()]],
      max_revision: 4,
    })

    const filters = [
      { known_by: "alice" },
      { known_by: "carol" },
      { edge_kinds: ["motivation"] as const },
    ]
    const results = await queryCanonEdgesBatch("proj-1", filters as any)

    expect(invokeMock).toHaveBeenCalledWith("canon_query_batch", {
      projectId: "proj-1",
      filters,
    })
    expect(results).toHaveLength(3)
    expect(results[0]).toHaveLength(1)
    expect(results[1]).toHaveLength(0)
    expect(results[2]).toHaveLength(1)
    expect(results[0][0].sourceId).toBe("alice")
    expect(results[2][0].edgeKind).toBe("motivation")
    // 每条结果均经禁句柄外泄守护
    expect(results[0][0]).not.toHaveProperty("known_by")
    expect(results[2][0]).not.toHaveProperty("digest")
  })
})

describe("projectEdge / projectEdges（投影 allowlist）", () => {
  it("projectEdge 显式剥离 raw 中的 known_by/digest（defense-in-depth）", () => {
    const raw = fullRawEdge()
    const fact = projectEdge(raw)
    expect(fact).not.toHaveProperty("known_by")
    expect(fact).not.toHaveProperty("digest")
    expect(fact.edgeKind).toBe("world_fact")
  })

  it("projectEdges 批量投影", () => {
    const facts = projectEdges([fullRawEdge(), sparseRawEdge()])
    expect(facts).toHaveLength(2)
    expect(facts.every((f) => !("known_by" in f) && !("digest" in f))).toBe(true)
  })
})

describe("assertNoHandleLeak（禁句柄外泄断言 · POV 防泄密兜底）", () => {
  it("FORBIDDEN_HANDLE_KEYS 含 known_by 与 digest", () => {
    expect([...FORBIDDEN_HANDLE_KEYS].sort()).toEqual(["digest", "known_by"])
  })

  const cleanFact: CanonFact = {
    id: "e1",
    sourceId: "a",
    targetId: "b",
    predicate: "REL",
    edgeKind: "arc",
    archived: false,
  }

  it("干净 CanonFact 不抛错", () => {
    expect(() => assertNoHandleLeak(cleanFact)).not.toThrow()
  })

  it("含 known_by 键 → 抛错", () => {
    expect(() =>
      assertNoHandleLeak({ ...cleanFact, known_by: ["bob"] } as unknown as CanonFact),
    ).toThrow(/禁句柄外泄断言失败/)
  })

  it("含 digest 键 → 抛错", () => {
    expect(() =>
      assertNoHandleLeak({ ...cleanFact, digest: "x" } as unknown as CanonFact),
    ).toThrow(/禁句柄外泄断言失败/)
  })

  it("null → 抛错（非普通对象）", () => {
    expect(() => assertNoHandleLeak(null)).toThrow(/疑似句柄外泄/)
  })

  it("基本类型（非对象）→ 抛错", () => {
    expect(() => assertNoHandleLeak(42 as unknown)).toThrow(/疑似句柄外泄/)
    expect(() => assertNoHandleLeak("str" as unknown)).toThrow(/疑似句柄外泄/)
  })

  it("数组 → 抛错（不得是集合载体）", () => {
    expect(() => assertNoHandleLeak([cleanFact] as unknown)).toThrow(/疑似句柄外泄/)
  })
})
