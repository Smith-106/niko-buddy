import { describe, expect, it } from "vitest"
import {
  buildEvidenceChainFromCed,
  buildEvidenceChainFromContinuity,
  buildEvidenceChainMixed,
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

  it("builds an empty node list when CED report has no evidence", () => {
    const report = {
      schemaVersion: "ced-report/1.0",
      wordCountEstimate: 0,
      densityPer10k: 0,
      totalFindings: 0,
      dimensions: {} as CedReport["dimensions"],
      productHardGate: false as const,
      summaryLine: "x",
    } as CedReport
    const chain = buildEvidenceChainFromCed(report)
    expect(chain.nodes).toEqual([])
    expect(chain.source).toBe("ced")
  })

  it("buildEvidenceChainMixed combines findings and CED nodes", () => {
    const findings = [
      {
        type: "overdue_thread",
        subtype: "consistency_mechanical",
        severity: "warning",
        ref: "subplot:key",
        message: "thread open",
        chapter: 3,
      },
    ] as ContinuityFinding[]
    const report = {
      schemaVersion: "ced-report/1.0",
      evidence: [
        {
          dimension: "timeline",
          type: "overdue_thread",
          severity: "warning",
          ref: "character:Bai",
          message: "missing",
          chapter: 4,
        },
      ],
    } as CedReport
    const chain = buildEvidenceChainMixed(findings, report, { generatedAt: "2026-08-10" })
    expect(chain.source).toBe("mixed")
    expect(chain.nodes).toHaveLength(2)
    expect(chain.generatedAt).toBe("2026-08-10")
    expect(chain.summaryLine).toContain("not accept blocker")
  })

  it("buildEvidenceChainMixed tolerates null or undefined report", () => {
    const findings = [
      {
        type: "overdue_thread",
        subtype: "consistency_mechanical",
        severity: "warning",
        ref: "subplot:key",
        message: "thread open",
        chapter: 3,
      },
    ] as ContinuityFinding[]
    const chain = buildEvidenceChainMixed(findings, null)
    expect(chain.nodes).toHaveLength(1)
    expect(chain.source).toBe("mixed")
  })

  it("creates same_ref edges for repeated refs and follows edges in chapter order", () => {
    const findings = [
      {
        type: "overdue_thread",
        subtype: "consistency_mechanical",
        severity: "warning",
        ref: "subplot:key",
        message: "open 1",
        chapter: 2,
      },
      {
        type: "overdue_thread",
        subtype: "consistency_mechanical",
        severity: "warning",
        ref: "subplot:key",
        message: "open 2",
        chapter: 2,
      },
      {
        type: "overdue_thread",
        subtype: "consistency_mechanical",
        severity: "warning",
        ref: "character:Bai",
        message: "missing",
        chapter: 2,
      },
    ] as ContinuityFinding[]
    const chain = buildEvidenceChainFromContinuity(findings)
    expect(chain.edges.some((e) => e.relation === "same_ref")).toBe(true)
    expect(chain.edges.filter((e) => e.relation === "follows").length).toBe(2)
    // 无 generatedAt 时回退到当前时间
    expect(chain.generatedAt).toBeTruthy()
  })

  it("exportEvidenceChainJson supports compact mode", () => {
    const findings = [
      {
        type: "overdue_thread",
        subtype: "consistency_mechanical",
        severity: "warning",
        ref: "subplot:key",
        message: "open",
        chapter: 3,
      },
    ] as ContinuityFinding[]
    const chain = buildEvidenceChainFromContinuity(findings)
    const compact = exportEvidenceChainJson(chain, false)
    expect(compact).not.toContain("\n")
  })
})
