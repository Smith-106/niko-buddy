/**
 * consensus-antigoals.gates.spec — R-1 共识六条反目标判定核测试。
 * 覆盖：AG1 上限三态 / AG2 期望值通过+逐 flag 漂移 / AG3 声称×豁免四组合 /
 * AG4 外部定义 / AG5 双护栏缺失组合 / AG6 基线豁免+扩容证据双门 / 文本扫描 /
 * 全清洁快照零违禁。判定顺序 AG1→AG6。
 *
 * @license MIT © QMAI
 */
import { describe, expect, it } from "vitest"
import {
  AG1_MAX_CORPUS_ENTRIES,
  ANTIGOAL_SNAPSHOT_SCHEMA,
  CORPUS_BASELINE_COUNT,
  EXPECTED_RETRIEVAL_FLAGS,
  checkAntigoals,
  scanConvergenceClaimText,
  type AntigoalSnapshot,
} from "./consensus-antigoals"

function cleanSnapshot(): AntigoalSnapshot {
  return {
    collectionCounts: { corpus: 6, craft: 12, lexicon: 38, tech: 69, world_ref: 8 },
    flags: { ...EXPECTED_RETRIEVAL_FLAGS },
    externalRetrievalDefs: [],
    convergenceClaims: [],
    evidence: { rerankTriggerEvidenceExists: false, sameScaleReportExists: false },
    ruleStackQualityGuardPresent: true,
    ruleStackPriorityOrderPresent: true,
  }
}

const ids = (snapshot: AntigoalSnapshot): string[] =>
  checkAntigoals(snapshot).map((violation) => violation.id)

