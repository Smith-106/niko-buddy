/**
 * S5 — evidence-chain export entry for review side (not accept binder).
 */
import type { ContinuityFinding } from "./deterministic-continuity-engine"
import type { CedReport } from "./ced-report"
import {
  buildEvidenceChainFromCed,
  buildEvidenceChainFromContinuity,
  buildEvidenceChainMixed,
  exportEvidenceChainJson,
  type EvidenceChain,
} from "./evidence-chain"

export interface ExportEvidenceChainInput {
  findings?: readonly ContinuityFinding[]
  ced?: CedReport | null
  source?: "continuity" | "ced" | "mixed" | "auto"
  pretty?: boolean
  generatedAt?: string
}

export interface ExportEvidenceChainResult {
  chain: EvidenceChain
  json: string
  productHardGate: false
  blocksAccept: false
}

/**
 * Build + serialize evidence chain for human/audit download.
 * Never blocks accept; never product hard gate.
 */
export function exportEvidenceChainForReview(input: ExportEvidenceChainInput): ExportEvidenceChainResult {
  const findings = input.findings ?? []
  const ced = input.ced
  const mode =
    input.source === "auto" || !input.source
      ? findings.length && ced
        ? "mixed"
        : ced
          ? "ced"
          : "continuity"
      : input.source

  let chain: EvidenceChain
  if (mode === "ced" && ced) {
    chain = buildEvidenceChainFromCed(ced, { generatedAt: input.generatedAt })
  } else if (mode === "mixed") {
    chain = buildEvidenceChainMixed(findings, ced, { generatedAt: input.generatedAt })
  } else {
    chain = buildEvidenceChainFromContinuity(findings, { generatedAt: input.generatedAt })
  }

  return {
    chain,
    json: exportEvidenceChainJson(chain, input.pretty !== false),
    productHardGate: false,
    blocksAccept: false,
  }
}
