/**
 * related-chapters.statements.spec.ts — 覆盖率战役增量（statements/branches 尾段）。
 *
 * 只补既有 related-chapters.spec.ts 未触达的行为面：
 *   - recentCast 的同末章 + 同出场数完全平局 → 第三级 tie-break（角色名升序）
 *   - recentCast 对「尚无出场章」角色的 lastSeenChapter/appearanceCount 归零语义
 *     （空数组不走 Math.max，避免 -Infinity 污染排序）
 *
 * @license MIT © Niko Buddy
 */

import { describe, expect, it } from "vitest"

import { recentCast, type CharacterAppearance } from "./related-chapters"

function app(character: string, chapters: number[]): CharacterAppearance {
  return { character, chapters }
}

describe("related-chapters / recentCast 完全平局 tie-break", () => {
  it("同末章 + 同出场数 → 按角色名升序（输入乱序也确定）", () => {
    const cast = recentCast([app("c", [5]), app("a", [5]), app("b", [5])])
    expect(cast.map((c) => c.character)).toEqual(["a", "b", "c"])
    expect(cast.every((c) => c.lastSeenChapter === 5 && c.appearanceCount === 1)).toBe(true)
  })

  it("平局集合内的 limit 裁剪取名字序前 N（不依赖输入顺序）", () => {
    const cast = recentCast([app("z", [9]), app("m", [9]), app("q", [9])], 2)
    expect(cast.map((c) => c.character)).toEqual(["m", "q"])
  })

  it("同名重复条目 → 比较器返回 0，保持输入顺序（稳定排序，不丢条目）", () => {
    const cast = recentCast([app("白砚", [7]), app("白砚", [7]), app("苏晩", [7])])
    expect(cast.map((c) => c.character)).toEqual(["白砚", "白砚", "苏晩"])
    expect(cast).toHaveLength(3)
  })
})

describe("related-chapters / recentCast 无出场章角色", () => {
  it("chapters 为空 → lastSeenChapter 0 / appearanceCount 0，排在已有出场者之后", () => {
    const cast = recentCast([app("未登场", []), app("白砚", [3])])
    expect(cast.map((c) => c.character)).toEqual(["白砚", "未登场"])
    expect(cast[1]).toEqual({
      character: "未登场",
      lastSeenChapter: 0,
      appearanceCount: 0,
      chapters: [],
    })
  })

  it("空出场章不产生 -Infinity（排序键为有限数）", () => {
    const cast = recentCast([app("orphan-b", []), app("orphan-a", []), app("白砚", [1])])
    for (const entry of cast) {
      expect(Number.isFinite(entry.lastSeenChapter)).toBe(true)
    }
    expect(cast.map((c) => c.character)).toEqual(["白砚", "orphan-a", "orphan-b"])
  })
})
