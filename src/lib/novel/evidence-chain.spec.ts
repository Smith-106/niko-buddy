import { describe, expect, it } from "vitest"
import {
  buildEvidenceChainFromCed,
  buildEvidenceChainFromContinuity,
  buildEvidenceChainMixed,
  exportEvidenceChainJson,
  appendEvidenceVerification,
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

describe("appendEvidenceVerification（F-001 举证核验挂链）", () => {
  const baseChain = () =>
    buildEvidenceChainFromContinuity(
      [
        {
          type: "overdue_thread",
          subtype: "consistency_mechanical",
          severity: "warning",
          ref: "subplot:key",
          message: "thread open",
          chapter: 3,
        },
      ] as ContinuityFinding[],
      { generatedAt: "2026-08-10T00:00:00.000Z" },
    )

  it("核验通过 → 追加 info 级 claim 节点（不可变，不改原链）", () => {
    const chain = baseChain()
    const out = appendEvidenceVerification(
      chain,
      {
        passed: true,
        originalEvidence: "他把剑收回鞘中。",
        resolvedEvidence: "他把剑收回鞘中。",
        matchType: "verbatim",
      },
      { ref: "issue:12", chapter: 7 },
    )

    expect(chain.nodes).toHaveLength(1) // 原链未被改写
    expect(out.nodes).toHaveLength(2)
    const node = out.nodes[1]!
    expect(node).toMatchObject({
      kind: "claim",
      ref: "issue:12",
      type: "evidence_verification",
      severity: "info",
      chapter: 7,
      dimension: "evidence_verification",
    })
    expect(node.message).toContain("evidence citation verified")
    expect(node.message).toContain("verbatim")
    expect(out.summaryLine).toContain("n=2")
    expect(out.blocksAccept).toBe(false)
    expect(out.productHardGate).toBe(false)
  })

  it("核验失败 → warning 级 + fallback 文案；缺省 ref/chapter 落 evidence-verify/0", () => {
    const out = appendEvidenceVerification(baseChain(), {
      passed: false,
      originalEvidence: "雨夜里有人敲门。",
      resolvedEvidence: "雨夜。",
      matchType: "fallback",
    })
    const node = out.nodes[out.nodes.length - 1]!
    expect(node).toMatchObject({ severity: "warning", ref: "evidence-verify", chapter: 0 })
    expect(node.message).toContain("evidence citation fallback")
    expect(node.message).toContain("雨夜。")
  })
})
