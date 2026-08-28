// Copyright (c) 2024 Niko-hub contributors. MIT License.
//
// v2.8 P1-2：canon_query_episodes 分页 + query_batch 筛选构造器（buildCanonEdgeFilter）。
// 纯函数/契约测试：不 invoke 真实 Tauri 命令，只验证参数构造与类型契约。

import { describe, expect, it, vi } from "vitest"
import { buildCanonEdgeFilter, queryEpisodesByChapter } from "./canon-graph-client"

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
    })
  })

  it("部分选项 → 未提供字段为 null（不泄漏旧值）", () => {
    const filter = buildCanonEdgeFilter({ predicates: ["knows"] })
    expect(filter.predicates).toEqual(["knows"])
    expect(filter.known_by).toBeNull()
    expect(filter.edge_kinds).toBeNull()
    expect(filter.limit).toBeNull()
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
