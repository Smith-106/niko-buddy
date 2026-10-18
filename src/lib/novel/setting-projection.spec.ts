/** setting-projection：零新真源只读投影（自由文本关系如实呈现 + 缺口计数）。 */
import { describe, expect, it } from "vitest"

import { projectSettingState } from "./setting-projection"
import type { CharacterState } from "./character-state"

function character(partial: Partial<CharacterState> & { characterName: string }): CharacterState {
  return {
    currentLocation: "",
    status: "",
    equipment: [],
    abilities: [],
    relationships: {},
    lastUpdatedChapter: 1,
    lastUpdatedAt: "2026-10-18T00:00:00.000Z",
    ...partial,
  }
}

describe("projectSettingState", () => {
  it("关系自由文本 → 有向边；空文本关系被丢弃", () => {
    const projection = projectSettingState({
      characters: [
        character({
          characterName: "林砚",
          currentLocation: "青石镇",
          relationships: { 苏晚: "师徒", 赵九: "   " },
          lastUpdatedChapter: 7,
        }),
      ],
    })
    expect(projection.edges).toHaveLength(1)
    expect(projection.edges[0]).toEqual({ from: "林砚", to: "苏晚", description: "师徒", lastChapter: 7 })
    expect(projection.cast[0]?.relationCount).toBe(1)
  })

  it("无关系角色的缺口单独计数（不显示 0 条关系假装完整）", () => {
    const projection = projectSettingState({
      characters: [
        character({ characterName: "A", relationships: {} }),
        character({ characterName: "B", relationships: { C: "敌对" } }),
      ],
    })
    expect(projection.cast).toHaveLength(2)
    expect(projection.charactersWithoutRelations).toBe(1)
  })

  it("isAlive 缺失 → null（不猜存活），明确 false 才表示已退场", () => {
    const projection = projectSettingState({
      characters: [
        character({ characterName: "A" }),
        character({ characterName: "B", isAlive: false }),
      ],
    })
    const byName = Object.fromEntries(projection.cast.map((row) => [row.name, row]))
    expect(byName.A?.isAlive).toBeNull()
    expect(byName.B?.isAlive).toBe(false)
  })

  it("空 store → 空投影（不造角色）", () => {
    const projection = projectSettingState({ characters: [] })
    expect(projection.cast).toEqual([])
    expect(projection.edges).toEqual([])
    expect(projection.charactersWithoutRelations).toBe(0)
  })

  it("输出稳定排序（同输入两次结果一致）", () => {
    const characters = [character({ characterName: "Z" }), character({ characterName: "A" })]
    expect(projectSettingState({ characters }).cast.map((r) => r.name)).toEqual(["A", "Z"])
  })
})
