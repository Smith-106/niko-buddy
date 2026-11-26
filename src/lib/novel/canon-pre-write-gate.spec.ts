import { describe, expect, it } from "vitest"
import {
  checkCanonPreWrite,
  DEFAULT_PRE_WRITE_GATE_MODE,
  preWriteIntervalsOverlap,
} from "./canon-pre-write-gate"

const edge = (
  id: string,
  opts: Partial<{
    sourceId: string
    targetId: string
    predicate: string
    digest: string
    validAt: number | null
    invalidAt: number | null
    modality: string | null
  }> = {},
) => ({
  id,
  sourceId: opts.sourceId ?? "src",
  targetId: opts.targetId ?? "tgt",
  predicate: opts.predicate ?? "rel",
  digest: opts.digest ?? "",
  validAt: opts.validAt ?? 1,
  invalidAt: opts.invalidAt ?? null,
  ...(opts.modality !== undefined ? { modality: opts.modality } : {}),
})

describe("53 P1-2 canon-pre-write-gate 四态", () => {
  it("preWriteIntervalsOverlap: 未封顶 vs 封顶（半开区间 [validAt, invalidAt)）", () => {
    expect(preWriteIntervalsOverlap({ validAt: 1, invalidAt: null }, { validAt: 2, invalidAt: 10 })).toBe(true)
    expect(preWriteIntervalsOverlap({ validAt: 10, invalidAt: null }, { validAt: 1, invalidAt: 10 })).toBe(false)
    expect(preWriteIntervalsOverlap({ validAt: 11, invalidAt: null }, { validAt: 1, invalidAt: 10 })).toBe(false)
  })

  it("preWriteIntervalsOverlap: 两端都封顶时半开区间严格 < 才重叠，空区间恒 false", () => {
    // 两个都带 invalidAt → 半开区间双向严格比较：aStart < bEnd && bStart < aEnd。
    expect(preWriteIntervalsOverlap({ validAt: 1, invalidAt: 10 }, { validAt: 5, invalidAt: 20 })).toBe(true)
    // 首尾相接（[1, 5) 与 [5, 9)）不重叠（半开区间口径）。
    expect(preWriteIntervalsOverlap({ validAt: 1, invalidAt: 5 }, { validAt: 5, invalidAt: 9 })).toBe(false)
    // 空区间（start >= end）恒 false。
    expect(preWriteIntervalsOverlap({ validAt: 5, invalidAt: 5 }, { validAt: 1, invalidAt: 10 })).toBe(false)
    expect(preWriteIntervalsOverlap({ validAt: 6, invalidAt: 3 }, { validAt: 1, invalidAt: 10 })).toBe(false)
    // 严格分离：a 在前且 b 的起点晚于 a 的终点 → 不重叠。
    expect(preWriteIntervalsOverlap({ validAt: 1, invalidAt: 5 }, { validAt: 6, invalidAt: 9 })).toBe(false)
    // 对称性：交换两侧结果不变（避免单向夹逼写错）。
    expect(preWriteIntervalsOverlap({ validAt: 6, invalidAt: 9 }, { validAt: 1, invalidAt: 5 })).toBe(false)
  })

  it("无冲突 → PASS", () => {
    const r = checkCanonPreWrite(
      { newEdges: [edge("n1", { sourceId: "A", predicate: "loves", targetId: "B" })], existingEdges: [] },
      { mode: "block" },
    )
    expect(r.state).toBe("PASS")
  })

  it("digest 相同且区间重叠 → DUPLICATE", () => {
    const r = checkCanonPreWrite(
      {
        newEdges: [edge("n1", { digest: "abc", validAt: 2 })],
        existingEdges: [edge("e1", { digest: "abc", validAt: 1 })],
      },
      { mode: "block" },
    )
    expect(r.state).toBe("DUPLICATE")
    expect(r.conflicts[0]!.reason).toContain("DUPLICATE")
  })

  it("同端点同 predicate 异值 + 重叠 → BLOCK (block 模式)", () => {
    const r = checkCanonPreWrite(
      {
        newEdges: [edge("n1", { sourceId: "A", predicate: "capital_of", targetId: "B", validAt: 2 })],
        existingEdges: [edge("e1", { sourceId: "A", predicate: "capital_of", targetId: "C", validAt: 1 })],
      },
      { mode: "block" },
    )
    expect(r.state).toBe("BLOCK")
    expect(r.conflicts[0]!.reason).toContain("L1 硬冲突")
  })

  it("warn-only 默认模式: BLOCK 降级 WARN 不拦截 (additive 零行为变更)", () => {
    const r = checkCanonPreWrite({
      newEdges: [edge("n1", { sourceId: "A", predicate: "capital_of", targetId: "B", validAt: 2 })],
      existingEdges: [edge("e1", { sourceId: "A", predicate: "capital_of", targetId: "C", validAt: 1 })],
    })
    expect(r.state).toBe("WARN")
    expect(DEFAULT_PRE_WRITE_GATE_MODE).toBe("warn")
  })

  it("非法 mode 值不提升拦截语义 (仅精确 \"block\" 硬拦; 其余一律降级 WARN)", () => {
    const r = checkCanonPreWrite(
      {
        newEdges: [edge("n1", { sourceId: "A", predicate: "capital_of", targetId: "B", validAt: 2 })],
        existingEdges: [edge("e1", { sourceId: "A", predicate: "capital_of", targetId: "C", validAt: 1 })],
      },
      { mode: "BLOCK" as never },
    )
    expect(r.state).toBe("WARN")
  })

  it("同端点同 predicate 异值但区间不重叠 → WARN (时态递进合法)", () => {
    const r = checkCanonPreWrite(
      {
        newEdges: [edge("n1", { sourceId: "A", predicate: "capital_of", targetId: "B", validAt: 15 })],
        existingEdges: [edge("e1", { sourceId: "A", predicate: "capital_of", targetId: "C", validAt: 1, invalidAt: 10 })],
      },
      { mode: "block" },
    )
    expect(r.state).toBe("WARN")
  })

  it("剧情反转 (新 predicate) 不触发 → PASS (宁漏勿误)", () => {
    const r = checkCanonPreWrite(
      {
        newEdges: [edge("n1", { sourceId: "A", predicate: "revived_by", targetId: "B", validAt: 2 })],
        existingEdges: [edge("e1", { sourceId: "A", predicate: "killed_by", targetId: "C", validAt: 1 })],
      },
      { mode: "block" },
    )
    expect(r.state).toBe("PASS")
  })

  it("R2-M01 非断言态豁免：新边或现存边为 belief/hypothesis 时跳过 BLOCK/WARN 矛盾判定", () => {
    const newBelief = checkCanonPreWrite(
      {
        newEdges: [edge("n1", { sourceId: "A", predicate: "capital_of", targetId: "B", validAt: 2, modality: "belief" })],
        existingEdges: [edge("e1", { sourceId: "A", predicate: "capital_of", targetId: "C", validAt: 1, modality: "assertive" })],
      },
      { mode: "block" },
    )
    expect(newBelief.state).toBe("PASS")
    expect(newBelief.conflicts).toEqual([])

    const existingHypothesis = checkCanonPreWrite(
      {
        newEdges: [edge("n1", { sourceId: "A", predicate: "capital_of", targetId: "B", validAt: 2, modality: "assertive" })],
        existingEdges: [edge("e1", { sourceId: "A", predicate: "capital_of", targetId: "C", validAt: 1, modality: "hypothesis" })],
      },
      { mode: "block" },
    )
    expect(existingHypothesis.state).toBe("PASS")
    expect(existingHypothesis.conflicts).toEqual([])
  })

  it("R2-M01 DUPLICATE 幂等去重对非断言模态仍保留", () => {
    const r = checkCanonPreWrite(
      {
        newEdges: [edge("n1", { digest: "mod-dup", validAt: 2, modality: "belief" })],
        existingEdges: [edge("e1", { digest: "mod-dup", validAt: 1, modality: "belief" })],
      },
      { mode: "block" },
    )
    expect(r.state).toBe("DUPLICATE")
    expect(r.conflicts[0]!.code).toBe("duplicate_digest_overlap")
  })

  it("R3-M07: 现存边与新边同 id 时跳过自比（不误报 BLOCK/WARN），同 digest 仍命中 DUPLICATE", () => {
    const selfUpdate = checkCanonPreWrite(
      {
        newEdges: [edge("same-id", { sourceId: "A", predicate: "capital_of", targetId: "B", digest: "d2", validAt: 2 })],
        existingEdges: [edge("same-id", { sourceId: "A", predicate: "capital_of", targetId: "C", digest: "d1", validAt: 1 })],
      },
      { mode: "block" },
    )
    expect(selfUpdate.state).toBe("PASS")
    expect(selfUpdate.conflicts).toEqual([])

    const selfReplay = checkCanonPreWrite(
      {
        newEdges: [edge("same-id", { sourceId: "A", predicate: "capital_of", targetId: "B", digest: "d1", validAt: 2 })],
        existingEdges: [edge("same-id", { sourceId: "A", predicate: "capital_of", targetId: "B", digest: "d1", validAt: 1 })],
      },
      { mode: "block" },
    )
    expect(selfReplay.state).toBe("DUPLICATE")
  })

  it("R3-M07: 同批次 newEdges 内部互检（单章自相矛盾 BLOCK / 同批次重复 DUPLICATE / 非重叠 WARN / belief 豁免）", () => {
    const batchBlock = checkCanonPreWrite(
      {
        newEdges: [
          edge("b1", { sourceId: "A", predicate: "capital_of", targetId: "B", digest: "d1", validAt: 5 }),
          edge("b2", { sourceId: "A", predicate: "capital_of", targetId: "C", digest: "d2", validAt: 5 }),
        ],
        existingEdges: [],
      },
      { mode: "block" },
    )
    expect(batchBlock.state).toBe("BLOCK")
    expect(batchBlock.conflicts).toHaveLength(1)
    expect(batchBlock.conflicts[0]!.code).toBe("block_endpoint_conflict")

    const batchDup = checkCanonPreWrite(
      {
        newEdges: [
          edge("b1", { sourceId: "A", predicate: "loves", targetId: "B", digest: "same-d", validAt: 5 }),
          edge("b2", { sourceId: "A", predicate: "loves", targetId: "B", digest: "same-d", validAt: 5 }),
        ],
        existingEdges: [],
      },
      { mode: "block" },
    )
    expect(batchDup.state).toBe("DUPLICATE")
    expect(batchDup.conflicts[0]!.code).toBe("duplicate_digest_overlap")

    const batchNonOverlapWarn = checkCanonPreWrite(
      {
        newEdges: [
          edge("b1", { sourceId: "A", predicate: "capital_of", targetId: "B", digest: "d1", validAt: 1, invalidAt: 5 }),
          edge("b2", { sourceId: "A", predicate: "capital_of", targetId: "C", digest: "d2", validAt: 6 }),
        ],
        existingEdges: [],
      },
      { mode: "block" },
    )
    expect(batchNonOverlapWarn.state).toBe("WARN")
    expect(batchNonOverlapWarn.conflicts[0]!.code).toBe("warn_temporal_advance")

    const batchBeliefExempt = checkCanonPreWrite(
      {
        newEdges: [
          edge("b1", { sourceId: "A", predicate: "capital_of", targetId: "B", digest: "d1", validAt: 5, modality: "belief" }),
          edge("b2", { sourceId: "A", predicate: "capital_of", targetId: "C", digest: "d2", validAt: 5, modality: "assertive" }),
        ],
        existingEdges: [],
      },
      { mode: "block" },
    )
    expect(batchBeliefExempt.state).toBe("PASS")
  })
})
