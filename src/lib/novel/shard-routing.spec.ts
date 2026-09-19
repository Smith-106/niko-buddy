/**
 * shard-routing.spec.ts — B3-a 分片路由与归并（批准计划 r3 §T5）。
 *
 * 断言面：
 *   1. 等价性：省略分片（不调用）等价单片 `key="none"`（保序）→ JSON 字节相等；
 *   2. 确定性：同一输入多次运行输出序列一致（含 tie-break）；
 *   3. 片内选择：不给 perShardTopK 保序；给出则 (relevance desc, path asc) 截断；
 *   4. 归并策略：shard-major（首现去重）/ score-major（全局分序去重）；
 *   5. 边界：空集 / 单元素 / 空片 / 缺键（unknown）/ 非法 perShardTopK fail-loud。
 *
 * @license MIT © Niko Buddy
 */
import { describe, expect, it } from "vitest"
import {
  SHARD_RECALL_SPEC_SCHEMA,
  ShardRoutingError,
  applyShardRecall,
  mergeShards,
  resolveShards,
  selectShardItems,
  type ShardableItem,
} from "./shard-routing"

const item = (type: string, path: string, relevance: number, collection?: string): ShardableItem & { type: string } => ({
  type,
  path,
  relevance,
  ...(collection ? { collection } : {}),
})

const SAMPLE: Array<ShardableItem & { type: string }> = [
  item("keyword", "a.md", 0.5),
  item("vector", "b.md", 0.9),
  item("keyword", "c.md", 0.5),
  item("canon", "d.md", 0.1),
  item("vector", "a.md", 0.7), // 跨片同 path（去重面）
]

describe("B3-a 分片路由（resolveShards / selectShardItems）", () => {
  it("key=none → 单片且严格保序（等价性基线）", () => {
    const shards = resolveShards(SAMPLE, "none")
    expect(shards).toHaveLength(1)
    expect(shards[0]!.key).toBe("none")
    expect(shards[0]!.items.map((i) => `${i.type}:${i.path}`)).toEqual(
      SAMPLE.map((i) => `${i.type}:${i.path}`),
    )
    // 不给上限 → 保序（不排序）：与输入 JSON 字节相等
    const selected = selectShardItems(shards[0]!)
    expect(JSON.stringify(mergeShards([selected]))).toBe(JSON.stringify(SAMPLE))
  })

  it("key=type → 按首现顺序分片、片内保序", () => {
    const shards = resolveShards(SAMPLE, "type")
    expect(shards.map((s) => s.key)).toEqual(["keyword", "vector", "canon"])
    expect(shards[0]!.items.map((i) => i.path)).toEqual(["a.md", "c.md"])
    expect(shards[1]!.items.map((i) => i.path)).toEqual(["b.md", "a.md"])
  })

  it("key=collection → 缺键归入 unknown（不丢弃）", () => {
    const shards = resolveShards(
      [item("keyword", "x.md", 1, "world_ref"), item("keyword", "y.md", 1), item("keyword", "z.md", 1, "lexicon")],
      "collection",
    )
    expect(shards.map((s) => s.key)).toEqual(["world_ref", "unknown", "lexicon"])
    expect(shards.reduce((n, s) => n + s.items.length, 0)).toBe(3)
  })

  it("片内选择：给出 perShardTopK → (relevance desc, path asc) 截断；平局按 path 升序", () => {
    const shard = resolveShards(SAMPLE, "type")[0]! // keyword: a(0.5) c(0.5)
    const selected = selectShardItems(shard, 1)
    expect(selected.items.map((i) => i.path)).toEqual(["a.md"])
    const tied = selectShardItems(
      { key: "k", items: [item("keyword", "zz.md", 0.5), item("keyword", "aa.md", 0.5)] },
      2,
    )
    expect(tied.items.map((i) => i.path)).toEqual(["aa.md", "zz.md"])
  })

  it("边界：空集 / 单元素 / 非法 perShardTopK fail-loud", () => {
    expect(resolveShards([], "type")).toEqual([])
    expect(applyShardRecall([], { key: "type" }).outputCount).toBe(0)
    expect(applyShardRecall([item("keyword", "solo.md", 1)], { key: "type" }).items).toHaveLength(1)
    expect(() => selectShardItems({ key: "k", items: [item("keyword", "a.md", 1)] }, 0)).toThrow(
      ShardRoutingError,
    )
    expect(() => applyShardRecall(SAMPLE, { key: "nope" as never })).toThrow(ShardRoutingError)
    expect(() => applyShardRecall(SAMPLE, { key: "type", extra: 1 } as never)).toThrow(ShardRoutingError)
  })
})

