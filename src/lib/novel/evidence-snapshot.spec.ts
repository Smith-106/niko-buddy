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
import { buildChapterGateRunEvents, MAIN_CONTROL_RERUN_INTENT } from "./deep-chapter-gate-evidence"

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

describe("防污染（B3）：草稿复核 gate-run 不得成为卡片归因来源", () => {
  const FORMAL_TS = "2026-10-18T00:00:00.000Z"
  const DRAFT_TS = "2026-10-18T00:10:00.000Z"

  function threeGates(status: "passed" | "failed"): Parameters<typeof buildChapterGateRunEvents>[0]["decisionGates"] {
    return {
      consistency: { status, verdict: status === "failed" ? "fail" : "pass", findings: [], repair_suggestions: [], retry_count: 0, updated_at: FORMAL_TS },
      anti_ai: { status, verdict: status === "failed" ? "fail" : "pass", findings: [], repair_suggestions: [], retry_count: 0, updated_at: FORMAL_TS },
      quality: { status, verdict: status === "failed" ? "fail" : "pass", findings: [], repair_suggestions: [], retry_count: 0, updated_at: FORMAL_TS },
      overall: status === "failed" ? "fail" : "pass",
    } as unknown as Parameters<typeof buildChapterGateRunEvents>[0]["decisionGates"]
  }

  /** 正式章 pass（t0）+ 未采纳草稿重跑 fail（t1）的账本。 */
  function pollutedLedger() {
    const formal = buildChapterGateRunEvents({ projectPath: "/p", decisionGates: threeGates("passed"), chapterNumber: 3 })
    const rerun = buildChapterGateRunEvents({
      projectPath: "/p",
      decisionGates: threeGates("failed"),
      chapterNumber: 3,
      intent: MAIN_CONTROL_RERUN_INTENT,
    })
    let ledger = appendRunEvents(
      createRunEventLedger(),
      formal.map(
        (event, index) =>
          ({ ...event, ts: FORMAL_TS, seq: index, eventId: `formal:${index}`, replayId: "rp-formal", modelId: "model-formal" }) as RunEventInput,
      ),
    )
    ledger = appendRunEvents(
      ledger,
      rerun.map(
        (event, index) =>
          ({
            ...event,
            ts: DRAFT_TS,
            seq: index + 3,
            eventId: `draft:${index}`,
            replayId: "rp-draft",
            modelId: "model-draft",
          }) as RunEventInput,
      ),
    )
    return ledger
  }

  it("display 与 ts/replayId/modelId/evidenceCount 同一条权威事件（不拼接草稿归因）", () => {
    const snapshot = buildEvidenceSnapshot({
      gateStatuses: { consistency: "pass", anti_ai: "pass", quality: "pass" },
      ledger: pollutedLedger(),
    })
    for (const card of snapshot.cards) {
      expect(card).toMatchObject({
        display: "pass",
        ts: FORMAL_TS,
        replayId: "rp-formal",
        modelId: "model-formal",
        hasEvent: true,
        // 正式章事件只带 chapter:3；草稿事件额外带 intent ref，不得混入权威证据数
        evidenceCount: 1,
      })
    }
    expect(snapshot.blocked).toBe(false)
    expect(snapshot.blockingGate).toBeNull()
  })

  it("display 以账本权威事件为准（外部门状态与账本不一致时不给假结论）", () => {
    // 只落了正式章 fail，调用方却声称三门全 pass（如自行派生且未过滤）
    const ledger = appendRunEvents(
      createRunEventLedger(),
      [{ seq: 0, eventId: "g0", ts: FORMAL_TS, kind: "gate-run", actor: "system", payload: { gate: "consistency", status: "fail" } }],
    )
    const snapshot = buildEvidenceSnapshot({
      gateStatuses: { consistency: "pass", anti_ai: "pass", quality: "pass" },
      ledger,
    })
    expect(snapshot.cards[0]).toMatchObject({ gate: "consistency", display: "fail", ts: FORMAL_TS })
    expect(snapshot.blocked).toBe(true)
    expect(snapshot.blockingGate).toBe("consistency")
  })

  it("覆盖率/血缘率同源：草稿复核落的三门 gate-run 不算「本门已留证」", () => {
    // 只有草稿复核落了事件（正式章未落）→ 三门仍未留证
    const rerun = buildChapterGateRunEvents({
      projectPath: "/p",
      decisionGates: threeGates("passed"),
      chapterNumber: 3,
      intent: MAIN_CONTROL_RERUN_INTENT,
    })
    const ledger = appendRunEvents(
      createRunEventLedger(),
      rerun.map((event, index) => ({ ...event, ts: DRAFT_TS, seq: index, eventId: `d:${index}` }) as RunEventInput),
    )
    const snapshot = buildEvidenceSnapshot({
      gateStatuses: { consistency: "pass", anti_ai: "pass", quality: "pass" },
      ledger,
    })
    expect(snapshot.gateEventCoverage).toBe(0)
    expect(snapshot.cards.every((card) => !card.hasEvent && card.display === "not_evaluated")).toBe(true)
    expect(snapshot.blocked).toBe(false)
  })
})