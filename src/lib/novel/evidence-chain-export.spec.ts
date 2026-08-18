import { describe, expect, it } from "vitest"
import { exportEvidenceChainForReview } from "./evidence-chain-export"
import { computeCedReport } from "./ced-report"
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

  it("auto mode: findings + ced → mixed chain", () => {
    const findings = [
      { type: "data_gap", subtype: "data_gap", severity: "info", message: "缺 lastSeenChapter", ref: "ch:2", chapter: 2 },
    ] as ContinuityFinding[]
    const ced = computeCedReport({ findings, textForWordCount: "正文" })
    const r = exportEvidenceChainForReview({ findings, ced })
    expect(r.chain.source).toBe("mixed")
    expect(r.chain.nodes.length).toBeGreaterThan(0)
  })

  it("auto mode: ced only → ced chain", () => {
    const ced = computeCedReport({
      findings: [
        {
          type: "data_gap",
          subtype: "data_gap",
          severity: "info",
          message: "缺 lastSeenChapter",
          ref: "ch:2",
          chapter: 2,
          missingField: "lastSeenChapter",
        },
      ],
      textForWordCount: "正文",
    })
    const r = exportEvidenceChainForReview({ ced })
    expect(r.chain.source).toBe("ced")
    expect(r.chain.nodes.length).toBeGreaterThan(0)
  })

  it("auto mode: findings only / empty input → continuity chain", () => {
    const findings = [
      { type: "dormant_thread", subtype: "consistency_mechanical", severity: "warning", message: "线头搁置", ref: "ch:5", chapter: 5 },
    ] as ContinuityFinding[]
    const r1 = exportEvidenceChainForReview({ findings })
    expect(r1.chain.source).toBe("continuity")
    // input.findings ?? [] 左分支
    const r2 = exportEvidenceChainForReview({})
    expect(r2.chain.source).toBe("continuity")
  })

  it("explicit source modes win over auto detection", () => {
    const findings = [
      { type: "absent_character", subtype: "consistency_mechanical", severity: "warning", message: "缺角色", ref: "ch:7", chapter: 7 },
    ] as ContinuityFinding[]
    const ced = computeCedReport({ findings, textForWordCount: "正文" })
    expect(exportEvidenceChainForReview({ findings, ced, source: "continuity" }).chain.source).toBe("continuity")
    expect(exportEvidenceChainForReview({ findings, ced, source: "ced" }).chain.source).toBe("ced")
    expect(exportEvidenceChainForReview({ findings, ced, source: "mixed" }).chain.source).toBe("mixed")
    expect(exportEvidenceChainForReview({ findings, ced, source: "auto" }).chain.source).toBe("mixed")
  })

  it("pretty:false serializes compact JSON", () => {
    const r = exportEvidenceChainForReview({ ced: computeCedReport({ findings: [] }), pretty: false })
    expect(r.json).not.toContain("\n  ")
  })
})
