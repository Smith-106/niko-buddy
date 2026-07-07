import { describe, expect, it } from "vitest"
import {
  PROJECTION_CATEGORIES,
  emptyLedger,
  recordProjectionStatus,
  type ProjectionStatusLedger,
} from "./projection-status-ledger"
import { supersedeFact } from "./graph-adapter"

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