describe("R-1 反目标判定核", () => {
  it("全清洁快照零违禁（现役基线：corpus 6 + 期望 flag + 双护栏具在）", () => {
    expect(checkAntigoals(cleanSnapshot())).toEqual([])
  })

  it("AG1：corpus 在上限内通过，超上限违禁并报数", () => {
    const atLimit = cleanSnapshot()
    atLimit.collectionCounts = { corpus: AG1_MAX_CORPUS_ENTRIES }
    // AG1 不违禁；但超基线触发 AG6（无证据面）——断言 AG1 不在其中。
    expect(ids(atLimit)).not.toContain("AG1")
    expect(ids(atLimit)).toContain("AG6")

    const over = cleanSnapshot()
    over.collectionCounts = { corpus: AG1_MAX_CORPUS_ENTRIES + 1 }
    expect(ids(over)).toContain("AG1")
    const violation = checkAntigoals(over).find((v) => v.id === "AG1")
    expect(violation?.detail).toContain(String(AG1_MAX_CORPUS_ENTRIES + 1))
  })

  it("AG2：期望默认值通过，逐 flag 漂移各报一项明细", () => {
    expect(ids(cleanSnapshot())).not.toContain("AG2")
    const drifted = cleanSnapshot()
    drifted.flags = { ...EXPECTED_RETRIEVAL_FLAGS, usefulnessRerankEnabled: true }
    expect(ids(drifted)).toEqual(["AG2"])
    const violation = checkAntigoals(drifted).find((v) => v.id === "AG2")
    expect(violation?.detail).toContain("usefulnessRerankEnabled=true")
  })

  it("AG2：三 flag 全漂移仍合并为单条 AG2（明细逐条列出）", () => {
    const drifted = cleanSnapshot()
    drifted.flags = {
      dualKbRoutingEnabled: true,
      hardInjectEnabled: false,
      usefulnessRerankEnabled: true,
    }
    const violations = checkAntigoals(drifted).filter((v) => v.id === "AG2")
    expect(violations).toHaveLength(1)
    expect(violations[0]?.detail).toContain("dualKbRoutingEnabled=true")
    expect(violations[0]?.detail).toContain("hardInjectEnabled=false")
  })

  it("AG3：有声称无豁免违禁，有豁免通过，无声称无关豁免", () => {
    const bare = cleanSnapshot()
    bare.convergenceClaims = [{ file: "docs/p0/x.md", hasClaim: true, hasExemption: false }]
    expect(ids(bare)).toEqual(["AG3"])

    const exempted = cleanSnapshot()
    exempted.convergenceClaims = [{ file: "docs/p0/x.md", hasClaim: true, hasExemption: true }]
    expect(ids(exempted)).not.toContain("AG3")

    const noClaim = cleanSnapshot()
    noClaim.convergenceClaims = [{ file: "docs/p0/x.md", hasClaim: false, hasExemption: false }]
    expect(ids(noClaim)).not.toContain("AG3")
  })

  it("AG3：多文件仅列出未豁免者", () => {
    const snapshot = cleanSnapshot()
    snapshot.convergenceClaims = [
      { file: "docs/p0/a.md", hasClaim: true, hasExemption: false },
      { file: "docs/p0/b.md", hasClaim: true, hasExemption: true },
      { file: "docs/p0/c.md", hasClaim: false, hasExemption: false },
    ]
    const violation = checkAntigoals(snapshot).find((v) => v.id === "AG3")
    expect(violation?.detail).toContain("docs/p0/a.md")
    expect(violation?.detail).not.toContain("docs/p0/b.md")
    expect(violation?.detail).not.toContain("docs/p0/c.md")
  })

  it("AG4：novel 外定义清单非空即违禁并列出文件", () => {
    const snapshot = cleanSnapshot()
    snapshot.externalRetrievalDefs = ["src/lib/search-clone.ts:rankByBm25"]
    expect(ids(snapshot)).toEqual(["AG4"])
    const violation = checkAntigoals(snapshot).find((v) => v.id === "AG4")
    expect(violation?.detail).toContain("src/lib/search-clone.ts:rankByBm25")
  })

  it("AG5：任一护栏缺失即违禁并指名缺失项", () => {
    const noGuard = cleanSnapshot()
    noGuard.ruleStackQualityGuardPresent = false
    expect(ids(noGuard)).toEqual(["AG5"])
    expect(checkAntigoals(noGuard).find((v) => v.id === "AG5")?.detail).toContain("永不短路")

    const noOrder = cleanSnapshot()
    noOrder.ruleStackPriorityOrderPresent = false
    expect(ids(noOrder)).toEqual(["AG5"])
    expect(checkAntigoals(noOrder).find((v) => v.id === "AG5")?.detail).toContain("GATE_PRIORITY_ORDER")
  })

  it(`AG6：corpus 在基线（${CORPUS_BASELINE_COUNT}）内无证据面也通过`, () => {
    const snapshot = cleanSnapshot()
    snapshot.collectionCounts = { corpus: CORPUS_BASELINE_COUNT }
    snapshot.evidence = { rerankTriggerEvidenceExists: false, sameScaleReportExists: false }
    expect(ids(snapshot)).not.toContain("AG6")
  })

  it("AG6：扩容后缺任一证据即违禁并指名缺失文件，双证据齐备通过", () => {
    const missingBoth = cleanSnapshot()
    missingBoth.collectionCounts = { corpus: CORPUS_BASELINE_COUNT + 1 }
    missingBoth.evidence = { rerankTriggerEvidenceExists: false, sameScaleReportExists: false }
    expect(ids(missingBoth)).toEqual(["AG6"])
    const bothDetail = checkAntigoals(missingBoth).find((v) => v.id === "AG6")?.detail ?? ""
    expect(bothDetail).toContain("R0-b")
    expect(bothDetail).toContain("同尺报告")

    const missingOne = cleanSnapshot()
    missingOne.collectionCounts = { corpus: CORPUS_BASELINE_COUNT + 1 }
    missingOne.evidence = { rerankTriggerEvidenceExists: true, sameScaleReportExists: false }
    expect(ids(missingOne)).toEqual(["AG6"])
    expect(checkAntigoals(missingOne).find((v) => v.id === "AG6")?.detail).toContain("同尺报告")

    const complete = cleanSnapshot()
    complete.collectionCounts = { corpus: CORPUS_BASELINE_COUNT + 1 }
    complete.evidence = { rerankTriggerEvidenceExists: true, sameScaleReportExists: true }
    expect(ids(complete)).not.toContain("AG6")
  })

  it("AG6：只看 corpus 集合，world_ref/lexicon 填空不触发扩容门", () => {
    const snapshot = cleanSnapshot()
    snapshot.collectionCounts = { corpus: 6, world_ref: 60, lexicon: 120 }
    snapshot.evidence = { rerankTriggerEvidenceExists: false, sameScaleReportExists: false }
    expect(ids(snapshot)).not.toContain("AG6")
  })

  it("快照 schema strict：未知字段视为契约违反", () => {
    const parsed = ANTIGOAL_SNAPSHOT_SCHEMA.safeParse({ ...cleanSnapshot(), unknownField: 1 })
    expect(parsed.success).toBe(false)
  })

  it("scanConvergenceClaimText：声称与豁免独立判定", () => {
    expect(scanConvergenceClaimText("本轮 top3 0.72，已达收敛结论")).toEqual({
      hasClaim: true,
      hasExemption: false,
    })
    expect(scanConvergenceClaimText("top3 0.72（同源回归口径，不可作收敛结论）")).toEqual({
      hasClaim: true,
      hasExemption: true,
    })
    expect(scanConvergenceClaimText("今日无事发生")).toEqual({ hasClaim: false, hasExemption: false })
  })

  it("判定顺序固定 AG1→AG6（多违禁时按序排列）", () => {
    const snapshot = cleanSnapshot()
    snapshot.collectionCounts = { corpus: AG1_MAX_CORPUS_ENTRIES + 1 }
    snapshot.flags = { ...EXPECTED_RETRIEVAL_FLAGS, dualKbRoutingEnabled: true }
    snapshot.externalRetrievalDefs = ["src/lib/x.ts:rankByBm25"]
    snapshot.ruleStackQualityGuardPresent = false
    expect(ids(snapshot)).toEqual(["AG1", "AG2", "AG4", "AG5", "AG6"])
  })
})
