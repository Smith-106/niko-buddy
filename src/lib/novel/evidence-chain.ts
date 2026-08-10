/**
 * Wave C — ConStory-style evidence chain export (audit / human inspect).
 *
 * Built from ContinuityFinding or CedEvidenceItem. Never an accept blocker.
 */
import type { ContinuityFinding } from "./deterministic-continuity-engine"
import type { CedEvidenceItem, CedReport } from "./ced-report"

export const EVIDENCE_CHAIN_SCHEMA = "evidence-chain/1.0" as const

export interface EvidenceChainNode {
  id: string
  kind: "claim"
  ref: string
  type: string
  severity: string
  message: string
  chapter: number
  dimension?: string
}

export interface EvidenceChainEdge {
  from: string
  to: string
  relation: "same_ref" | "same_chapter" | "follows"
}

export interface EvidenceChain {
  schemaVersion: typeof EVIDENCE_CHAIN_SCHEMA
  generatedAt: string
  source: "continuity" | "ced" | "mixed"
  nodes: EvidenceChainNode[]
  edges: EvidenceChainEdge[]
  /** Explicit: export is not a product gate. */
  productHardGate: false
  blocksAccept: false
  summaryLine: string
}

function nodeId(prefix: string, i: number, ref: string): string {
  return `${prefix}-${i}-${ref.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 40)}`
}

export function buildEvidenceChainFromContinuity(
  findings: readonly ContinuityFinding[],
  options?: { generatedAt?: string },
): EvidenceChain {
  const nodes: EvidenceChainNode[] = findings.map((f, i) => ({
    id: nodeId("c", i, f.ref),
    kind: "claim",
    ref: f.ref,
    type: f.type,
    severity: f.severity,
    message: f.message,
    chapter: f.chapter,
  }))
  return finalizeChain(nodes, "continuity", options?.generatedAt)
}

export function buildEvidenceChainFromCed(
  report: CedReport,
  options?: { generatedAt?: string },
): EvidenceChain {
  const nodes: EvidenceChainNode[] = (report.evidence ?? []).map((e: CedEvidenceItem, i) => ({
    id: nodeId("e", i, e.ref),
    kind: "claim",
    ref: e.ref,
    type: e.type,
    severity: e.severity,
    message: e.message,
    chapter: e.chapter,
    dimension: e.dimension,
  }))
  return finalizeChain(nodes, "ced", options?.generatedAt)
}

export function buildEvidenceChainMixed(
  findings: readonly ContinuityFinding[],
  report: CedReport | null | undefined,
  options?: { generatedAt?: string },
): EvidenceChain {
  const a = buildEvidenceChainFromContinuity(findings, options)
  const b = report ? buildEvidenceChainFromCed(report, options) : null
  const nodes = [...a.nodes, ...(b?.nodes ?? [])]
  return finalizeChain(nodes, "mixed", options?.generatedAt)
}

function finalizeChain(
  nodes: EvidenceChainNode[],
  source: EvidenceChain["source"],
  generatedAt?: string,
): EvidenceChain {
  const edges: EvidenceChainEdge[] = []
  // same_ref edges
  const byRef = new Map<string, string[]>()
  for (const n of nodes) {
    const list = byRef.get(n.ref) ?? []
    list.push(n.id)
    byRef.set(n.ref, list)
  }
  for (const ids of byRef.values()) {
    for (let i = 1; i < ids.length; i++) {
      edges.push({ from: ids[i - 1]!, to: ids[i]!, relation: "same_ref" })
    }
  }
  // chapter order follows for consecutive nodes
  const byChapter = [...nodes].sort((x, y) => x.chapter - y.chapter || x.id.localeCompare(y.id))
  for (let i = 1; i < byChapter.length; i++) {
    if (byChapter[i]!.chapter >= byChapter[i - 1]!.chapter) {
      edges.push({
        from: byChapter[i - 1]!.id,
        to: byChapter[i]!.id,
        relation: "follows",
      })
    }
  }

  return {
    schemaVersion: EVIDENCE_CHAIN_SCHEMA,
    generatedAt: generatedAt ?? new Date().toISOString(),
    source,
    nodes,
    edges,
    productHardGate: false,
    blocksAccept: false,
    summaryLine: `evidence-chain: n=${nodes.length} edges=${edges.length} source=${source}; export only; not accept blocker`,
  }
}

export function exportEvidenceChainJson(chain: EvidenceChain, pretty = true): string {
  return pretty ? JSON.stringify(chain, null, 2) : JSON.stringify(chain)
}
