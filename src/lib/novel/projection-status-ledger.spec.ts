import { describe, expect, it, vi, beforeEach } from "vitest"
import {
  AUDIT_TRAIL_MAX_ENTRIES,
  PROJECTION_CATEGORIES,
  appendProjectionAuditEntry,
  emptyLedger,
  loadProjectionStatusLedger,
  recordProjectionAudit,
  recordProjectionStatus,
  saveProjectionStatusLedger,
  trimAuditTrail,
  type ProjectionAuditEntry,
  type ProjectionStatusLedger,
} from "./projection-status-ledger"
import { supersedeFact } from "./graph-adapter"

// F-002 持久化读路径 (loadProjectionStatusLedger) 需要 @/commands/fs mock;
// graph-adapter 的 supersedeFact 测试只用字符串处理, 不受 mock 影响。
const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn<(path: string) => Promise<string>>(async () => {
    throw new Error("ENOENT")
  }),
  // Typed params so mock.calls tuples + implementations typecheck strictly.
  writeFileAtomic: vi.fn<(path: string, content: string) => Promise<void>>(async () => {}),
  createDirectory: vi.fn<(path: string) => Promise<void>>(async () => {}),
  fileExists: vi.fn<(path: string) => Promise<boolean>>(async () => false),
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
    // beforeEach 默认 readFile 抛 ENOENT → catch → emptyLedger; 无 raw 内容,
    // 所以不应产生 .corrupt-* 副本
    fsMocks.writeFileAtomic.mockClear()
    expect(await loadProjectionStatusLedger("E:/Novel")).toEqual(emptyLedger())
    expect(fsMocks.writeFileAtomic).not.toHaveBeenCalled()
  })

  it("A5: corrupt ledger returns emptyLedger and preserves the original to a .corrupt-<ISO timestamp> copy", async () => {
    fsMocks.writeFileAtomic.mockClear()
    const corruptRaw = "{{{not-valid-json"
    fsMocks.readFile.mockResolvedValue(corruptRaw)

    // 损坏 JSON → 仍返回空账本 (可用性保持)
    const ledger = await loadProjectionStatusLedger("E:/Novel")
    expect(ledger).toEqual(emptyLedger())

    // 原始坏内容原样写入同目录 .novel 下的 .corrupt-<ISO时间戳> 副本
    expect(fsMocks.writeFileAtomic).toHaveBeenCalledTimes(1)
    const [copyPath, payload] = fsMocks.writeFileAtomic.mock.calls[0]
    expect(copyPath).toMatch(/^E:\/Novel\/\.novel\/projection-status\.corrupt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/)
    expect(payload).toBe(corruptRaw)
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

describe("F-005 append-only auditTrail (projection-status.json additive)", () => {
  // Global beforeEach only resets readFile — write mocks must be cleared here
  // so call-index assertions see only THIS test's writes.
  beforeEach(() => {
    fsMocks.writeFileAtomic.mockClear()
    fsMocks.createDirectory.mockClear()
  })

  const audit = (overrides: Partial<ProjectionAuditEntry> = {}): ProjectionAuditEntry => ({
    projection: "cognition",
    chapter: 7,
    status: "committed",
    durationMs: 12,
    timestamp: "2026-08-21T00:00:00.000Z",
    ...overrides,
  })

  it("空初始态：emptyLedger seeds auditTrail: [] and a legacy trail-less file loads as []", async () => {
    expect(emptyLedger().auditTrail).toEqual([])
    // Legacy pre-F-005 file without an auditTrail field.
    fsMocks.readFile.mockResolvedValue(JSON.stringify({ version: 1, chapters: {} }))
    const ledger = await loadProjectionStatusLedger("E:/Novel")
    expect(ledger.auditTrail).toEqual([])
  })

  it("单条追加：appends one entry into a legacy file WITHOUT dropping projections/chapters", async () => {
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({
        version: 1,
        projections: { cognition: "fold_rebuildable" },
        chapters: { "7": { cognition: { projection: "cognition", category: "fold_rebuildable", status: "committed", updated_at: "t", last_error: "" } } },
      }),
    )
    await appendProjectionAuditEntry("E:/Novel", audit())
    expect(fsMocks.createDirectory).toHaveBeenCalledWith("E:/Novel/.novel")
    const [path, payload] = fsMocks.writeFileAtomic.mock.calls[0]
    expect(String(path)).toBe("E:/Novel/.novel/projection-status.json")
    const doc = JSON.parse(payload as string)
    // Strictly additive — every pre-existing top-level field survives.
    expect(doc.version).toBe(1)
    expect(doc.projections.cognition).toBe("fold_rebuildable")
    expect(doc.chapters["7"].cognition.status).toBe("committed")
    expect(doc.auditTrail).toHaveLength(1)
    expect(doc.auditTrail[0]).toMatchObject({ projection: "cognition", chapter: 7, status: "committed", durationMs: 12 })
  })

  it("多条累积：sequential appends accumulate across reads/writes in order", async () => {
    // Simulate real persistence: each write becomes the next read's document.
    let doc: Record<string, unknown> = {}
    fsMocks.readFile.mockImplementation(async () => JSON.stringify(doc))
    fsMocks.writeFileAtomic.mockImplementation(async (_path: string, payload: string) => {
      doc = JSON.parse(payload)
    })
    await appendProjectionAuditEntry("E:/Novel", audit())
    await appendProjectionAuditEntry("E:/Novel", audit({ projection: "vector", chapter: 8 }))
    await appendProjectionAuditEntry("E:/Novel", audit({ projection: "graph_entity_pages", chapter: 8 }))
    const trail = (doc.auditTrail as ProjectionAuditEntry[])
    expect(trail).toHaveLength(3)
    expect(trail.map((e) => e.projection)).toEqual(["cognition", "vector", "graph_entity_pages"])
  })

  it("失败条目含 error：a failed event persists its error message verbatim", async () => {
    fsMocks.readFile.mockRejectedValue(new Error("ENOENT"))
    await appendProjectionAuditEntry(
      "E:/Novel",
      audit({ status: "failed", durationMs: 3400, error: "write failed: EACCES" }),
    )
    const payload = fsMocks.writeFileAtomic.mock.calls[0][1] as string
    const entry = JSON.parse(payload).auditTrail[0]
    expect(entry.status).toBe("failed")
    expect(entry.error).toBe("write failed: EACCES")
  })

  it("tolerates a corrupt ledger file (starts a fresh document, still appends)", async () => {
    fsMocks.readFile.mockResolvedValue("{{{not-json")
    await appendProjectionAuditEntry("E:/Novel", audit())
    const doc = JSON.parse(fsMocks.writeFileAtomic.mock.calls[0][1] as string)
    expect(doc.auditTrail).toHaveLength(1)
  })

  it("recordProjectionAudit accumulates in-memory so the end-of-loop save cannot clobber durable flushes", () => {
    let ledger: ProjectionStatusLedger = emptyLedger()
    ledger = recordProjectionAudit(ledger, audit())
    ledger = recordProjectionAudit(ledger, audit({ projection: "vector", status: "failed", error: "boom" }))
    expect(ledger.auditTrail).toHaveLength(2)
    expect(ledger.auditTrail?.[1].error).toBe("boom")
    // Pure — the source array is not mutated.
    expect(emptyLedger().auditTrail).toEqual([])
  })

  // ── C5 rolling window ───────────────────────────────────────────────────────
  it("C5: trimAuditTrail keeps the most recent N entries (tail-kept)", () => {
    const trail = [1, 2, 3, 4, 5].map((n) => audit({ chapter: n }))
    expect(trimAuditTrail(trail, 3)).toEqual([3, 4, 5].map((n) => audit({ chapter: n })))
    // Under-cap and undefined are returned unchanged.
    expect(trimAuditTrail(trail, 10)).toEqual(trail)
    expect(trimAuditTrail(undefined)).toEqual([])
  })

  it("C5: recordProjectionAudit trims at the cap via the shared trim", () => {
    let ledger: ProjectionStatusLedger = emptyLedger()
    for (let i = 1; i <= AUDIT_TRAIL_MAX_ENTRIES + 5; i++) {
      ledger = recordProjectionAudit(ledger, audit({ chapter: i }))
    }
    expect(ledger.auditTrail).toHaveLength(AUDIT_TRAIL_MAX_ENTRIES)
    // Tail kept: oldest dropped, newest present.
    expect(ledger.auditTrail?.[0].chapter).toBe(6)
    expect(ledger.auditTrail?.at(-1)?.chapter).toBe(AUDIT_TRAIL_MAX_ENTRIES + 5)
  })

  it("C5: appendProjectionAuditEntry trims the durable trail at the cap", async () => {
    const over = Array.from({ length: AUDIT_TRAIL_MAX_ENTRIES + 3 }, (_, i) => audit({ chapter: i + 1 }))
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({ projections: {}, chapters: [], auditTrail: over }),
    )
    await appendProjectionAuditEntry("E:/Novel", audit({ chapter: 999 }))
    const [writtenPath, contents] = fsMocks.writeFileAtomic.mock.calls.at(-1)!
    expect(writtenPath).toContain("projection-status.json")
    const doc = JSON.parse(contents) as { auditTrail: ProjectionAuditEntry[] }
    expect(doc.auditTrail).toHaveLength(AUDIT_TRAIL_MAX_ENTRIES)
    // Tail kept: the new entry is present, oldest dropped (503+1-500=4 dropped).
    expect(doc.auditTrail.at(-1)?.chapter).toBe(999)
    expect(doc.auditTrail[0].chapter).toBe(5)
  })

  it("C5: loadProjectionStatusLedger trims a legacy over-cap trail once on load", async () => {
    const over = Array.from({ length: AUDIT_TRAIL_MAX_ENTRIES + 20 }, (_, i) => audit({ chapter: i + 1 }))
    fsMocks.readFile.mockResolvedValue(
      JSON.stringify({ projections: {}, chapters: [{ number: 1 }], auditTrail: over }),
    )
    const ledger = await loadProjectionStatusLedger("E:/Pro")
    expect(ledger.auditTrail).toHaveLength(AUDIT_TRAIL_MAX_ENTRIES)
    expect(ledger.auditTrail?.[0].chapter).toBe(21)
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
