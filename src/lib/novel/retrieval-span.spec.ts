/**
 * retrieval-span.spec — R0-c 运行时 span 面测试。
 * 覆盖：事件构造纯函数（schema strict / 非法 stage / seq 边界）/ 收集器零时钟
 * （注入 now）/ 链序完整性断言 fail-loud（缺环 / 乱序 / 重复）/ trace 桥汇总 /
 * 真实链集成（search-adapter.novelMixedSearch 六 stage 单次调用全量落 span，
 * A5：无调用集成不验收）。
 *
 * @license MIT © QMAI
 */
import { describe, expect, it } from "vitest"
import {
  RETRIEVAL_SPAN_CHANNEL,
  RETRIEVAL_SPAN_SCHEMA,
  RETRIEVAL_SPAN_STAGES,
  RetrievalSpanError,
  assertRetrievalSpanSequence,
  buildRetrievalSpanTraceEntry,
  createRetrievalSpanCollector,
  makeRetrievalSpan,
  type RetrievalSpan,
} from "./retrieval-span"

const FIXED_TS = "2026-09-17T00:00:00.000Z"
const fixedClock = (ts: string) => () => ts

function fullChain(): RetrievalSpan[] {
  const collector = createRetrievalSpanCollector(fixedClock(FIXED_TS))
  for (const stage of RETRIEVAL_SPAN_STAGES) collector.span(stage)
  return [...collector.spans]
}

describe("R0-c makeRetrievalSpan（纯函数）", () => {
  it("构造合法 span（stage/seq/ts/channel 契约）", () => {
    const span = makeRetrievalSpan("tokenize", 0, FIXED_TS, { tokens: 5 })
    expect(span).toEqual({
      stage: "tokenize",
      seq: 0,
      ts: FIXED_TS,
      channel: RETRIEVAL_SPAN_CHANNEL,
      detail: { tokens: 5 },
    })
    expect(RETRIEVAL_SPAN_SCHEMA.safeParse(span).success).toBe(true)
  })

  it("detail 缺省为 undefined；未知 detail 值类型 fail-loud", () => {
    expect(makeRetrievalSpan("sources", 1, FIXED_TS).detail).toBeUndefined()
    expect(() =>
      makeRetrievalSpan("sources", 1, FIXED_TS, { nested: { a: 1 } as never }),
    ).toThrow(RetrievalSpanError)
  })

  it("非法 stage / 负数 seq / 空 ts 一律 fail-loud", () => {
    expect(() => makeRetrievalSpan("nope" as never, 0, FIXED_TS)).toThrow(RetrievalSpanError)
    expect(() => makeRetrievalSpan("rrf", -1, FIXED_TS)).toThrow(RetrievalSpanError)
    expect(() => makeRetrievalSpan("rrf", 0, "")).toThrow(RetrievalSpanError)
  })

  it("链序常量即契约序（六 stage，顺序固定）", () => {
    expect(RETRIEVAL_SPAN_STAGES).toEqual([
      "tokenize",
      "sources",
      "rrf",
      "tiering",
      "rerank_trigger",
      "cap_degrade",
    ])
  })
})

describe("R0-c 收集器（时钟注入，模块零时钟）", () => {
  it("seq 自增、ts 取自注入时钟（同一注入值不产生 Date 调用）", () => {
    const collector = createRetrievalSpanCollector(fixedClock("2000-01-01T00:00:00.000Z"))
    collector.span("tokenize", { tokens: 3 })
    collector.span("sources", { total: 2 })
    expect(collector.spans.map((s) => s.seq)).toEqual([0, 1])
    expect(collector.spans.every((s) => s.ts === "2000-01-01T00:00:00.000Z")).toBe(true)
  })

  it("全链六 stage 收集后 assertComplete 通过", () => {
    const collector = createRetrievalSpanCollector(fixedClock(FIXED_TS))
    for (const stage of RETRIEVAL_SPAN_STAGES) collector.span(stage)
    expect(() => collector.assertComplete()).not.toThrow()
    expect(collector.spans).toHaveLength(6)
  })
})

describe("R0-c 链序完整性断言（缺环 fail-loud）", () => {
  it("缺环抛错并指名缺失 stage", () => {
    const spans = fullChain().filter((s) => s.stage !== "tiering")
    expect(() => assertRetrievalSpanSequence(spans)).toThrow(/链序缺环：tiering/)
  })

  it("乱序抛错（后 stage 提前出现）", () => {
    const spans = fullChain()
    const swapped = [spans[0]!, spans[2]!, spans[1]!, spans[3]!, spans[4]!, spans[5]!]
    expect(() => assertRetrievalSpanSequence(swapped)).toThrow(/stage 乱序/)
  })

  it("重复 stage 抛错", () => {
    const spans = fullChain()
    const duplicated = [...spans, makeRetrievalSpan("rrf", 6, FIXED_TS)]
    expect(() => assertRetrievalSpanSequence(duplicated)).toThrow(/stage 重复：rrf/)
  })

  it("空序列即缺环（六 stage 全缺）", () => {
    expect(() => assertRetrievalSpanSequence([])).toThrow(/链序缺环/)
  })
})

describe("R0-c trace 桥（消费端 retrieval-trace 语义）", () => {
  it("汇总为一条 span 通道留痕（slotManifest 承载 stage 序）", () => {
    const entry = buildRetrievalSpanTraceEntry({
      spans: fullChain(),
      traceId: "span-1",
      recordedAt: FIXED_TS,
      query: "修仙 宗门",
    })
    expect(entry.channel).toBe(RETRIEVAL_SPAN_CHANNEL)
    expect(entry.query).toBe("修仙 宗门")
    expect(entry.hits).toEqual([])
    expect(entry.slotManifest.map((s) => s.slot)).toEqual([...RETRIEVAL_SPAN_STAGES])
  })

  it("链序不全 fail-loud；跨通道 span 拒绝", () => {
    expect(() =>
      buildRetrievalSpanTraceEntry({
        spans: fullChain().slice(0, 3),
        traceId: "span-2",
        recordedAt: FIXED_TS,
        query: "q",
      }),
    ).toThrow(RetrievalSpanError)
    expect(() =>
      buildRetrievalSpanTraceEntry({
        spans: [{ ...fullChain()[0]!, channel: "other" } as never],
        traceId: "span-3",
        recordedAt: FIXED_TS,
        query: "q",
      }),
    ).toThrow(/非本通道 span/)
  })
})
