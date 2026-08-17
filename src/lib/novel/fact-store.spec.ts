import { describe, expect, it, vi } from "vitest"
import { createInMemoryFactStore, type FactEvent } from "./fact-store"

function makeEvent(overrides: Partial<FactEvent> = {}): FactEvent {
  return {
    fact_id: "fact-1",
    from: "candidate",
    to: "verified",
    fact_batch_id: "batch-1",
    ...overrides,
  }
}

describe("createInMemoryFactStore", () => {
  it("appends events with an auto timestamp when at is absent", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-09T12:00:00Z"))
    const store = createInMemoryFactStore()
    store.append(makeEvent())
    const timeline = store.timeline("fact-1")
    expect(timeline).toHaveLength(1)
    expect(timeline[0]).toMatchObject({ fact_id: "fact-1", from: "candidate", to: "verified" })
    expect(timeline[0]!.at).toBe(new Date("2026-06-09T12:00:00Z").getTime())
    vi.useRealTimers()
  })

  it("preserves an explicitly provided at timestamp", () => {
    const store = createInMemoryFactStore()
    store.append(makeEvent({ at: 12345 }))
    expect(store.timeline("fact-1")[0]!.at).toBe(12345)
  })

  it("timeline filters events by fact_id", () => {
    const store = createInMemoryFactStore()
    store.append(makeEvent({ fact_id: "fact-1", at: 1 }))
    store.append(makeEvent({ fact_id: "fact-2", at: 2 }))
    store.append(makeEvent({ fact_id: "fact-1", at: 3 }))
    expect(store.timeline("fact-1").map((e) => e.at)).toEqual([1, 3])
    expect(store.timeline("fact-2").map((e) => e.at)).toEqual([2])
    expect(store.timeline("fact-missing")).toEqual([])
  })

  it("batch filters events by fact_batch_id", () => {
    const store = createInMemoryFactStore()
    store.append(makeEvent({ fact_id: "fact-1", fact_batch_id: "batch-a", at: 1 }))
    store.append(makeEvent({ fact_id: "fact-2", fact_batch_id: "batch-a", at: 2 }))
    store.append(makeEvent({ fact_id: "fact-3", fact_batch_id: "batch-b", at: 3 }))
    expect(store.batch("batch-a").map((e) => e.fact_id)).toEqual(["fact-1", "fact-2"])
    expect(store.batch("batch-b").map((e) => e.fact_id)).toEqual(["fact-3"])
    expect(store.batch("missing")).toEqual([])
  })
})
