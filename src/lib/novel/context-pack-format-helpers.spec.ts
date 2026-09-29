// @vitest-environment node
// MIT License - Copyright (c) 2026 Niko Buddy Contributors
// SPDX-License-Identifier: MIT
//
// context-pack-format-helpers.spec — F4-4（Round-4 评估）拆分产物单测：
// narrativeVisibilitySummary / extractSceneCharacters /
// applySectionCharBudget / charsPerTokenOfPack（与 context-engine
// 内联实现语义逐字一致，已 brace-match diff 校验）。

import { describe, expect, it } from "vitest"
import {
  applySectionCharBudget,
  charsPerTokenOfPack,
  extractSceneCharacters,
  narrativeVisibilitySummary,
} from "./context-pack-format-helpers"
import type { ContextPack } from "./context-engine"

describe("narrativeVisibilitySummary (F4-4 split)", () => {
  it("null / 无声明 → 空串", () => {
    expect(narrativeVisibilitySummary(null)).toBe("")
    expect(narrativeVisibilitySummary({ declarations: [] } as never)).toBe("")
  })

  it("已知声明按角色汇总", () => {
    const out = narrativeVisibilitySummary({
      declarations: [{ id: "d1" }, { id: "d2" }],
      visibilities: [
        { characterId: "甲", state: "known" },
        { characterId: "甲", state: "known" },
        { characterId: "乙", state: "unknown" },
      ],
    } as never)
    expect(out).toContain("叙事声明共 2 条")
    expect(out).toContain("- 甲 视角可见 2 条")
    expect(out).not.toContain("乙")
  })
})

describe("extractSceneCharacters (F4-4 split)", () => {
  it("双源拼接 \\n\\n；空输入 → 空串", () => {
    expect(extractSceneCharacters({})).toBe("")
    expect(
      extractSceneCharacters({
        snapshots: { characterStates: "甲：在场" },
        fallbackCharacterStates: "乙：在场",
      }),
    ).toBe("甲：在场\n\n乙：在场")
  })
})

describe("applySectionCharBudget (F4-4 split)", () => {
  it("null → 空串；无预算 → 原样", () => {
    expect(applySectionCharBudget(null, 10)).toBe("")
    expect(applySectionCharBudget("abc", undefined)).toBe("abc")
    expect(applySectionCharBudget("abc", 0)).toBe("abc")
  })

  it("字符串超预算截断加 …；数组按配额逐项", () => {
    expect(applySectionCharBudget("abcdef", 3)).toBe("abc…")
    expect(applySectionCharBudget(["ab", "cdef"], 4)).toEqual(["ab", "cd…"])
  })
})

describe("charsPerTokenOfPack (F4-4 split)", () => {
  it("纯 ASCII ≈ 4；纯 CJK ≈ 1.5；退化输入不 NaN", () => {
    expect(charsPerTokenOfPack({ task: "hello world" } as unknown as ContextPack)).toBeCloseTo(4, 0)
    expect(charsPerTokenOfPack({ task: "甲乙丙丁戊己庚辛壬癸子丑".repeat(20) } as unknown as ContextPack)).toBeLessThan(2)
    const r = charsPerTokenOfPack({} as unknown as ContextPack)
    expect(Number.isFinite(r)).toBe(true)
    expect(r).toBeGreaterThan(0)
  })
})
