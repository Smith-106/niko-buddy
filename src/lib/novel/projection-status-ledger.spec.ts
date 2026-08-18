import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  PROJECTION_CATEGORIES,
  emptyLedger,
  loadProjectionStatusLedger,
  recordProjectionStatus,
  saveProjectionStatusLedger,
  type ProjectionStatusLedger,
} from "./projection-status-ledger"
import { supersedeFact } from "./graph-adapter"

// F-002 持久化读路径 (loadProjectionStatusLedger) 需要 @/commands/fs mock;
// graph-adapter 的 supersedeFact 测试只用字符串处理, 不受 mock 影响。
const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(async () => {
    throw new Error("ENOENT")
  }),
  writeFileAtomic: vi.fn(async () => {}),
  createDirectory: vi.fn(async () => {}),
  fileExists: vi.fn(async () => false),
}))

vi.mock("@/commands/fs", () => ({
  readFile: fsMocks.readFile,
  writeFileAtomic: fsMocks.writeFileAtomic,
  createDirectory: fsMocks.createDirectory,
  fileExists: fsMocks.fileExists,
}))

beforeEach(() => {
  fsMocks.readFile.mockReset()
  fsMocks.readFile.mockImplementation(async () => {
    throw new Error("ENOENT")
  })
})

describe("F-002 ProjectionStatusLedger (C-002 mixed_per_projection)", () => {
  it("defines all 3 C-002 categories across the 9 projections", () => {
    const cats = PROJECTION_CATEGORIES
    // single_snapshot_idempotent
    expect(cats.vector).toBe("single_snapshot_idempotent")
    expect(cats.snapshot).toBe("single_snapshot_idempotent")
    expect(cats.chapter_ingest_output).toBe("single_snapshot_idempotent")
    // fold_rebuildable
    expect(cats.cognition).toBe("fold_rebuildable")
    expect(cats.character).toBe("fold_rebuildable")
    expect(cats.foreshadow).toBe("fold_rebuildable")
    expect(cats.summary_structured_memory).toBe("fold_rebuildable")
    // mutates_existing_non_rebuildable
    expect(cats.graph_entity_pages).toBe("mutates_existing_non_rebuildable")
    expect(cats.graph_entity_patch_fields).toBe("mutates_existing_non_rebuildable")
    expect(cats.community_summary).toBe("mutates_existing_non_rebuildable")

    // Exactly 3 distinct categories present.
    const distinct = new Set(Object.values(cats))
    expect(distinct.size).toBe(3)
    expect(distinct.has("single_snapshot_idempotent")).toBe(true)
    expect(distinct.has("fold_rebuildable")).toBe(true)
    expect(distinct.has("mutates_existing_non_rebuildable")).toBe(true)
  })

  it("emptyLedger seeds the canonical category mapping", () => {
    const ledger = emptyLedger()
    expect(ledger.projections.vector).toBe("single_snapshot_idempotent")
    expect(ledger.projections.graph_entity_pages).toBe("mutates_existing_non_rebuildable")
    expect(ledger.chapters).toEqual({})
  })

  it("subplot_board is single_snapshot_idempotent (ARCH-002: empty-store commit, no snapshot field wired yet)", () => {
    // ARCH-002 / ISS-20260708-006: chapter-ingest commits an empty store
    // (no snapshot subplot field wired — LLM-extract extension out of scope),
    // so the category is single_snapshot_idempotent, NOT fold_rebuildable.
    // Re-classify to fold_rebuildable when a snapshot subplot field is added.
    expect(PROJECTION_CATEGORIES.subplot_board).toBe("single_snapshot_idempotent")
  })

  it("recordProjectionStatus records a committed projection additively (failure is VISIBLE, not silent)", () => {
    // The core F-002 invariant: a projection failure is recorded to the ledger
    // so it is detectable — replacing the prior 8-segment silent console.warn.
    let ledger: ProjectionStatusLedger = emptyLedger()
    ledger = recordProjectionStatus(ledger, 5, "cognition", "committed")
    ledger = recordProjectionStatus(ledger, 5, "graph_entity_pages", "failed", "write failed: EACCES")
    ledger = recordProjectionStatus(ledger, 5, "character", "committed")

    const ch5 = ledger.chapters["5"]
    expect(ch5.cognition.status).toBe("committed")
    expect(ch5.cognition.category).toBe("fold_rebuildable")
    expect(ch5.character.status).toBe("committed")
    // The FAILED projection is recorded with its error — visible, not swallowed.
    expect(ch5.graph_entity_pages.status).toBe("failed")
    expect(ch5.graph_entity_pages.last_error).toContain("EACCES")
    expect(ch5.graph_entity_pages.category).toBe("mutates_existing_non_rebuildable")
  })

  it("recordProjectionStatus preserves other chapters' entries (additive, per-cell update)", () => {
    let ledger: ProjectionStatusLedger = emptyLedger()
    ledger = recordProjectionStatus(ledger, 1, "cognition", "committed")
    ledger = recordProjectionStatus(ledger, 2, "character", "failed", "boom")
    // Recording chapter 3 must not clobber chapters 1 and 2.
    ledger = recordProjectionStatus(ledger, 3, "foreshadow", "committed")
    expect(ledger.chapters["1"].cognition.status).toBe("committed")
    expect(ledger.chapters["2"].character.status).toBe("failed")
    expect(ledger.chapters["3"].foreshadow.status).toBe("committed")
  })
})

