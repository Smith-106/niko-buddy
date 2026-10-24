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
vi.mock("@/lib/novel/novel-session-status", () => ({
  loadNovelSessionStatus: vi.fn(async () => ({
    current_task: { task_id: "t1", status: "running", chapter_number: 5 },
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
    expect(e.volumeArc?.completedInVolume).toBe(5)
  })

  it("自愈动作成功路径", async () => {
    expect((await safeRebuildFtsIndex("/p/book")).indexed).toBe(2)
    expect((await safeTriggerVectorCompaction("/p/book")).ok).toBe(true)
    expect((await safeRunVectorReconcile("/p/book")).ok).toBe(true)
  })
})
