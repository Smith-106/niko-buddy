import { describe, expect, it, vi } from "vitest"

vi.mock("@/commands/fs", () => ({
  listDirectory: vi.fn(async (p: string) =>
    p.endsWith("translation-drafts") ? [{ name: "1.md", path: p + "/1.md", is_dir: false }] : [],
  ),
}))
vi.mock("@/lib/novel/canon-dual-write", () => ({ getCanonRevision: vi.fn(async () => 3) }))
vi.mock("@/lib/novel/fts-index", () => ({
  loadFtsIndex: vi.fn(async () => ({ version: 1, docs: {}, postings: {} })),
  rebuildWikiFtsIndex: vi.fn(async () => ({ indexed: 2, errors: [] as string[] })),
}))
vi.mock("@/lib/novel/fanfic-canon-import", () => ({
  loadFanficMergeProposal: vi.fn(async () => null),
}))
vi.mock("@/lib/novel/interactive-io", () => ({ loadInteractiveGraph: vi.fn(async () => null) }))
vi.mock("@/lib/novel/interactive-film-graph", () => ({ validateInteractiveGraph: vi.fn(() => []) }))
vi.mock("@/lib/novel/volume", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel/volume")>()
  return { ...actual, getChapterVolumes: vi.fn(async () => [{ volumeNumber: 2, title: "卷二", summary: "", chapterRangeStart: 1, chapterRangeEnd: 10 }]) }
})
vi.mock("@/lib/novel/novel-session-status", () => ({
  loadNovelSessionStatus: vi.fn(async () => ({
    current_task: { task_id: "t1", status: "running", chapter_number: 5 },
    stage_metrics: [
      { stage: "write_llm", tokenCost: 100, latencyMs: 50 },
      { stage: "six_dim", tokenCost: 200, latencyMs: 70 },
    ],
  })),
}))
vi.mock("@/lib/embedding", () => ({
  triggerIdleCompaction: vi.fn(async () => ({ chunks_compacted: 1, old_fragments_cleared: 0 })),
}))
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({ deleted_pages: [], upserted_pages: [], failed_pages: [] })),
}))

import { collectDoctorExtras, safeRebuildFtsIndex, safeRunVectorReconcile, safeTriggerVectorCompaction } from "./doctor-extras"

describe("doctor-extras", () => {
  it("聚合9项真实extras", async () => {
    const e = await collectDoctorExtras("/p/book")
    expect(e.canonDualWriteEnabled).toBe(true)
    expect(e.ftsIndexReady).toBe(true)
    expect(e.budgetTasks).toEqual([{ taskId: "t1" }])
    expect(e.translationDraftCount).toBe(1)
    expect(e.playGraphErrors).toBe(0)
    // 卷纲真源：第 2 卷（1-10 章）第 5 章 → 卷内第 5 章，段 = 承。
    expect(e.volumeArc?.volumeNumber).toBe(2)
    expect(e.volumeArc?.segment).toBe("承")
    expect(e.volumeArc?.completedInVolume).toBe(5)
    // budget 台账真源：stage_metrics 累计。
    expect(e.budgetTotals).toEqual({ tokenCost: 300, latencyMs: 120, entries: 2 })
  })

  it("自愈动作成功路径", async () => {
    expect((await safeRebuildFtsIndex("/p/book")).indexed).toBe(2)
    expect((await safeTriggerVectorCompaction("/p/book")).ok).toBe(true)
    expect((await safeRunVectorReconcile("/p/book")).ok).toBe(true)
  })
})
