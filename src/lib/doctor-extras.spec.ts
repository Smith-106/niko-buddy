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
  invoke: vi.fn(async () => ({ skipped: true, deleted_pages: [], upserted_pages: [], failed_pages: [] })),
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

  it("空清单对账诚实展示已跳过，不假报 deleted", async () => {
    const r = await safeRunVectorReconcile("/p/book")
    expect(r.ok).toBe(true)
    expect(r.detail).toContain("已跳过")
    expect(r.detail).not.toContain("deleted=")
  })
})

import { getCanonRevision } from "@/lib/novel/canon-dual-write"
import { loadFtsIndex, rebuildWikiFtsIndex } from "@/lib/novel/fts-index"
import { loadFanficMergeProposal } from "@/lib/novel/fanfic-canon-import"
import { loadInteractiveGraph } from "@/lib/novel/interactive-io"
import { validateInteractiveGraph } from "@/lib/novel/interactive-film-graph"
import { loadNovelSessionStatus } from "@/lib/novel/novel-session-status"
import { getChapterVolumes } from "@/lib/novel/volume"
import { listDirectory } from "@/commands/fs"
import { triggerIdleCompaction } from "@/lib/embedding"
import { invoke } from "@tauri-apps/api/core"

describe("doctor-extras 覆盖补齐：IO 兜底 + 自愈失败分支", () => {
  it("全部 IO 失败 → 兜底默认值（canon 关/fts 未就绪/空台账/零草稿/零错误）", async () => {
    vi.mocked(getCanonRevision).mockRejectedValueOnce(new Error("canon down"))
    vi.mocked(loadFtsIndex).mockRejectedValueOnce(new Error("fts down"))
    vi.mocked(loadNovelSessionStatus).mockRejectedValueOnce(new Error("status down"))
    vi.mocked(loadFanficMergeProposal).mockRejectedValueOnce(new Error("pending down"))
    vi.mocked(listDirectory).mockRejectedValueOnce(new Error("ls down"))
    vi.mocked(loadInteractiveGraph).mockRejectedValueOnce(new Error("graph down"))
    const e = await collectDoctorExtras("/p/book")
    expect(e.canonDualWriteEnabled).toBe(false)
    expect(e.ftsIndexReady).toBe(false)
    expect(e.budgetTasks).toEqual([])
    expect(e.budgetTotals).toEqual({ tokenCost: 0, latencyMs: 0, entries: 0 })
    expect(e.volumeArc).toBeNull()
    expect(e.fanficMergePending).toBeNull()
    expect(e.translationDraftCount).toBe(0)
    expect(e.playGraphErrors).toBe(0)
  })

  it("completed 会话 → budgetCompleted 记账；fanfic pending 非空 → 透出 source/mode", async () => {
    vi.mocked(loadNovelSessionStatus).mockResolvedValueOnce({
      current_task: { task_id: "t9", status: "completed", chapter_number: 2 },
      stage_metrics: [],
    } as never)
    vi.mocked(loadFanficMergeProposal).mockResolvedValueOnce({ sourceBookId: "lib-1", mode: "au" } as never)
    const e = await collectDoctorExtras("/p/book")
    expect(e.budgetCompleted).toEqual(["t9"])
    expect(e.fanficMergePending).toEqual({ sourceBookId: "lib-1", mode: "au" })
  })

  it("卷纲读取抛错 → volumeArc 置 null（不中断整单采集）", async () => {
    vi.mocked(getChapterVolumes).mockRejectedValueOnce(new Error("volumes down"))
    const e = await collectDoctorExtras("/p/book")
    expect(e.volumeArc).toBeNull()
    // 台账仍正常累计（默认 session：100+200 tokenCost，50+70 latencyMs，两条）
    expect(e.budgetTotals).toEqual({ tokenCost: 300, latencyMs: 120, entries: 2 })
  })

  it("对局图含命中/非命中诊断 → 仅计 missing_start/dangling_edge/empty_choice", async () => {
    vi.mocked(loadInteractiveGraph).mockResolvedValueOnce({ nodes: [] } as never)
    vi.mocked(validateInteractiveGraph).mockReturnValueOnce([
      { code: "missing_start" },
      { code: "dangling_edge" },
      { code: "unrelated_note" },
    ] as never)
    const e = await collectDoctorExtras("/p/book")
    expect(e.playGraphErrors).toBe(2)
  })

  it("重建索引抛错 → indexed=0 + 错误信息（不抛）", async () => {
    vi.mocked(rebuildWikiFtsIndex).mockRejectedValueOnce(new Error("rebuild down"))
    const r = await safeRebuildFtsIndex("/p/book")
    expect(r.indexed).toBe(0)
    expect(r.errors.join("")).toContain("rebuild down")
  })

  it("向量压实抛错 → ok=false + 错误信息", async () => {
    vi.mocked(triggerIdleCompaction).mockRejectedValueOnce(new Error("compact down"))
    const r = await safeTriggerVectorCompaction("/p/book")
    expect(r.ok).toBe(false)
    expect(r.detail).toContain("compact down")
  })

  it("对账非跳过 → ok + deleted 计数", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ skipped: false, deleted_pages: ["a", "b"], upserted_pages: [], failed_pages: [] })
    const r = await safeRunVectorReconcile("/p/book")
    expect(r.ok).toBe(true)
    expect(r.detail).toBe("deleted=2")
  })

  it("对账抛错 → ok=false + 错误信息", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("invoke down"))
    const r = await safeRunVectorReconcile("/p/book")
    expect(r.ok).toBe(false)
    expect(r.detail).toContain("invoke down")
  })
})
