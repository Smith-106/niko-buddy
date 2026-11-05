import { describe, expect, it } from "vitest"
import { renderEvalReport } from "./eval-report"
import type { EvalCaseResult, EvalRunResult, LayerResult } from "./eval-schema"

function layer(name: "L1" | "L2" | "L3", pass: boolean, score: number): LayerResult {
  return { layer: name, pass, score, detail: {} }
}

function caseResult(caseId: string, passed: boolean, scores: [number, number, number]): EvalCaseResult {
  return {
    caseId,
    passed,
    layers: {
      L1: layer("L1", scores[0] >= 0.95, scores[0]),
      L2: layer("L2", scores[1] >= 0.99, scores[1]),
      L3: layer("L3", scores[2] < 0.01, scores[2]),
    },
    rejections: [],
  }
}

function runResult(aggregate: EvalRunResult["aggregate"], cases: EvalCaseResult[]): EvalRunResult {
  return {
    config: { replayOnlyFailed: true, thresholds: { l1Min: 0.95, l2Min: 0.99, l3Max: 0.01 } },
    cases,
    aggregate,
  }
}

describe("renderEvalReport", () => {
  it("全通过报告含表头、digest、层表格与用例行（分数保留 4 位小数）", () => {
    const result = runResult(
      {
        overall: true,
        layers: { L1: layer("L1", true, 0.95678), L2: layer("L2", true, 1), L3: layer("L3", true, 0) },
        verdict: "PASS",
      },
      [
        caseResult("case-1", true, [0.95, 1, 0]),
        caseResult("case-2", false, [0.5, 0.5, 1]),
      ],
    )

    const report = renderEvalReport(result, "deadbeef")

    const lines = report.split("\n")
    expect(lines[0]).toBe("# Eval Report")
    expect(report).toContain("- Verdict: **PASS** (overall=true)")
    expect(report).toContain("- Cases: 2")
    expect(report).toContain("- Digest: `deadbeef`")
    expect(report).toContain("## Layers")
    expect(report).toContain("| L1 | PASS | 0.9568 |")
    expect(report).toContain("| L2 | PASS | 1.0000 |")
    expect(report).toContain("| L3 | PASS | 0.0000 |")
    expect(report).toContain("## Cases")
    expect(report).toContain("- `case-1`: PASS (L1=0.9500 L2=1.0000 L3=0.0000)")
    expect(report).toContain("- `case-2`: FAIL (L1=0.5000 L2=0.5000 L3=1.0000)")
  })

  it("无 digest 时不输出 Digest 行", () => {
    const result = runResult(
      {
        overall: true,
        layers: { L1: layer("L1", true, 1), L2: layer("L2", true, 1), L3: layer("L3", true, 0) },
        verdict: "PASS",
      },
      [],
    )

    const report = renderEvalReport(result)

    expect(report).toContain("- Cases: 0")
    expect(report).not.toContain("Digest")
  })

  it("失败聚合输出 FAIL  verdict 与 FAIL 层行/用例行", () => {
    const result = runResult(
      {
        overall: false,
        layers: { L1: layer("L1", true, 1), L2: layer("L2", false, 0.5), L3: layer("L3", false, 0.5) },
        verdict: "FAIL",
      },
      [caseResult("case-9", false, [1, 0.5, 0.5])],
    )

    const report = renderEvalReport(result, "abc123")

    expect(report).toContain("- Verdict: **FAIL** (overall=false)")
    expect(report).toContain("| L2 | FAIL | 0.5000 |")
    expect(report).toContain("| L3 | FAIL | 0.5000 |")
    expect(report).toContain("- `case-9`: FAIL (L1=1.0000 L2=0.5000 L3=0.5000)")
    expect(report).toContain("- Digest: `abc123`")
  })
})
