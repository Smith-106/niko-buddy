import { describe, expect, it } from "vitest"
import {
  buildEvidenceChainFromCed,
  buildEvidenceChainFromContinuity,
  exportEvidenceChainJson,
} from "./evidence-chain"
import type { ContinuityFinding } from "./deterministic-continuity-engine"
import type { CedReport } from "./ced-report"

describe("evidence-chain", () => {
  it("builds chain from continuity findings", () => {
    const findings = [
      {
        type: "overdue_thread",
        subtype: "consistency_mechanical",
        severity: "warning",
        ref: "subplot:key",
        message: "thread open",
        chapter: 3,
      },
      {
        type: "absent_character",
        subtype: "consistency_mechanical",
        severity: "info",
        ref: "character:Bai",
        message: "missing",
        chapter: 4,
      },
    ] as ContinuityFinding[]
    const chain = buildEvidenceChainFromContinuity(findings, {
      generatedAt: "2026-08-10T00:00:00.000Z",
    })
    expect(chain.nodes).toHaveLength(2)
    expect(chain.productHardGate).toBe(false)
    expect(chain.blocksAccept).toBe(false)
    const json = exportEvidenceChainJson(chain)
    expect(json).toContain("evidence-chain/1.0")
    expect(json).toContain("subplot:key")
  })

  it("builds from CED evidence", () => {
    const report = {
      schemaVersion: "ced-report/1.0",
      wordCountEstimate: 1000,
      densityPer10k: 1,
      totalFindings: 1,
      dimensions: {} as CedReport["dimensions"],
      evidence: [
        {
          dimension: "timeline",
          type: "overdue_thread",
          severity: "warning",
          ref: "subplot:key",
          message: "open",
          chapter: 2,
        },
      ],
      productHardGate: false as const,
      summaryLine: "x",
    } as CedReport
    const chain = buildEvidenceChainFromCed(report)
    expect(chain.source).toBe("ced")
    expect(chain.nodes[0]?.dimension).toBe("timeline")
  })
})
