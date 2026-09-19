/**
 * evidence-snapshot.spec.ts — EB-1 证据链快照 spec 锁定.
 *
 * 覆盖: 三门卡片（GATE_PRIORITY_ORDER 序/未落事件=未发生 hasEvent=false）+
 * 覆盖率与血缘率（无 LLM 中介门=null）+ budgetCost 聚合 + 库健康透传 +
 * 「被 P0 阻塞」语义（blocked/blockingGate）.
 *
 * @license MIT © Niko Buddy
 */

import { describe, expect, it } from "vitest"
import { buildEvidenceSnapshot } from "./evidence-snapshot"
import { createRunEventLedger, recordGateRunEvents, appendRunEvents, type RunEventInput } from "./run-event-ledger"
import { buildLibraryArtifact, type LibraryHealthReport } from "./asset-library"

function stageEvent(seq: number): RunEventInput {
  return { seq, eventId: `e${seq}`, ts: "2026-09-12T00:00:00.000Z", kind: "stage", actor: "system" }
}

describe("buildEvidenceSnapshot（EB-1 数据层）", () => {
  it("三门卡片按 P0>P1>P2 序；未落事件门 hasEvent=false 且 display=not_evaluated", () => {
    let ledger = createRunEventLedger()
    ledger = recordGateRunEvents(
      ledger,
      [{ gate: "consistency", status: "fail", score: 40 }],
      { ts: "2026-09-12T01:00:00.000Z", modelId: "m1", replayId: "rp-1", promptArtifactId: "pa", promptArtifactVersion: "1.0.0", evidenceRefs: ["a", "b"] },
    )
    const snapshot = buildEvidenceSnapshot({
      gateStatuses: { consistency: "fail", anti_ai: "pass", quality: undefined },
      ledger,
    })
    expect(snapshot.cards.map((c) => c.gate)).toEqual(["consistency", "anti_ai", "quality"])
    const p0 = snapshot.cards[0]
    expect(p0.display).toBe("fail")
    expect(p0.label).toBe("未通过")
    expect(p0.score).toBe(40)
    expect(p0.evidenceCount).toBe(2)
    expect(p0.replayId).toBe("rp-1")
    expect(p0.modelId).toBe("m1")
    expect(p0.promptArtifact).toBe("pa@1.0.0")
    expect(p0.hasEvent).toBe(true)
    // anti_ai 有裁定但未落事件 → 未发生
    const p1 = snapshot.cards[1]
    expect(p1.hasEvent).toBe(false)
    expect(p1.display).toBe("not_evaluated")
    // quality 无裁定无事件
    expect(snapshot.cards[2].display).toBe("not_evaluated")
  })

  it("覆盖率：两门落账一门未落 → 2/3；无 LLM 中介门 → 血缘率 null", () => {
    let ledger = createRunEventLedger()
    ledger = recordGateRunEvents(ledger, [{ gate: "consistency", status: "pass" }, { gate: "anti_ai", status: "pass" }], {
      ts: "2026-09-12T01:00:00.000Z",
    })
    const snapshot = buildEvidenceSnapshot({
      gateStatuses: { consistency: "pass", anti_ai: "pass", quality: "pass" },
      ledger,
    })
    expect(snapshot.gateEventCoverage).toBeCloseTo(2 / 3)
    expect(snapshot.promptLineageRate).toBeNull()
  })

  it("LLM 中介门血缘率透传（带血缘事件占比）", () => {
    let ledger = createRunEventLedger()
    ledger = appendRunEvents(ledger, [
      {
        seq: 0,
        eventId: "g0",
        ts: "2026-09-12T01:00:00.000Z",
        kind: "gate-run",
        actor: "judge",
        promptArtifactId: "pa",
        promptArtifactVersion: "1.0.0",
        payload: { gate: "consistency", status: "pass", llmMediated: true },
      },
      { seq: 1, eventId: "e1", ts: "2026-09-12T00:00:00.000Z", kind: "stage", actor: "system" },
    ])
    const snapshot = buildEvidenceSnapshot({
      gateStatuses: { consistency: "pass", anti_ai: "pass", quality: "pass" },
      ledger,
    })
    expect(snapshot.promptLineageRate).toBe(1)
    expect(snapshot.budgetCost.eventsCounted).toBe(0)
  })

  it("成本归因聚合 + 库健康透传", () => {
    let ledger = createRunEventLedger()
    ledger = appendRunEvents(ledger, [
      { ...stageEvent(0), budgetCost: { tokens: 120, wallclockMs: 900, calls: 1 } },
    ])
    const artifact = buildLibraryArtifact({
      libraryId: "genre_base",
      generatorVersion: "g",
      generatedAt: "t",
      entries: [{ entryId: "g-1", name: "n", toneTags: [], forbidPatterns: [], plotBeats: [] }],
    })
    const report: LibraryHealthReport = { libraryId: artifact.libraryId, healthy: true, violations: [], entryCount: 1 }
    const snapshot = buildEvidenceSnapshot({
      gateStatuses: { consistency: "pass", anti_ai: "pass", quality: "pass" },
      ledger,
      libraryReports: [report],
    })
    expect(snapshot.budgetCost.tokens).toBe(120)
    expect(snapshot.budgetCost.wallclockMs).toBe(900)
    expect(snapshot.libraryHealth).toEqual([{ libraryId: "genre_base", healthy: true, violations: 0 }])
  })

  it("「被 P0 阻塞」语义：fail 门 → blocked=true + blockingGate=P0（不显示高分高亮）", () => {
    let ledger = createRunEventLedger()
    ledger = recordGateRunEvents(ledger, [{ gate: "consistency", status: "fail" }], {
      ts: "2026-09-12T01:00:00.000Z",
    })
    const snapshot = buildEvidenceSnapshot({
      gateStatuses: { consistency: "fail", anti_ai: "pass", quality: "pass" },
      ledger,
    })
    expect(snapshot.blocked).toBe(true)
    expect(snapshot.blockingGate).toBe("consistency")
  })

  it("空账本 + 无裁定 → 全 NOT_EVALUATED + blocked=false（未评估不是失败）", () => {
    const snapshot = buildEvidenceSnapshot({
      gateStatuses: { consistency: undefined, anti_ai: undefined, quality: undefined },
      ledger: createRunEventLedger(),
    })
    expect(snapshot.cards.every((c) => c.display === "not_evaluated" && !c.hasEvent)).toBe(true)
    expect(snapshot.blocked).toBe(false)
    expect(snapshot.blockingGate).toBeNull()
    expect(snapshot.gateEventCoverage).toBe(1)
  })
})