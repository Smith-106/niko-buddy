/**
 * eval-report.ts — F1 G1 骨架：Markdown 评测报告生成。
 */
import type { EvalRunResult, EvalCaseResult } from "./eval-schema"

/** 生成 Markdown 报告（含 digest 行，供证据链引用）。 */
export function renderEvalReport(result: EvalRunResult, digest?: string): string {
  const lines: string[] = []
  lines.push("# Eval Report")
  lines.push("")
  lines.push(`- Verdict: **${result.aggregate.verdict}** (overall=${result.aggregate.overall})`)
  lines.push(`- Cases: ${result.cases.length}`)
  if (digest) lines.push(`- Digest: \`${digest}\``)
  lines.push("")
  lines.push("## Layers")
  lines.push("")
  lines.push("| Layer | Pass | Score |")
  lines.push("|-------|------|-------|")
  for (const layer of ["L1", "L2", "L3"] as const) {
    const r = result.aggregate.layers[layer]
    lines.push(`| ${layer} | ${r.pass ? "PASS" : "FAIL"} | ${r.score.toFixed(4)} |`)
  }
  lines.push("")
  lines.push("## Cases")
  lines.push("")
  for (const c of result.cases) {
    lines.push(renderCaseRow(c))
  }
  return lines.join("\n")
}

function renderCaseRow(c: EvalCaseResult): string {
  const l1 = c.layers.L1.score.toFixed(4)
  const l2 = c.layers.L2.score.toFixed(4)
  const l3 = c.layers.L3.score.toFixed(4)
  return `- \`${c.caseId}\`: ${c.passed ? "PASS" : "FAIL"} (L1=${l1} L2=${l2} L3=${l3})`
}
