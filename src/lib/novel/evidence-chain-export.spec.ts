import { describe, expect, it } from "vitest"
import { exportEvidenceChainForReview } from "./evidence-chain-export"
import type { ContinuityFinding } from "./deterministic-continuity-engine"

describe("evidence-chain-export (S5)", () => {
  it("exports JSON without accept block", () => {
    const findings = [
      {
        type: "overdue_thread",
        subtype: "consistency_mechanical",
        severity: "warning",
        message: "时序疑点",
        ref: "ch:3",
        chapter: 3,
      },
    ] as ContinuityFinding[]
    const r = exportEvidenceChainForReview({ findings, pretty: true })
    expect(r.productHardGate).toBe(false)
    expect(r.blocksAccept).toBe(false)
    expect(r.chain.nodes.length).toBe(1)
    expect(r.json).toContain("evidence-chain")
    expect(JSON.parse(r.json).blocksAccept).toBe(false)
  })
})
