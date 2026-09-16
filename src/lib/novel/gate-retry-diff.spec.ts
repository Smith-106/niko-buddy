/**
 * gate-retry-diff.spec — 波2-C 同门两 run EB-1 差分（含换模型轨迹）测试。
 * 覆盖：显式事件对差分（verdict/score/evidence/modelId 并列 + replayId 链）/
 * 换模型轨迹 / 自动取最近两 run / 跨 scope / 非法输入拒绝 / 单 run null。
 */
import { describe, expect, it } from "vitest"
import { appendRunEvents, createRunEventLedger, type RunEventInput } from "./run-event-ledger"
import { diffGateRunPair, diffLatestGateRetries, GateRetryDiffError } from "./gate-retry-diff"

const TS = "2026-09-16T00:00:00.000Z"

function gateRun(seq: number, gate: string, status: "pass" | "fail" | "skipped", extra?: Partial<RunEventInput>): RunEventInput {
  return {
    seq,
    eventId: `gate-run:${seq}:${gate}`,
    ts: TS,
    kind: "gate-run",
    actor: "system",
    replayId: `replay-${seq}`,
    payload: { gate, status },
    ...extra,
  }
}

describe("diffGateRunPair（显式事件对差分）", () => {
  it("verdict 翻转 + score 提升 + 证据增加；replayId 链并列", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "anti_ai", "fail", {
        modelId: "model-a",
        evidenceRefs: ["finding:1"],
        payload: { gate: "anti_ai", status: "fail", score: 6.5, findingsCount: 3 },
      }),
      gateRun(1, "anti_ai", "pass", {
        modelId: "model-a",
        evidenceRefs: ["finding:1", "finding:2", "finding:3"],
        payload: { gate: "anti_ai", status: "pass", score: 8.0, findingsCount: 0 },
      }),
    ])
    const events = ledger.events
    const diff = diffGateRunPair(events[0] as never, events[1] as never)
    expect(diff.gate).toBe("anti_ai")
    expect(diff.verdictChanged).toBe(true)
    expect(diff.scoreDelta).toBeCloseTo(1.5)
    expect(diff.evidenceDelta).toBe(2)
    expect(diff.modelSwapped).toBe(false)
    expect(diff.modelTrajectory).toEqual(["model-a", "model-a"])
    expect(diff.before.replayId).toBe("replay-0")
    expect(diff.after.replayId).toBe("replay-1")
    expect(diff.before.findingsCount).toBe(3)
  })

  it("换模型轨迹：model-a → model-b（routing 证据，swap-model 重试）", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "consistency", "fail", { modelId: "model-a" }),
      gateRun(1, "consistency", "pass", { modelId: "model-b" }),
    ])
    const diff = diffLatestGateRetries(ledger, "consistency")
    expect(diff?.modelSwapped).toBe(true)
    expect(diff?.modelTrajectory).toEqual(["model-a", "model-b"])
    expect(diff?.verdictChanged).toBe(true)
  })

  it("跨门事件对拒绝；乱序（after.seq<=before.seq）拒绝", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "anti_ai", "fail"),
      gateRun(1, "quality", "fail"),
    ])
    const events = ledger.events
    expect(() => diffGateRunPair(events[0] as never, events[1] as never)).toThrow(GateRetryDiffError)
    // 同门但乱序（after.seq<=before.seq）→ 全序拒绝
    const sameGate = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "anti_ai", "fail"),
      gateRun(1, "anti_ai", "pass"),
    ])
    const sameGateEvents = sameGate.events
    expect(() => diffGateRunPair(sameGateEvents[1] as never, sameGateEvents[0] as never)).toThrow(/账本全序/)
  })
})

describe("diffLatestGateRetries（自动取最近两 run）", () => {
  it("三门混流中取目标门最近两次；不足两次 → null", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "anti_ai", "fail", { modelId: "model-a" }),
      gateRun(1, "quality", "pass"),
      gateRun(2, "anti_ai", "pass", { modelId: "model-b" }),
      gateRun(3, "anti_ai", "pass", { modelId: "model-b" }),
    ])
    const diff = diffLatestGateRetries(ledger, "anti_ai")
    expect(diff?.before.eventId).toBe("gate-run:2:anti_ai")
    expect(diff?.after.eventId).toBe("gate-run:3:anti_ai")
    expect(diff?.verdictChanged).toBe(false)
    // quality 仅 1 次 run → 无可差分（null）
    expect(diffLatestGateRetries(ledger, "quality")).toBeNull()
    const empty = diffLatestGateRetries(createRunEventLedger(), "quality")
    expect(empty).toBeNull()
  })

  it("bookId scope 过滤：只差分同书运行", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateRun(0, "anti_ai", "fail", { bookId: "book-a", modelId: "model-a" }),
      gateRun(1, "anti_ai", "pass", { bookId: "book-b" }),
      gateRun(2, "anti_ai", "pass", { bookId: "book-a" }),
    ])
    const diff = diffLatestGateRetries(ledger, "anti_ai", { bookId: "book-a" })
    expect(diff?.before.replayId).toBe("replay-0")
    expect(diff?.after.replayId).toBe("replay-2")
    expect(diff?.modelSwapped).toBe(true)
  })
})