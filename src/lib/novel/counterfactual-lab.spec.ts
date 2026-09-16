/**
 * counterfactual-lab.spec — 波3-A 反事实重放通用化（任意门）测试。
 * 覆盖：任意门参数化裁定翻转 / 决定性 vs 非决定性分区 / 与 P0 专用版语义
 * 一致 / 事件落账（evidenceRefs 逐候选 + payload.counterfactual）/ ts 与
 * replayId 纪律 / 空候选平凡。
 */
import { describe, expect, it } from "vitest"
import { counterfactualGateEvents, CounterfactualLabError, replayCounterfactual } from "./counterfactual-lab"
import { appendRunEvents, createRunEventLedger, sliceRunEvents } from "./run-event-ledger"

const TS = "2026-09-16T00:00:00.000Z"

describe("replayCounterfactual（任意门通用化）", () => {
  it("P1 门同样可判：基线 pass，剔除某证据后 fail → 决定性", () => {
    const result = replayCounterfactual({
      gate: "anti_ai",
      baselineVerdict: "pass",
      candidates: [
        { removedSourceId: "evidence-1", verdictAfterRemoval: "fail" },
        { removedSourceId: "evidence-2", verdictAfterRemoval: "pass" },
      ],
    })
    expect(result.gate).toBe("anti_ai")
    expect(result.decisiveSourceIds).toEqual(["evidence-1"])
    expect(result.nonDecisiveSourceIds).toEqual(["evidence-2"])
  })

  it("与 P0 专用口径一致：剔除后翻转=决定性，不翻=非决定性（含 skipped 基线）", () => {
    const p0 = replayCounterfactual({
      gate: "consistency",
      baselineVerdict: "fail",
      candidates: [
        { removedSourceId: "src-a", verdictAfterRemoval: "pass" },
        { removedSourceId: "src-b", verdictAfterRemoval: "fail" },
      ],
    })
    expect(p0.decisiveSourceIds).toEqual(["src-a"])
    expect(p0.nonDecisiveSourceIds).toEqual(["src-b"])
    const skipped = replayCounterfactual({ gate: "quality", baselineVerdict: "skipped", candidates: [{ removedSourceId: "x", verdictAfterRemoval: "skipped" }] })
    expect(skipped.decisiveSourceIds).toHaveLength(0)
    expect(skipped.nonDecisiveSourceIds).toEqual(["x"])
  })

  it("空候选 → 双空集（平凡，不臆造）", () => {
    const result = replayCounterfactual({ gate: "quality", baselineVerdict: "pass", candidates: [] })
    expect(result.decisiveSourceIds).toHaveLength(0)
    expect(result.nonDecisiveSourceIds).toHaveLength(0)
  })
})

describe("counterfactualGateEvents（事件落账）", () => {
  it("kind=stage + payload.counterfactual + 逐候选 evidenceRefs 可点开 + replayId 透传", () => {
    const result = replayCounterfactual({
      gate: "consistency",
      baselineVerdict: "fail",
      candidates: [
        { removedSourceId: "src-a", verdictAfterRemoval: "pass" },
        { removedSourceId: "src-b", verdictAfterRemoval: "fail" },
      ],
    })
    const events = counterfactualGateEvents({ result, ts: TS, replayId: "replay-cf-1", chapterId: 3 })
    expect(events[0]?.kind).toBe("stage")
    expect(events[0]?.replayId).toBe("replay-cf-1")
    expect(events[0]?.chapterId).toBe(3)
    expect(events[0]?.evidenceRefs).toEqual([
      "counterfactual:consistency:decisive:src-a",
      "counterfactual:consistency:non-decisive:src-b",
    ])
    const payload = events[0]?.payload as { counterfactual?: { gate?: string; decisiveSourceIds?: string[] } }
    expect(payload.counterfactual?.gate).toBe("consistency")
    expect(payload.counterfactual?.decisiveSourceIds).toEqual(["src-a"])
  })

  it("空 ts / 空 replayId fail-loud（零时钟 + 可追溯纪律）", () => {
    const result = replayCounterfactual({ gate: "quality", baselineVerdict: "pass", candidates: [] })
    expect(() => counterfactualGateEvents({ result, ts: "", replayId: "r" })).toThrow(CounterfactualLabError)
    expect(() => counterfactualGateEvents({ result, ts: TS, replayId: "" })).toThrow(/replayId 为空/)
  })

  it("落账后可按 stage 切片回读（账本全链可追溯）", () => {
    const result = replayCounterfactual({
      gate: "anti_ai",
      baselineVerdict: "pass",
      candidates: [{ removedSourceId: "ev-9", verdictAfterRemoval: "fail" }],
    })
    const ledger = appendRunEvents(
      createRunEventLedger(),
      counterfactualGateEvents({ result, ts: TS, replayId: "replay-1" }).map((event, i) => ({ ...event, seq: i, eventId: `stage:${i}` }) as never),
    )
    const stages = sliceRunEvents(ledger, { kind: "stage" })
    expect(stages).toHaveLength(1)
    expect((stages[0]?.payload as { counterfactual?: { gate?: string } }).counterfactual?.gate).toBe("anti_ai")
  })
})