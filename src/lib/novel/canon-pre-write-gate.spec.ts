import { describe, expect, it } from "vitest"
import {
  checkCanonPreWrite,
  DEFAULT_PRE_WRITE_GATE_MODE,
  preWriteIntervalsOverlap,
} from "./canon-pre-write-gate"

const edge = (id: string, opts: Partial<{ sourceId: string; targetId: string; predicate: string; digest: string; validAt: number | null; invalidAt: number | null }> = {}) => ({
  id,
  sourceId: opts.sourceId ?? "src",
  targetId: opts.targetId ?? "tgt",
  predicate: opts.predicate ?? "rel",
  digest: opts.digest ?? "",
  validAt: opts.validAt ?? 1,
  invalidAt: opts.invalidAt ?? null,
})

describe("53 P1-2 canon-pre-write-gate 四态", () => {
  it("preWriteIntervalsOverlap: 未封顶 vs 封顶", () => {
    expect(preWriteIntervalsOverlap({ validAt: 1, invalidAt: null }, { validAt: 2, invalidAt: 10 })).toBe(true)
    expect(preWriteIntervalsOverlap({ validAt: 11, invalidAt: null }, { validAt: 1, invalidAt: 10 })).toBe(false)
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
})