describe("B3-a 跨片确定性归并（mergeShards / applyShardRecall）", () => {
  it("shard-major（默认）：分片首现顺序拼接 + 跨片去重按 type+path", () => {
    const merged = applyShardRecall(SAMPLE, { key: "type" })
    expect(merged.policy).toBe("shard-major")
    // keyword: a,c → vector: b,a（同 path 不同源，保留）→ canon: d
    expect(merged.items.map((i) => `${i.type}:${i.path}`)).toEqual([
      "keyword:a.md",
      "keyword:c.md",
      "vector:b.md",
      "vector:a.md",
      "canon:d.md",
    ])
    expect(merged.shardCount).toBe(3)
    expect(merged.shardKeys).toEqual(["keyword", "vector", "canon"])
    expect(merged.inputCount).toBe(5)
    expect(merged.outputCount).toBe(5)
  })

  it("cross-shard dedupe：同 type+path 重复项只保留首现（shard-major）", () => {
    const dupes = [item("keyword", "a.md", 0.5), item("vector", "b.md", 0.9), item("keyword", "a.md", 0.2)]
    const merged = applyShardRecall(dupes, { key: "type" })
    expect(merged.outputCount).toBe(2)
    expect(merged.items.map((i) => `${i.type}:${i.path}:${i.relevance}`)).toEqual([
      "keyword:a.md:0.5",
      "vector:b.md:0.9",
    ])
  })

  it("score-major：全局 (relevance desc, path asc)，跨片去重保留最高分", () => {
    const merged = applyShardRecall(SAMPLE, { key: "type", policy: "score-major" })
    expect(merged.items.map((i) => `${i.type}:${i.path}`)).toEqual([
      "vector:b.md", // 0.9
      "vector:a.md", // 0.7
      "keyword:a.md", // 0.5（同分按 path 升序，a.md 先于 c.md）
      "keyword:c.md", // 0.5
      "canon:d.md", // 0.1
    ])
    expect(merged.outputCount).toBe(5)
  })

  it("确定性：同一输入多次运行输出序列一致（含 tie-break 与去重）", () => {
    const runs = Array.from({ length: 5 }, () =>
      JSON.stringify(applyShardRecall(SAMPLE, { key: "type", perShardTopK: 1 }).items),
    )
    expect(new Set(runs).size).toBe(1)
    const shuffled = [SAMPLE[3]!, SAMPLE[1]!, SAMPLE[0]!, SAMPLE[4]!, SAMPLE[2]!]
    const a = JSON.stringify(mergeShards(resolveShards(shuffled, "type").map((s) => selectShardItems(s, 1))))
    const b = JSON.stringify(mergeShards(resolveShards(shuffled, "type").map((s) => selectShardItems(s, 1))))
    expect(a).toBe(b)
  })

  it("perShardTopK 生效：每片最多保留上限条（预算面可观测）", () => {
    const merged = applyShardRecall(SAMPLE, { key: "type", perShardTopK: 1 })
    expect(merged.perShardTopK).toBe(1)
    expect(merged.items.map((i) => `${i.type}:${i.path}`)).toEqual([
      "keyword:a.md",
      "vector:b.md",
      "canon:d.md",
    ])
    expect(merged.outputCount).toBe(3)
  })

  it("规格 schema：strict（非法键/未知字段/非法上限一律拒绝）", () => {
    expect(SHARD_RECALL_SPEC_SCHEMA.safeParse({ key: "type", perShardTopK: 2 }).success).toBe(true)
    expect(SHARD_RECALL_SPEC_SCHEMA.safeParse({ key: "type", perShardTopK: 0 }).success).toBe(false)
    expect(SHARD_RECALL_SPEC_SCHEMA.safeParse({ key: "type", perShardTopK: 1.5 }).success).toBe(false)
    expect(SHARD_RECALL_SPEC_SCHEMA.safeParse({ key: "type", policy: "nope" }).success).toBe(false)
    expect(SHARD_RECALL_SPEC_SCHEMA.safeParse({ key: "type", nope: 1 }).success).toBe(false)
  })
})
