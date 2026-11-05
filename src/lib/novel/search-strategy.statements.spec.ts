/**
 * search-strategy.statements.spec.ts — 覆盖率战役增量（branches 尾段）。
 *
 * 只补既有 search-strategy(.branch).spec.ts 未触达的分支边：
 *   charShingleJaccard 的「单侧空 shingle 集」形态 —— A 侧分块为空（文本短于
 *   shingle 宽度）、B 侧非空，此时不得被 both-empty 短路吞掉，必须走 jaccard
 *   的 `setA.size === 0` 左侧求值（相似度 0，绝不误判为同义）。
 *
 * @license MIT © Niko Buddy
 */

import { describe, expect, it } from "vitest"

import { charShingleJaccard, getCharShingles } from "./search-strategy"

describe("search-strategy / charShingleJaccard 单侧空分块", () => {
  it("短于 shingle 宽度的 A 侧 → 空集，与 B 侧无交集得 0", () => {
    expect(getCharShingles("x", 2).size).toBe(0)
    expect(charShingleJaccard("x", "xyz")).toBe(0)
    expect(charShingleJaccard("xyz", "x")).toBe(0)
  })

  it("空串 A 侧同样走零相似（不退化成 1）", () => {
    expect(charShingleJaccard("", "轩辕剑")).toBe(0)
  })

  it("双侧都有分块时仍按 jaccard 比例（正向对照）", () => {
    // {轩辕} vs {轩辕, 辕剑} → 交集 1，并集 2
    expect(charShingleJaccard("轩辕", "轩辕剑")).toBeCloseTo(0.5, 10)
  })
})
