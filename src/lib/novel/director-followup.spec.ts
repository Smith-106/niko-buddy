/**
 * director-followup.spec — 波2-B 模块 19 导演跟进数据层测试。
 * 覆盖：阻塞队列 P0→P1→P2 + blockedBy 传染 / 空账本空队列 / staleness 传递
 * 闭包确定性 / 重跑成本聚合（budgetCost 证据）+ 无历史 null 不臆造 / 快照组合。
 */
import { describe, expect, it } from "vitest"
import {
  appendRunEvents,
  createRunEventLedger,
  recordGateRunEvents,
  type RunEventInput,
} from "./run-event-ledger"
import {
  buildBlockingQueue,
  buildDirectorFollowupSnapshot,
  estimateRerunCost,
  propagateStaleness,
} from "./director-followup"

const TS = "2026-09-16T00:00:00.000Z"

function gateEvent(seq: number, gate: string, status: "pass" | "fail" | "skipped", extra?: Partial<RunEventInput>): RunEventInput {
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

describe("buildBlockingQueue（P0→P1→P2 阻塞队列）", () => {
  it("P0+P1 fail → P0 首位无 blocker；P1 被 P0 阻塞（门序传染）", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateEvent(0, "consistency", "fail"),
      gateEvent(1, "anti_ai", "fail"),
    ])
    const queue = buildBlockingQueue(ledger)
    expect(queue).toHaveLength(2)
    expect(queue[0]).toMatchObject({ gate: "consistency", priority: 0, blockedBy: null, replayId: "replay-0" })
    expect(queue[1]).toMatchObject({ gate: "anti_ai", priority: 1, blockedBy: "consistency" })
  })

  it("P0 fail 短路后 P1/P2 skipped → 队列只含 P0（skipped 非 fail 不入队）", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateEvent(0, "consistency", "fail"),
      gateEvent(1, "anti_ai", "skipped"),
      gateEvent(2, "quality", "skipped"),
    ])
    const queue = buildBlockingQueue(ledger)
    expect(queue).toHaveLength(1)
    expect(queue[0]?.gate).toBe("consistency")
  })

  it("全 pass / 空账本 → 空队列（未落事件=未发生）", () => {
    const passLedger = appendRunEvents(createRunEventLedger(), [
      gateEvent(0, "consistency", "pass"),
      gateEvent(1, "anti_ai", "pass"),
    ])
    expect(buildBlockingQueue(passLedger)).toHaveLength(0)
    expect(buildBlockingQueue(createRunEventLedger())).toHaveLength(0)
  })

  it("最近一次运行生效：先 fail 后 pass 的门不入队", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateEvent(0, "consistency", "fail"),
      gateEvent(1, "anti_ai", "fail"),
      gateEvent(2, "consistency", "pass"),
    ])
    const queue = buildBlockingQueue(ledger)
    expect(queue.map((i) => i.gate)).toEqual(["anti_ai"])
    expect(queue[0]?.blockedBy).toBeNull()
  })
})

describe("propagateStaleness（传染闭包）", () => {
  it("上游变更 → 直接+间接下游全 stale（传递闭包）；变更方自身不在结果内", () => {
    const stale = propagateStaleness(
      [
        { upstream: "world_sample", downstream: "chapter_draft" },
        { upstream: "chapter_draft", downstream: "review_result" },
        { upstream: "chapter_draft", downstream: "aura_seeds" },
      ],
      ["world_sample"],
    )
    expect(stale).toEqual(["chapter_draft", "review_result", "aura_seeds"])
  })

  it("无变更 → 空；环不无限传播（visited 收口）；输入乱序输出确定", () => {
    expect(propagateStaleness([{ upstream: "a", downstream: "a" }], [])).toEqual([])
    const cyc = [
      { upstream: "a", downstream: "b" },
      { upstream: "b", downstream: "a" },
      { upstream: "b", downstream: "c" },
    ]
    expect(propagateStaleness(cyc, ["a"])).toEqual(["b", "c"])
    expect(propagateStaleness([{ upstream: "x", downstream: "y" }], ["x"])).toEqual(["y"])
  })
})

describe("estimateRerunCost（重跑成本预估）", () => {
  it("budgetCost 聚合：tokens/wallclock/calls 累计 + eventsCounted 可点开", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateEvent(0, "consistency", "fail", { budgetCost: { tokens: 100, wallclockMs: 2000, calls: 1 } }),
      gateEvent(1, "consistency", "pass", { budgetCost: { tokens: 50, wallclockMs: 1000, calls: 1 } }),
      gateEvent(2, "anti_ai", "pass"),
    ])
    const costs = estimateRerunCost(ledger, ["consistency", "anti_ai"])
    expect(costs[0]).toMatchObject({ gate: "consistency", tokens: 150, wallclockMs: 3000, calls: 2, eventsCounted: 2 })
    // anti_ai 有事件但无 budgetCost → null 不臆造（eventsCounted=0）
    expect(costs[1]).toMatchObject({ gate: "anti_ai", tokens: null, wallclockMs: null, calls: null, eventsCounted: 0 })
  })

  it("无任何事件 → 全 null（不臆造数字）", () => {
    const costs = estimateRerunCost(createRunEventLedger(), ["consistency", "anti_ai", "quality"])
    for (const c of costs) {
      expect(c.tokens).toBeNull()
      expect(c.wallclockMs).toBeNull()
      expect(c.calls).toBeNull()
      expect(c.eventsCounted).toBe(0)
    }
  })
})

describe("buildDirectorFollowupSnapshot（快照组合）", () => {
  it("队列 + 传染 + 成本一次组合；重跑门序缺省三门", () => {
    const ledger = appendRunEvents(createRunEventLedger(), [
      gateEvent(0, "consistency", "fail", { budgetCost: { tokens: 80, wallclockMs: 1500, calls: 1 } }),
    ])
    const snapshot = buildDirectorFollowupSnapshot({
      ledger,
      edges: [{ upstream: "world_sample", downstream: "chapter_draft" }],
      changedArtifacts: ["world_sample"],
    })
    expect(snapshot.queue.map((i) => i.gate)).toEqual(["consistency"])
    expect(snapshot.stale).toEqual(["chapter_draft"])
    expect(snapshot.rerunCost).toHaveLength(3)
    expect(snapshot.rerunCost[0]).toMatchObject({ gate: "consistency", tokens: 80 })
    expect(snapshot.rerunCost[1]?.tokens).toBeNull()
  })

  it("recordGateRunEvents 产出的账本同样可推导（波2-A 门链联动）", () => {
    const outcomes = [
      { gate: "consistency" as const, status: "fail" as const, findingsCount: 2, escalatedCount: 0, score: null },
      { gate: "anti_ai" as const, status: "skipped" as const, findingsCount: 0, escalatedCount: 0, score: null },
      { gate: "quality" as const, status: "skipped" as const, findingsCount: 0, escalatedCount: 0, score: null },
    ]
    const ledger = recordGateRunEvents(createRunEventLedger(), outcomes, { ts: TS, replayId: "replay-x" })
    const snapshot = buildDirectorFollowupSnapshot({ ledger })
    expect(snapshot.queue).toHaveLength(1)
    expect(snapshot.queue[0]).toMatchObject({ gate: "consistency", replayId: "replay-x", priority: 0 })
  })
})