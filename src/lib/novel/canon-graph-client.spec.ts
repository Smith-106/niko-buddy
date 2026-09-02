// Copyright (c) 2024 Niko-hub contributors. MIT License.
//
// v2.8 P1-2：canon_query_episodes 分页 + query_batch 筛选构造器（buildCanonEdgeFilter）。
// 纯函数/契约测试：不 invoke 真实 Tauri 命令，只验证参数构造与类型契约。

import { describe, expect, it, vi } from "vitest"
import {
  buildCanonEdgeFilter,
  getFactsKnownBy,
  getFactsKnownByPaged,
  queryEpisodesByChapter,
} from "./canon-graph-client"

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}))

import { invoke } from "@tauri-apps/api/core"

describe("buildCanonEdgeFilter (v2.8 P1-2 批量筛选构造器)", () => {
  it("空选项 → 全量 filter（所有字段 null）", () => {
    expect(buildCanonEdgeFilter({})).toEqual({
      known_by: null,
      valid_at_chapter: null,
      include_invalidated: null,
      edge_kinds: null,
      predicates: null,
      entity_ids: null,
      archived: null,
      digest: null,
      limit: null,
      offset: null,
      max_recorded_revision: null,
    })
  })

  it("camelCase 意图 → snake_case 契约（与 Rust CanonEdgeFilter 对齐）", () => {
    const filter = buildCanonEdgeFilter({
      edgeKinds: ["world_fact", "arc"],
      predicates: ["causes"],
      entityIds: ["alice"],
      knownBy: "narrator",
      validAtChapter: 3,
      includeInvalidated: true,
      archived: false,
      digest: ["d1", "d2"],
      limit: 50,
      offset: 100,
      maxRecordedRevision: 5,
    })
    expect(filter).toEqual({
      known_by: "narrator",
      valid_at_chapter: 3,
      include_invalidated: true,
      edge_kinds: ["world_fact", "arc"],
      predicates: ["causes"],
      entity_ids: ["alice"],
      archived: false,
      digest: ["d1", "d2"],
      limit: 50,
      offset: 100,
      max_recorded_revision: 5,
    })
  })

  it("部分选项 → 未提供字段为 null（不泄漏旧值）", () => {
    const filter = buildCanonEdgeFilter({ predicates: ["knows"] })
    expect(filter.predicates).toEqual(["knows"])
    expect(filter.known_by).toBeNull()
    expect(filter.edge_kinds).toBeNull()
    expect(filter.limit).toBeNull()
    expect(filter.offset).toBeNull()
  })
})

describe("queryEpisodesByChapter 分页 (v2.8 P1-2)", () => {
  it("无分页参数 → offset/limit 传 null（旧行为全量）", async () => {
    vi.mocked(invoke).mockResolvedValue({ episodes: [], total: 0, max_revision: 0 })
    await queryEpisodesByChapter("proj-1", 2)
    expect(invoke).toHaveBeenCalledWith("canon_query_episodes", {
      projectId: "proj-1",
      chapterNumber: 2,
      offset: null,
      limit: null,
    })
  })

  it("分页参数 → offset/limit 透传", async () => {
    vi.mocked(invoke).mockResolvedValue({ episodes: [], total: 7, max_revision: 3 })
    const res = await queryEpisodesByChapter("proj-1", 2, { offset: 5, limit: 5 })
    expect(invoke).toHaveBeenCalledWith("canon_query_episodes", {
      projectId: "proj-1",
      chapterNumber: 2,
      offset: 5,
      limit: 5,
    })
    expect(res.total).toBe(7)
  })
})

describe("getFactsKnownByPaged 分页 + 投影防泄密 (P1-1)", () => {
  const rawEdge = {
    id: "e1",
    source_id: "ent:alice",
    target_id: "ent:bob",
    predicate: "KNOWS",
    edge_kind: "world_fact",
    known_by: ["pov:alpha"],
    digest: "abc123",
  }

  it("分页参数 → offset/limit 透传，返回 {facts,total,maxRevision}", async () => {
    vi.mocked(invoke).mockResolvedValue({ edges: [rawEdge], total: 42, max_revision: 7 })
    const res = await getFactsKnownByPaged("proj-1", "pov:alpha", 3, true, {
      offset: 0,
      limit: 200,
    })
    expect(invoke).toHaveBeenCalledWith("canon_facts_known_by", {
      projectId: "proj-1",
      pov: "pov:alpha",
      atChapter: 3,
      includeInvalidated: true,
      offset: 0,
      limit: 200,
    })
    expect(res.total).toBe(42)
    expect(res.maxRevision).toBe(7)
    expect(res.facts).toHaveLength(1)
  })

  it("无分页参数 → offset/limit 传 null（旧行为全量）", async () => {
    vi.mocked(invoke).mockResolvedValue({ edges: [], total: 0, max_revision: 0 })
    await getFactsKnownByPaged("proj-1", "pov:alpha")
    expect(invoke).toHaveBeenCalledWith("canon_facts_known_by", {
      projectId: "proj-1",
      pov: "pov:alpha",
      atChapter: null,
      includeInvalidated: null,
      offset: null,
      limit: null,
    })
  })

  it("投影层剥离 known_by/digest（禁句柄外泄）", async () => {
    vi.mocked(invoke).mockResolvedValue({ edges: [rawEdge], total: 1, max_revision: 7 })
    const res = await getFactsKnownByPaged("proj-1", "pov:alpha", undefined, undefined, {
      offset: 0,
      limit: 200,
    })
    expect(res.facts[0]).not.toHaveProperty("known_by")
    expect(res.facts[0]).not.toHaveProperty("digest")
    expect(res.facts[0].sourceId).toBe("ent:alice")
    expect(res.facts[0].targetId).toBe("ent:bob")
  })

  it("getFactsKnownBy 委托 getFactsKnownByPaged 并只返回 facts", async () => {
    vi.mocked(invoke).mockResolvedValue({ edges: [rawEdge], total: 1, max_revision: 7 })
    const facts = await getFactsKnownBy("proj-1", "pov:alpha")
    expect(invoke).toHaveBeenCalledWith("canon_facts_known_by", {
      projectId: "proj-1",
      pov: "pov:alpha",
      atChapter: null,
      includeInvalidated: null,
      offset: null,
      limit: null,
    })
    expect(Array.isArray(facts)).toBe(true)
    expect(facts).toHaveLength(1)
    expect(facts[0]).not.toHaveProperty("known_by")
  })
})