describe("F-002 loadProjectionStatusLedger 持久化读路径", () => {
  it("merges a partial file's projections with the canonical categories", async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        projections: { vector: "single_snapshot_idempotent", community_summary: "mutates_existing_non_rebuildable" },
        chapters: {
          "3": {
            cognition: { projection: "cognition", category: "fold_rebuildable", status: "committed", updated_at: "2026-07-10T00:00:00Z", last_error: "" },
          },
        },
      }),
    )
    const ledger = await loadProjectionStatusLedger("E:/Novel")
    // 文件里的覆盖值 + 规范化 categories 合并 (旧版本账本也能反映新 projection)
    expect(ledger.projections.vector).toBe("single_snapshot_idempotent")
    expect(ledger.projections.community_summary).toBe("mutates_existing_non_rebuildable")
    expect(ledger.projections.character).toBe("fold_rebuildable")
    expect(ledger.projections.subplot_board).toBe("single_snapshot_idempotent")
    expect(ledger.chapters["3"].cognition.status).toBe("committed")
  })

  it("uses {} when a legacy file has no projections field", async () => {
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ version: 1, chapters: {} }))
    const ledger = await loadProjectionStatusLedger("E:/Novel")
    // parsed.projections undefined → ?? {} 臂 → 只有规范化 categories
    expect(ledger.projections.vector).toBe("single_snapshot_idempotent")
    expect(Object.keys(ledger.projections)).toEqual(Object.keys(PROJECTION_CATEGORIES))
    expect(ledger.chapters).toEqual({})
  })

  it("returns the empty ledger for non-object or chapters-less payloads", async () => {
    fsMocks.readFile.mockResolvedValue("null") // !parsed 臂
    expect(await loadProjectionStatusLedger("E:/Novel")).toEqual(emptyLedger())

    fsMocks.readFile.mockResolvedValue(JSON.stringify({ version: 1 })) // 缺 chapters 臂
    expect(await loadProjectionStatusLedger("E:/Novel")).toEqual(emptyLedger())
  })

  it("recordProjectionStatus falls back to fold_rebuildable for unknown projections", () => {
    const ledger = recordProjectionStatus(emptyLedger(), 1, "unknown_projection", "failed", "boom")
    expect(ledger.chapters["1"].unknown_projection.category).toBe("fold_rebuildable")
  })

  it("returns the empty ledger when the ledger file is missing or unreadable", async () => {
    // beforeEach 默认 readFile 抛 ENOENT → catch → emptyLedger
    expect(await loadProjectionStatusLedger("E:/Novel")).toEqual(emptyLedger())
  })

  it("saveProjectionStatusLedger writes atomic json under .novel", async () => {
    await saveProjectionStatusLedger("E:/Novel", emptyLedger())
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("E:/Novel/.novel")
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledWith(
      "E:/Novel/.novel/projection-status.json",
      expect.any(String),
    )
  })
})

describe("F-002 graph mergeExistingPage supersession (no destructive overwrite)", () => {
  it("supersedeFact appends a versioned fact WITHOUT removing the old value", () => {
    // ANL-010 L4: mergeExistingPage previously overwrote fact fields in place.
    // The supersession model appends the new value alongside the old so the
    // version history is recoverable for a delete+re-fold rebuild.
    const page = "---\nsnapshot_id: \"snap-1\"\n---\n\nBody text.\n"
    const superseded = supersedeFact(page, "status", "advanced")
    // The old body is preserved.
    expect(superseded).toContain("Body text.")
    // The new value is appended as a versioned line.
    expect(superseded).toContain("status_v: \"advanced\"")
  })

  it("supersedeFact leaves content without frontmatter unchanged (defensive)", () => {
    const noFm = "just body, no frontmatter here"
    expect(supersedeFact(noFm, "status", "x")).toBe(noFm)
  })
})
